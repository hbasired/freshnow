import { parseRefillLog } from "../../packages/televend/src/index.js";
import { readFileSync, readdirSync } from "node:fs";
for (const f of readdirSync("data-televend").filter((f) => /^refill_log.*\.csv$/.test(f))) {
  const rows = parseRefillLog(readFileSync(`data-televend/${f}`));
  const t = rows.map((r) => r.at.getTime());
  console.log(f, "rows", rows.length, "| first", new Date(Math.min(...t)).toISOString(), "| last", new Date(Math.max(...t)).toISOString());
}
