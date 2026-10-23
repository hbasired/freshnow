import "dotenv/config";
import postgres from "postgres";
import { parseRefillLog, assetNumber } from "../../packages/televend/src/index.js";
import { readFileSync } from "node:fs";
const sql = postgres(process.env.DATABASE_URL_SERVICE!, { onnotice: () => {} });
const rows = await sql`select machine_caption, at, column_no, quantity_change, raw - 'first_name' - 'last_name' as raw from tv_refill where action = 'unknown'`;
for (const r of rows) console.log(r.machine_caption, r.at.toISOString(), "col", r.column_no, "qty", r.quantity_change, JSON.stringify(r.raw));
const csv = parseRefillLog(readFileSync("data-televend/refill_log (2).csv"));
for (const r of csv.filter((r) => r.action === "removed" || (r.action === "corrected" && r.origin === "mobile_app")))
  console.log("export:", r.action, r.origin, "| asset", assetNumber(r.machineCaption), "|", r.at.toISOString(), "| col", r.column, "| qty", r.quantityChange, "| after", r.quantityAfter);
await sql.end();
