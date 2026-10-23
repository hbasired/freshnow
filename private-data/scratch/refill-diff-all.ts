import "dotenv/config";
import postgres from "postgres";
import { FileSource, dubaiDay, refillKey, type TvRefill } from "../../packages/televend/src/index.js";

// Per day 4–13 Oct: every refill in the portal's CSV exports vs the mirror, by the shared identity (refillKey).
const sql = postgres(process.env.DATABASE_URL_SERVICE!, { onnotice: () => {} });
const files = new FileSource("data-televend");
const exportEnd = new Date("2026-10-13T07:03:38Z"); // the newest export's last row
let bad = 0;
for (let d = 4; d <= 13; d++) {
  const day = `2026-10-${String(d).padStart(2, "0")}`;
  const w = dubaiDay(day);
  const exp = await files.refills(day);
  const db = await sql<{ machine_tv_id: string | null; machine_caption: string | null; at: Date; action: TvRefill["action"]; quantity_change: string; column_no: number | null }[]>`
    select machine_tv_id::text, machine_caption, at, action, quantity_change, column_no from tv_refill where at >= ${w.from} and at < ${w.to}`;
  const dbRows = db.map((r) => ({
    at: r.at,
    key: refillKey({ machineTelevendId: r.machine_tv_id === null ? null : Number(r.machine_tv_id), machineCaption: r.machine_caption, at: r.at, action: r.action, quantityChange: Number(r.quantity_change), column: r.column_no }),
  }));
  const dbKeys = new Set(dbRows.map((r) => r.key));
  const expKeys = new Set(exp.map((r) => refillKey(r)));
  const onlyExport = [...expKeys].filter((k) => !dbKeys.has(k));
  const onlyDb = dbRows.filter((r) => !expKeys.has(r.key));
  const onlyDbCovered = onlyDb.filter((r) => r.at <= exportEnd); // a mirror row the export should also have had
  if (onlyExport.length || onlyDbCovered.length) bad++;
  console.log(
    `${day}: export ${expKeys.size}, mirror ${dbKeys.size} | only in export ${onlyExport.length} | only in mirror ${onlyDb.length}` +
      (onlyDb.length ? ` (${onlyDbCovered.length} before the export ended)` : ""),
  );
  for (const k of onlyExport) console.log("   only in export:", k);
  for (const r of onlyDbCovered) console.log("   only in mirror, inside the export's period:", r.key);
}
console.log(bad ? `${bad} day(s) differ` : "every exported refill is in the mirror, and the mirror has nothing the exports cover but lack");
await sql.end();
