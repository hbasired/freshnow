import { z } from "zod";
import { AUTH_ONLY, decide } from "./allowlist.js";
import type { TelevendConfig } from "./config.js";
import { TelevendAuthError, TelevendHttpError, TelevendRefusedError } from "./errors.js";

/**
 * Getting a bearer token, for each transport, without ever risking the Televend account.
 *
 * Keycloak counts failed passwords and can lock an account. The connector therefore follows
 * three rules (plan §8, "account-safety rules for the bridge"):
 *   1. sign in with the password ONCE, then live on the refresh token;
 *   2. a refused password LATCHES the provider — no further password is sent until the
 *      process restarts with new settings (a person must look first);
 *   3. a failure that is not about the credentials (timeout, 5xx) is not a refusal and does
 *      not latch — but it is also not retried here; the caller's backoff/circuit decides.
 */

/** The subset of `fetch` the connector uses — injectable so tests never touch the network. */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

export interface TokenProvider {
  /** A token that is valid now, signing in or refreshing if needed. */
  token(): Promise<string>;
  /** Forget the current access token (the API said 401); the next `token()` refreshes. */
  invalidate(): void;
  /** True once a credential was refused — nothing will be sent until restart. */
  readonly latched: boolean;
}

const tokenResponse = z.object({
  access_token: z.string().min(10),
  expires_in: z.number().positive(),
  refresh_token: z.string().min(10).optional(),
  refresh_expires_in: z.number().nonnegative().optional(),
  token_type: z.string().optional(),
});

/** The web app's public Keycloak client (read from its environment file, 2026-10-15). */
export const WEB_APP_CLIENT_ID = "cwa-route-fe";
export const WEB_APP_TOKEN_URL = "https://auth.televendcloud.com/auth/realms/televend/protocol/openid-connect/token";

/** Renew this long before expiry, so a request never leaves with a token about to die. */
const EARLY_MS = 30_000;
const TOKEN_TIMEOUT_MS = 20_000;

interface Deps {
  fetch: FetchLike;
  now: () => number;
}

