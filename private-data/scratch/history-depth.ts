import "dotenv/config";
import { BridgeSource, PasswordSession, TelevendClient, readTelevendConfig, dubaiDay } from "../../packages/televend/src/index.js";
const cfg = readTelevendConfig()!;
const s = new PasswordSession({ username: cfg.username!, password: cfg.password! }, { fetch: globalThis.fetch as never, now: Date.now });
const c = new TelevendClient(s, { tenantId: cfg.tenantId, companyId: cfg.companyId, minIntervalMs: 1000 });
const src = new BridgeSource(c, { tenantId: cfg.tenantId, companyId: cfg.companyId });
for (const day of ["2026-09-01", "2026-06-15", "2026-04-15", "2026-01-15", "2025-10-15"]) {
  const t = await src.vendTotals(dubaiDay(day)).catch((e) => ({ error: String(e) }));
  const h = { from: new Date(`${day}T10:00:00+04:00`), to: new Date(`${day}T10:30:00+04:00`) };
  const e = await src.events(h, { maxRows: 200 }).catch((x) => ({ error: String(x) }));
  console.log(day, "vends whole-day count:", "vends" in t ? t.vends : t, "| events 10:00-10:30:", "rows" in e ? e.rows.length : e);
}
console.log("requests:", c.sent);
