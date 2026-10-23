import "dotenv/config";
import postgres from "postgres";
import { parseRefillLog, assetNumber, dubaiDay } from "../../packages/televend/src/index.js";
import { readFileSync } from "node:fs";
const sql = postgres(process.env.DATABASE_URL_SERVICE!, { onnotice: () => {} });
// Raw CSV rows (no de-duplication at all), from the largest export.
const csv = parseRefillLog(readFileSync("data-televend/refill_log (2).csv"));
const sec = (d: Date) => new Date(Math.floor(d.getTime() / 1000) * 1000).toISOString();
for (const day of ["2026-10-04", "2026-10-06", "2026-10-11"]) {
  const w = dubaiDay(day);
  const db = await sql<{ machine_caption: string; at: Date; action: string; quantity_change: string; column_no: number | null; origin: string }[]>`
    select machine_caption, at, action, quantity_change, column_no, origin from tv_refill where at >= ${w.from} and at < ${w.to}`;
  const k = (m: string | null, at: Date, action: string, q: number, col: number | null) => `${assetNumber(m) ?? m}|${sec(at)}|${col}|${action}|${q}`;
  const dbKeys = new Map(db.map((r) => [k(r.machine_caption, r.at, r.action, Number(r.quantity_change), r.column_no), r] as const));
  const fileRows = csv.filter((r) => r.at >= w.from && r.at < w.to);
  const fileKeys = new Map(fileRows.map((r) => [k(r.machineCaption, r.at, r.action, r.quantityChange, r.column), r] as const));
  console.log(`== ${day}: db ${db.length}, csv rows ${fileRows.length}, distinct csv keys ${fileKeys.size}`);
  for (const [key, r] of fileKeys) if (!dbKeys.has(key)) console.log("  only in export:", key, "| origin", r.origin, "| by", r.filledBy ? "(name)" : "-", "| role", r.role);
  for (const [key, r] of dbKeys) if (!fileKeys.has(key)) console.log("  only in db:    ", key, "| origin", r.origin);
}
await sql.end();
