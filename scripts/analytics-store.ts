/**
 * The analytics store from the command line (TASK-071).
 *
 *   pnpm analytics:store                                   build every checked day not built yet (what the worker does hourly)
 *   pnpm analytics:store --from 2026-03-21 --to 2026-10-19 [--limit 400]
 *                                                          the same, within a range — e.g. after a backfill
 *
 * Reads the Televend mirror and writes only the store (sales_day, sales_hour, analytics_run). A day is built only when the
 * sync read it to its end and it equalled Televend's own count; a day already built from the same sales is skipped, so running
 * it twice changes nothing. Televend is not contacted.
 */
import "dotenv/config";
import { closeDb, runAnalyticsStore } from "../packages/core/src/index.js";

const args = process.argv.slice(2);
const opt = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

try {
  const from = opt("--from");
  const to = opt("--to");
  const limit = Number(opt("--limit") ?? 400);
  const r = await runAnalyticsStore({ limit, ...(from ? { from } : {}), ...(to ? { to } : {}) });
  for (const b of r.built) {
    console.log(`${b.day}: ${b.cups} cups on ${b.machines} machine records${b.agrees === false ? ` — DIFFERS from Televend's ${b.televendCount}` : ""}`);
  }
  for (const f of r.failed) console.log(`${f.day}: FAILED — ${f.error}`);
  console.log(`built ${r.built.length} day(s), ${r.failed.length} failed`);
} finally {
  await closeDb();
}
