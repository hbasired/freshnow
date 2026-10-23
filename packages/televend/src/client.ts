import type { ZodType, ZodTypeDef } from "zod";
import { READ_ONLY, decide, type Rule, type RuleKind } from "./allowlist.js";
import { safeTarget, type FetchLike, type TokenProvider } from "./auth.js";
import {
  TelevendAuthError,
  TelevendCircuitOpenError,
  TelevendHttpError,
  TelevendRefusedError,
  TelevendSchemaError,
} from "./errors.js";

/**
 * The one door to Televend. Every request — from the MCP server, the sync job or a probe —
 * goes through `get()` (reads) or `commitOffsets()` (the official stream's only write), and
 * both run `decide()` from the allow-list BEFORE the network is touched.
 *
 * Bounded everywhere (CLAUDE.md rule 4): a per-request timeout, at most `maxAttempts` tries
 * with exponential backoff on 429/5xx/network errors, a minimum gap between requests (the
 * developer portal asks for ≤ 1 request/second), and a circuit breaker that stops calling
 * Televend for a cool-down after repeated failures instead of hammering it.
 */

export interface CallRecord {
  readonly ruleId: string;
  readonly method: "GET" | "POST";
  /** Full URL incl. query (dates, page numbers — never a credential; auth is in headers). */
  readonly url: string;
  readonly status: number;
  readonly ms: number;
  readonly bytes: number;
  readonly attempt: number;
  readonly at: Date;
  /** Parsed JSON body, so the pipeline can keep the raw page for replay. */
  readonly body: unknown;
}

export interface ClientOptions {
  tenantId: number;
  companyId: number;
  fetch?: FetchLike;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  minIntervalMs?: number;
  timeoutMs?: number;
  maxAttempts?: number;
  /** Consecutive failed calls that open the circuit, and how long it stays open. */
  circuitThreshold?: number;
  circuitCooldownMs?: number;
  /** Official API only: allow the Data-Streaming offset commit. */
  commitOffsets?: boolean;
  /** Called after every completed HTTP exchange (also failed ones) — raw capture, metrics. */
  onCall?: (call: CallRecord) => void;
}

const RETRYABLE = new Set([429, 502, 503, 504]);
const MAX_BACKOFF_MS = 30_000;

export interface CircuitState {
  readonly open: boolean;
  readonly consecutiveFailures: number;
  readonly reopensAt: Date | null;
}

export class TelevendClient {
  private readonly fetchFn: FetchLike;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly minIntervalMs: number;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly circuitThreshold: number;
  private readonly circuitCooldownMs: number;
  private nextSlot = 0;
  private failures = 0;
  private openUntil = 0;
  /** Number of requests actually handed to `fetch` (tests and the probe report it). */
  sent = 0;

