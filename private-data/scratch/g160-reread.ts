import "dotenv/config";
import { closeDb, getServiceSql, syncRefillsDay } from "../../packages/core/src/index.js";
import {
  BridgeSource,
  PasswordSession,
  REFILL_FILL_TYPE,
  REFILL_SOURCE,
  TelevendClient,
  readTelevendConfig,
  refillKey,
} from "../../packages/televend/src/index.js";

// One-off correction of this machine's mirror after G160 (2026-10-15).
// 1. Rows stored with a code that had no mapping yet get their action/origin from `raw` and a new key.
const sql = getServiceSql();
const unknown = await sql<{ id: string; machine_tv_id: string | null; machine_caption: string | null; at: Date; column_no: number | null; quantity_change: string; raw: { fill_type?: number; source?: number } }[]>`
  select id, machine_tv_id::text, machine_caption, at, column_no, quantity_change, raw from tv_refill where action = 'unknown' or origin = 'unknown'`;
for (const r of unknown) {
  const action = (r.raw.fill_type !== undefined && REFILL_FILL_TYPE[r.raw.fill_type]) || "unknown";
  const origin = (r.raw.source !== undefined && REFILL_SOURCE[r.raw.source]) || "unknown";
  const key = refillKey({ machineTelevendId: r.machine_tv_id === null ? null : Number(r.machine_tv_id), machineCaption: r.machine_caption, at: r.at, action, quantityChange: Number(r.quantity_change), column: r.column_no });
  const clash = await sql`select id from tv_refill where natural_key = ${key} and id <> ${r.id}`;
  if (clash.length) { console.log(`row ${r.id}: new key already stored — left as is for a person to look at`); continue; }
  await sql`update tv_refill set action = ${action}, origin = ${origin}, natural_key = ${key} where id = ${r.id}`;
  console.log(`row ${r.id}: fill_type ${r.raw.fill_type} → ${action}, source ${r.raw.source} → ${origin}`);
}

// 2. Re-read the backfilled days asking EVERY machine record (the earlier reads asked enabled ones only).
const cfg = readTelevendConfig()!;
const s = new PasswordSession({ username: cfg.username!, password: cfg.password! }, { fetch: globalThis.fetch as never, now: Date.now });
const c = new TelevendClient(s, { tenantId: cfg.tenantId, companyId: cfg.companyId, minIntervalMs: 1000 });
const ctx = { source: new BridgeSource(c, { tenantId: cfg.tenantId, companyId: cfg.companyId }), requests: () => c.sent };
for (const day of ["2026-10-14", "2026-10-13", "2026-10-12", "2026-10-11", "2026-10-10", "2026-10-09", "2026-10-08", "2026-10-07", "2026-10-06", "2026-10-05", "2026-10-04"]) {
  const r = await syncRefillsDay(ctx, day, "backfill");
  console.log(`${day}: ${r.read} refill rows read, ${r.fresh} new, complete ${r.complete} (requests so far ${c.sent})`);
}
console.log(`done — requests: ${c.sent}, password sign-ins: ${s.passwordSignIns}`);
await closeDb();
