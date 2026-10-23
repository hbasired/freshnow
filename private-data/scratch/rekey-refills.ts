import "dotenv/config";
import { closeDb, getServiceSql, syncRefillsDay } from "../../packages/core/src/index.js";
import { BridgeSource, PasswordSession, TelevendClient, readTelevendConfig, refillKey } from "../../packages/televend/src/index.js";
// 1. Recompute every stored refill's identity with the fixed key (G159). One-off correction of this machine's mirror.
const sql = getServiceSql();
const rows = await sql<{ id: string; machine_tv_id: string | null; machine_caption: string | null; at: Date; action: "filled" | "corrected" | "removed" | "unknown"; quantity_change: string; column_no: number | null; natural_key: string }[]>`
  select id, machine_tv_id::text, machine_caption, at, action, quantity_change, column_no, natural_key from tv_refill`;
let changed = 0;
for (const r of rows) {
  const key = refillKey({ machineTelevendId: r.machine_tv_id === null ? null : Number(r.machine_tv_id), machineCaption: r.machine_caption, at: r.at, action: r.action, quantityChange: Number(r.quantity_change), column: r.column_no });
  if (key !== r.natural_key) { await sql`update tv_refill set natural_key = ${key} where id = ${r.id}`; changed++; }
}
console.log(`re-keyed ${changed} of ${rows.length} stored refills`);
// 2. Re-read the days processed with the old key, so refills it dropped come back.
const cfg = readTelevendConfig()!;
const s = new PasswordSession({ username: cfg.username!, password: cfg.password! }, { fetch: globalThis.fetch as never, now: Date.now });
const c = new TelevendClient(s, { tenantId: cfg.tenantId, companyId: cfg.companyId, minIntervalMs: 1000 });
const ctx = { source: new BridgeSource(c, { tenantId: cfg.tenantId, companyId: cfg.companyId }), requests: () => c.sent };
for (const day of ["2026-10-15", "2026-10-14", "2026-10-13", "2026-10-12", "2026-10-11", "2026-10-10"]) {
  const r = await syncRefillsDay(ctx, day, "backfill");
  console.log(`${day}: ${r.read} refill rows read, ${r.fresh} new`);
}
console.log("requests:", c.sent);
await closeDb();
