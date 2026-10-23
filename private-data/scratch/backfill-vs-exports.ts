import "dotenv/config";
import postgres from "postgres";
import { FileSource, assetNumber, dubaiDay } from "../../packages/televend/src/index.js";
const sql = postgres(process.env.DATABASE_URL_SERVICE!, { onnotice: () => {} });
const files = new FileSource("data-televend");
const rows: Record<string, unknown>[] = [];
for (let d = 4; d <= 13; d++) {
  const day = `2026-10-${String(d).padStart(2, "0")}`;
  const w = dubaiDay(day);
  // Refills: per machine number, rows and cups.
  const dbRef = await sql<{ machine_caption: string; quantity_change: string }[]>`select machine_caption, quantity_change from tv_refill where at >= ${w.from} and at < ${w.to}`;
  const fileRef = await files.refills(day);
  const key = (caption: string | null) => String(assetNumber(caption) ?? caption);
  const tally = (xs: { c: string | null; q: number }[]) => { const m = new Map<string, [number, number]>(); for (const x of xs) { const t = m.get(key(x.c)) ?? [0, 0]; t[0]++; t[1] += x.q; m.set(key(x.c), t); } return m; };
  const a = tally(dbRef.map((r) => ({ c: r.machine_caption, q: Number(r.quantity_change) })));
  const b = tally(fileRef.map((r) => ({ c: r.machineCaption, q: r.quantityChange })));
  const refMismatch = [...new Set([...a.keys(), ...b.keys()])].filter((k) => JSON.stringify(a.get(k) ?? [0, 0]) !== JSON.stringify(b.get(k) ?? [0, 0])).length;
  // Alarms: export rows (alarm/warning exports covering the day) matched to stored events by machine number + minute.
  const fileEv = (await files.events(w)).rows;
  const dbEv = await sql<{ caption: string; started_at: Date; level: number }[]>`
    select coalesce(m.caption, '') caption, e.started_at, e.level from tv_event e left join tv_machine m on m.televend_id = e.machine_tv_id
    where e.started_at >= ${w.from} and e.started_at < ${w.to} and e.kind in ('alarm', 'warning')`;
  const evKeys = new Set(dbEv.map((e) => `${key(e.caption)}|${Math.floor(e.started_at.getTime() / 60000)}`));
  const evMatched = fileEv.filter((f) => evKeys.has(`${key(f.machineCaption)}|${Math.floor(f.startedAt.getTime() / 60000)}`)).length;
  const run = (await sql<{ complete: boolean; televend_count: number | null; rows_read: number }[]>`
    select complete, televend_count, rows_read from tv_sync_run where stream = 'vends' and mode = 'backfill' and window_from = ${w.from} and window_to = ${w.to} order by started_at desc limit 1`)[0];
  rows.push({ day, refillsDb: dbRef.length, refillsExport: fileRef.length, refillMachineMismatches: refMismatch, alarmRowsInExports: fileEv.length, matchedInDb: evMatched, vendsComplete: run?.complete ?? null, vendsVsTelevend: run ? `${run.rows_read}/${run.televend_count}` : null });
}
console.table(rows);
await sql.end();