async function postForm(
  deps: Deps,
  url: string,
  form: Record<string, string>,
): Promise<{ status: number; json: unknown }> {
  const d = decide("POST", url, AUTH_ONLY);
  if (!d.allowed) throw new TelevendRefusedError("POST", safeTarget(url), d.reason);
  const res = await deps.fetch(d.url.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams(form).toString(),
    signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
  });
  let json: unknown = null;
  try {
    json = JSON.parse(await res.text());
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

/** host + path only: never a query value, never anything a caller might have put in the URL. */
export function safeTarget(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname}${u.pathname}`;
  } catch {
    return "(unparseable URL)";
  }
}

/** Keycloak's machine-readable error code ("invalid_grant"), and nothing else from the body. */
function errorCode(json: unknown): string {
  const code = (json as { error?: unknown } | null)?.error;
  return typeof code === "string" ? code.slice(0, 60) : "unknown_error";
}

/**
 * Bridge transport: the web app's own client with the account's password. Used until Televend
 * issues a read-only API client; the account should be replaced by a dedicated view-only user.
 */
export class PasswordSession implements TokenProvider {
  private access: { value: string; expiresAt: number } | null = null;
  private refresh: { value: string; expiresAt: number } | null = null;
  private refused = false;
  /** How many times the password has been sent by this process — reported by the probe. */
  passwordSignIns = 0;

  constructor(
    private readonly creds: { username: string; password: string },
    private readonly deps: Deps,
    private readonly tokenUrl: string = WEB_APP_TOKEN_URL,
    private readonly clientId: string = WEB_APP_CLIENT_ID,
  ) {}

  get latched(): boolean {
    return this.refused;
  }

  invalidate(): void {
    this.access = null;
  }

  async token(): Promise<string> {
    if (this.refused) {
      throw new TelevendAuthError(
        "Televend sign-in is stopped after a refused credential. Check TELEVEND_USERNAME/TELEVEND_PASSWORD and restart.",
      );
    }
    const now = this.deps.now();
    if (this.access && now < this.access.expiresAt - EARLY_MS) return this.access.value;

    if (this.refresh && now < this.refresh.expiresAt - EARLY_MS) {
      const r = await postForm(this.deps, this.tokenUrl, {
        grant_type: "refresh_token",
        client_id: this.clientId,
        refresh_token: this.refresh.value,
      });
      if (r.status === 200) return this.store(r.json);
      // Televend itself is failing — not a reason to spend a password attempt. The caller's
      // backoff and circuit breaker decide when to come back.
      if (r.status >= 500) throw new TelevendHttpError("POST", safeTarget(this.tokenUrl), r.status, 1);
      // A refused REFRESH token is normal: the Keycloak session ended. One password sign-in.
      this.refresh = null;
    }
    return this.signIn();
  }

  private async signIn(): Promise<string> {
    this.passwordSignIns++;
    const r = await postForm(this.deps, this.tokenUrl, {
      grant_type: "password",
      client_id: this.clientId,
      username: this.creds.username,
      password: this.creds.password,
      scope: "openid",
    });
    if (r.status === 200) return this.store(r.json);
    if (r.status === 400 || r.status === 401 || r.status === 403) {
      this.refused = true;
      this.access = null;
      this.refresh = null;
      throw new TelevendAuthError(`Televend refused the sign-in (${errorCode(r.json)}); no further attempts will be made`, r.status);
    }
    throw new TelevendHttpError("POST", safeTarget(this.tokenUrl), r.status, 1);
  }

  private store(json: unknown): string {
    const parsed = tokenResponse.safeParse(json);
    if (!parsed.success) throw new TelevendAuthError("Televend token response had an unexpected shape");
    const now = this.deps.now();
    const t = parsed.data;
    this.access = { value: t.access_token, expiresAt: now + t.expires_in * 1000 };
    this.refresh =
      t.refresh_token && t.refresh_expires_in
        ? { value: t.refresh_token, expiresAt: now + t.refresh_expires_in * 1000 }
        : null;
    return t.access_token;
  }
}

/** Official API: OAuth2 client credentials issued by Televend IT. No refresh token exists. */
export class ClientCredentials implements TokenProvider {
  private access: { value: string; expiresAt: number } | null = null;
  private refused = false;

  constructor(
    private readonly creds: { clientId: string; clientSecret: string },
    private readonly tokenUrl: string,
    private readonly deps: Deps,
  ) {}

  get latched(): boolean {
    return this.refused;
  }

  invalidate(): void {
    this.access = null;
  }

  async token(): Promise<string> {
    if (this.refused) throw new TelevendAuthError("Televend API client was refused; check TELEVEND_CLIENT_ID/SECRET and restart.");
    const now = this.deps.now();
    // The portal recommends renewing at ~80 % of the lifetime; EARLY_MS on a 2 h token is
    // well inside that, and the 80 % rule is applied in store().
    if (this.access && now < this.access.expiresAt) return this.access.value;
    const r = await postForm(this.deps, this.tokenUrl, {
      grant_type: "client_credentials",
      client_id: this.creds.clientId,
      client_secret: this.creds.clientSecret,
    });
    if (r.status === 200) {
      const parsed = tokenResponse.safeParse(r.json);
      if (!parsed.success) throw new TelevendAuthError("Televend token response had an unexpected shape");
      this.access = { value: parsed.data.access_token, expiresAt: now + parsed.data.expires_in * 1000 * 0.8 };
      return parsed.data.access_token;
    }
    if (r.status === 400 || r.status === 401 || r.status === 403) {
      this.refused = true;
      throw new TelevendAuthError(`Televend refused the API client (${errorCode(r.json)}); no further attempts will be made`, r.status);
    }
    throw new TelevendHttpError("POST", safeTarget(this.tokenUrl), r.status, 1);
  }
}

export function tokenProviderFor(config: TelevendConfig, deps: Deps): TokenProvider | null {
  if (config.mode === "bridge" && config.username && config.password) {
    return new PasswordSession({ username: config.username, password: config.password }, deps);
  }
  if (config.mode === "official" && config.clientId && config.clientSecret) {
    return new ClientCredentials({ clientId: config.clientId, clientSecret: config.clientSecret }, config.officialTokenUrl, deps);
  }
  return null;
}