  constructor(
    private readonly auth: TokenProvider,
    private readonly opts: ClientOptions,
  ) {
    this.fetchFn = opts.fetch ?? (globalThis.fetch as unknown as FetchLike);
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((res) => setTimeout(res, ms)));
    this.minIntervalMs = opts.minIntervalMs ?? 1_000;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.maxAttempts = Math.max(1, Math.min(opts.maxAttempts ?? 3, 5));
    this.circuitThreshold = opts.circuitThreshold ?? 5;
    this.circuitCooldownMs = opts.circuitCooldownMs ?? 15 * 60_000;
  }

  get circuit(): CircuitState {
    const open = this.now() < this.openUntil;
    return { open, consecutiveFailures: this.failures, reopensAt: open ? new Date(this.openUntil) : null };
  }

  /** A read. `url` must be absolute; `schema` (if given) validates the parsed JSON. */
  async get<T = unknown>(url: string, schema?: ZodType<T, ZodTypeDef, unknown>): Promise<T> {
    const body = await this.send("GET", url, READ_ONLY);
    if (!schema) return body as T;
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .slice(0, 5)
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ");
      throw new TelevendSchemaError(safeTarget(url), issues);
    }
    return parsed.data;
  }

  /**
   * Official Data-Streaming offset commit — the one non-read this connector may send. Per the
   * spec (devportal vends.yaml 1.9.0) it has no body: "commit offsets for all partitions that
   * have been fetched so far", answering 204. It moves our read position; no business data.
   */
  async commitOffsets(url: string): Promise<void> {
    if (!this.opts.commitOffsets) {
      throw new TelevendRefusedError("POST", safeTarget(url), "offset commit is disabled (TELEVEND_COMMIT_OFFSETS=false)");
    }
    await this.send("POST", url, new Set<RuleKind>(["offset-commit"]));
  }

  private headersFor(rule: Rule, token: string): Record<string, string> {
    const h: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: "application/json" };
    if (rule.headers === "tenant" || rule.headers === "warden") {
      h["x-tenant-id"] = String(this.opts.tenantId);
      h["company-id"] = String(this.opts.companyId);
    }
    // The web app's access-control service reads the token from its own header as well.
    if (rule.headers === "warden") h["keycloak-access-token"] = token;
    return h;
  }

  private async pace(): Promise<void> {
    const now = this.now();
    const wait = this.nextSlot - now;
    this.nextSlot = Math.max(now, this.nextSlot) + this.minIntervalMs;
    if (wait > 0) await this.sleep(wait);
  }

  private fail(): void {
    this.failures++;
    if (this.failures >= this.circuitThreshold) this.openUntil = this.now() + this.circuitCooldownMs;
  }

  private async send(
    method: "GET" | "POST",
    url: string,
    kinds: ReadonlySet<RuleKind>,
    body?: string,
  ): Promise<unknown> {
    const d = decide(method, url, kinds);
    if (!d.allowed) throw new TelevendRefusedError(method, safeTarget(url), d.reason);
    if (this.now() < this.openUntil) throw new TelevendCircuitOpenError(new Date(this.openUntil));

    const target = safeTarget(url);
    let refreshedAfter401 = false;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      await this.pace();
      // Outside the try: a refused credential must stop everything, never be retried here.
      const token = await this.auth.token();
      const headers = this.headersFor(d.rule, token);
      if (body !== undefined) headers["Content-Type"] = "application/json";
      const started = this.now();

      let status: number;
      let text: string;
      let retryAfterHeader: string | null;
      try {
        this.sent++;
        const res = await this.fetchFn(d.url.toString(), {
          method,
          headers,
          ...(body !== undefined && { body }),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        status = res.status;
        retryAfterHeader = res.headers.get("retry-after");
        text = await res.text();
      } catch {
        // Network error or timeout — retried with backoff, bounded by maxAttempts.
        if (attempt < this.maxAttempts) {
          await this.sleep(Math.min(1000 * 2 ** (attempt - 1), MAX_BACKOFF_MS));
          continue;
        }
        this.fail();
        throw new TelevendHttpError(method, target, 0, attempt);
      }

      let json: unknown = null;
      if (text.length > 0) {
        try {
          json = JSON.parse(text);
        } catch {
          json = null;
        }
      }
      // Every completed exchange is reported — retried and failed ones too — so the raw
      // capture and the run trace show exactly what Televend answered.
      this.opts.onCall?.({
        ruleId: d.rule.id,
        method,
        url: d.url.toString(),
        status,
        ms: this.now() - started,
        bytes: text.length,
        attempt,
        at: new Date(started),
        body: json,
      });

      if (status >= 200 && status < 300) {
        this.failures = 0;
        return json;
      }
      if (status === 401 && !refreshedAfter401) {
        // The token can expire between our check and the server's. One fresh token, and a
        // token refresh does not count as a failed attempt.
        refreshedAfter401 = true;
        this.auth.invalidate();
        attempt--;
        continue;
      }
      if (status === 401) {
        this.fail();
        throw new TelevendAuthError(`Televend rejected a fresh token for ${target}`, 401);
      }
      if (RETRYABLE.has(status) && attempt < this.maxAttempts) {
        const retryAfter = Number(retryAfterHeader);
        const backoff = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** (attempt - 1);
        await this.sleep(Math.min(backoff, MAX_BACKOFF_MS));
        continue;
      }
      this.fail();
      throw new TelevendHttpError(method, target, status, attempt);
    }
    // Unreachable: every path through the loop returns, continues or throws.
    throw new TelevendHttpError(method, target, 0, this.maxAttempts);
  }

  /** Absolute URL for a path on one of Televend's hosts, with query parameters encoded. */
  static url(host: string, path: string, query?: Record<string, string | number | boolean | readonly (string | number)[] | undefined>): string {
    const u = new URL(`https://${host}${path}`);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v === undefined) continue;
      if (Array.isArray(v)) for (const item of v) u.searchParams.append(k, String(item));
      else u.searchParams.set(k, String(v));
    }
    return u.toString();
  }
}
