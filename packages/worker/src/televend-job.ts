import { randomUUID } from "node:crypto";
import { TelevendSyncError, getServiceSql, runIncrementalSync, syncMachineAlarms, type SyncResult } from "@freshnow/core";
import {
  BridgeSource,
  PasswordSession,
  TelevendClient,
  readTelevendConfig,
  type TelevendConfig,
} from "@freshnow/televend";

/**
 * The scheduled Televend sync (TASK-056): every TELEVEND_SYNC_MINUTES (default 10), one
 * incremental run — machines, vends and events since the cursor, refills of machines that were
 * refilled, and once a day a complete re-read of yesterday.
 *
 * One Televend session per worker process, kept between runs: the sync lives on the refresh
 * token (a 10-minute schedule keeps Keycloak's 15-minute refresh window alive) and signs in with
 * the password only when the session has ended — never after a refusal (D181).
 */

let connection: { client: TelevendClient; session: PasswordSession; source: BridgeSource } | null = null;

export function televendSyncMinutes(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.TELEVEND_SYNC_MINUTES ?? 10);
  return Number.isFinite(n) && n >= 2 && n <= 120 ? n : 10;
}

/** Bridge only for now: the official transport is a stream consumer, wired when credentials exist. */
export function televendSyncConfig(env: NodeJS.ProcessEnv = process.env): TelevendConfig | null {
  const cfg = readTelevendConfig(env);
  return cfg && cfg.mode === "bridge" ? cfg : null;
}

function connect(cfg: TelevendConfig) {
  if (connection) return connection;
  if (!cfg.username || !cfg.password) throw new Error("bridge mode needs TELEVEND_USERNAME and TELEVEND_PASSWORD");
  const session = new PasswordSession({ username: cfg.username, password: cfg.password }, { fetch: globalThis.fetch as never, now: Date.now });
  const client = new TelevendClient(session, {
    tenantId: cfg.tenantId,
    companyId: cfg.companyId,
    minIntervalMs: Math.max(1_000, cfg.minIntervalMs),
  });
  connection = { client, session, source: new BridgeSource(client, { tenantId: cfg.tenantId, companyId: cfg.companyId }) };
  return connection;
}

export async function runTelevendSyncJob(): Promise<SyncResult | null> {
  const cfg = televendSyncConfig();
  if (!cfg) return null;
  const c = connect(cfg);
  const started = new Date();
  const before = c.client.sent;
  let failure: string | null = null;
  try {
    const correlationId = randomUUID();
    let result: SyncResult | null = null;
    let syncError: unknown = null;
    try {
      result = await runIncrementalSync({ source: c.source, requests: () => c.client.sent, correlationId });
    } catch (err) {
      syncError = err;
    }
    // Fresh alarms in hand: the ones past their on-delay become problems (TASK-059, OPS_ALARM_PROBLEMS).
    // Whenever the events were read — another stream failing (one machine's refill log, say) must not
    // stop the alarms (review 2026-10-17, command-centre#4). Its own try: a failure here never marks the
    // Televend read itself as failed.
    const eventsRead = result !== null || (syncError instanceof TelevendSyncError && !syncError.failures.some((f) => f.startsWith("events:")));
    if (eventsRead) {
      try {
        const a = await syncMachineAlarms({ correlationId });
        if (a.enabled && a.raised + a.joined + a.resolved + a.unrouted > 0) {
          console.log(`[worker] machine alarms: ${a.raised} new problem(s), ${a.joined} joined, ${a.resolved} cleared in Televend, ${a.unrouted} not routed yet`);
        }
      } catch (err) {
        console.error("[worker] machine alarm sync failed", err);
      }
    }
    if (syncError) throw syncError;
    return result;
  } catch (err) {
    failure = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    throw err;
  } finally {
    const sql = getServiceSql();
    await sql`insert into job_run (job_name, status, detail, started_at, finished_at)
              values ('televend_sync', ${failure ? "error" : "ok"},
                      ${sql.json({ requests: c.client.sent - before, signInStopped: c.session.latched, circuit: c.client.circuit, ...(failure ? { error: failure.slice(0, 300) } : {}) } as never)},
                      ${started}, now())`.catch(() => {});
    await sql`delete from job_run where job_name = 'televend_sync' and created_at < now() - interval '3 days'`.catch(() => {});
  }
}
