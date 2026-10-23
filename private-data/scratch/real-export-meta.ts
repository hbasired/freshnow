import { readFileSync, readdirSync } from "node:fs";
import { parseEventList } from "../../packages/televend/src/sources/files.js";
for (const f of readdirSync("data-televend").filter((n) => n.startsWith("event_list"))) {
  const p = parseEventList(readFileSync(`data-televend/${f}`));
  console.log(f, "| period:", p.period, "| type:", p.type, "| rows:", p.rows.length);
}
