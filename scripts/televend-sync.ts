/**
 * Televend sync from the command line (TASK-056).
 *
 *   pnpm televend:sync                                  one incremental run (what the worker does every 10 min)
 *   pnpm televend:backfill --from 2026-09-01 --to 2026-10-14 [--streams vends,events,refills] [--max-requests 3000]
 *   pnpm televend:day-totals --from 2025-10-01 --to 2026-03-31 [--max-requests 400]
 *                                                       Televend's own count of the fleet's sales per day (TASK-071) — for the
 *                                                       months its sales list no longer holds; one read per day
 *
 * Read-only towards Televend (allow-listed GETs + one sign-in, paced at 1 request/second); writes
 * only our mirror tables. Backfill goes newest day first, skips days already complete, and stops
 * at its request budget — run it again to continue.
 */
import "dotenv/config";
import { backfillDayTotals, backfillDays, closeDb, describeDayCheck, runIncrementalSync } from "../packages/core/src/index.js";
import { BridgeSource, PasswordSession, TelevendClient, readTelevendConfig } from "../packages/televend/src/index.js";

const args = process.argv.slice(2);
const opt = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const cfg = readTelevendConfig();
if (!cfg || cfg.mode !== "bridge" || !cfg.username || !cfg.password) {
  throw new Error("set TELEVEND_MODE=bridge and TELEVEND_USERNAME/TELEVEND_PASSWORD in .env");
}
const session = new PasswordSession({ username: cfg.username, password: cfg.password }, { fetch: globalThis.fetch as never, now: Date.now });
const client = new TelevendClient(session, { tenantId: cfg.tenantId, companyId: cfg.companyId, minIntervalMs: Math.max(1_000, cfg.minIntervalMs) });
const source = new BridgeSource(client, { tenantId: cfg.tenantId, companyId: cfg.companyId });
const ctx = { source, requests: () => client.sent };

try {
  if (args[0] === "day-totals") {
    const from = opt("--from");
    const to = opt("--to");
    if (!from || !to) throw new Error("day-totals needs --from YYYY-MM-DD --to YYYY-MM-DD");
    const maxRequests = Number(opt("--max-requests") ?? 400);
    const r = await backfillDayTotals(source, { from, to, maxRequests, onDay: (line: string) => console.log(line) });
    console.log(r.stoppedAt ? `stopped at ${r.stoppedAt} (request budget) — run again to continue` : `done: ${r.days} day(s) read`);
  } else if (args[0] === "backfill") {
    const from = opt("--from");
    const to = opt("--to");
    if (!from || !to) throw new Error("backfill needs --from YYYY-MM-DD --to YYYY-MM-DD");
    const streams = (opt("--streams") ?? "vends,events,refills").split(",").map((s) => s.trim()) as ("vends" | "events" | "refills")[];
    const maxRequests = Number(opt("--max-requests") ?? 3_000);
    const r = await backfillDays(ctx, { from, to, streams, maxRequests, onDay: (line: string) => console.log(line) });
    console.log(r.stoppedAt ? `stopped at ${r.stoppedAt} (request budget) — run again to continue` : `done: ${r.days} day(s) read`);
  } else {
    const r = await runIncrementalSync(ctx);
    console.log(
      JSON.stringify(
        {
          machines: r.machines,
          vends: { window: r.vends.window, read: r.vends.read, new: r.vends.fresh, complete: r.vends.complete },
          events: { read: r.events.read, new: r.events.fresh, updated: r.events.changed, complete: r.events.complete },
          refills: r.refills && { read: r.refills.read, new: r.refills.fresh },
          dailyCheck: r.dailyCheck && { day: r.dailyCheck.day, streams: describeDayCheck(r.dailyCheck) },
        },
        null,
        2,
      ),
    );
  }
  console.log(`requests sent: ${client.sent} (password sign-ins: ${session.passwordSignIns})`);
} finally {
  await closeDb();
}
