import "dotenv/config";
import postgres from "postgres";
import { parseRefillLog, dubaiDay } from "../../packages/televend/src/index.js";
import { readFileSync } from "node:fs";
const sql = postgres(process.env.DATABASE_URL_SERVICE!, { onnotice: () => {} });
const csv = parseRefillLog(readFileSync("data-televend/refill_log (2).csv"));
const caps = await sql<{ televend_id: string; caption: string; enabled: boolean; installed: string | null; disabled_at: string | null }[]>`
  select m.televend_id, c.caption, m.enabled, m.raw->>'installation_date' installed, m.raw->>'last_disabled' disabled_at
  from tv_machine_caption c join tv_machine m using (televend_id) where c.caption ilike '%393%'`;
for (const c of caps) console.log("record", c.televend_id, "| enabled", c.enabled, "| caption", JSON.stringify(c.caption));
for (const day of ["2026-10-04", "2026-10-06"]) {
  const w = dubaiDay(day);
  for (const r of csv.filter((r) => r.at >= w.from && r.at < w.to && /393/.test(r.machineCaption ?? ""))) {
    const match = caps.filter((c) => c.caption.trim() === (r.machineCaption ?? "").trim()).map((c) => `${c.televend_id}${c.enabled ? " (enabled)" : " (disabled)"}`);
    console.log(day, r.at.toISOString(), "| export caption", JSON.stringify(r.machineCaption), "| col", r.column, "|", r.action, r.quantityChange, "| matches record", match.join(", ") || "none");
  }
}
const keys = Object.keys((await sql`select raw from tv_machine where televend_id = '506389'`)[0].raw).sort();
console.log("tv_machine raw keys:", keys.join(", "));
await sql.end();
