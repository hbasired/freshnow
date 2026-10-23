import "dotenv/config";
import { HOSTS, PasswordSession, TelevendClient, readTelevendConfig } from "../../packages/televend/src/index.js";
const cfg = readTelevendConfig()!;
const s = new PasswordSession({ username: cfg.username!, password: cfg.password! }, { fetch: globalThis.fetch as never, now: Date.now });
const c = new TelevendClient(s, { tenantId: cfg.tenantId, companyId: cfg.companyId, minIntervalMs: 1000 });
const T = `tenants/${cfg.tenantId}/companies/${cfg.companyId}`;
const all: { id: number; caption: string }[] = [];
for (let page = 1; page <= 5; page++) {
  const r = (await c.get(TelevendClient.url(HOSTS.cloudApi, `/machinist/api/v1/${T}/machines`, { page, page_size: 100 }))) as { meta: { has_next_page: boolean }; content: { id: number; caption: string }[] };
  all.push(...r.content);
  if (!r.meta.has_next_page) break;
}
const m = all.find((x) => x.caption.startsWith("Metro Emirates Towers-315"))!;
// CSV: 28.09.2026 08:44:35 Corrected -18 (Web app); 28.09.2026 23:14:14 / 23:14:17 Corrected -17 (Web app)
const d = (await c.get(TelevendClient.url(HOSTS.cloudApi, `/refillator/api/v1/refill-log-list/${m.id}/details`, { date: "2026-09-28T00:00:00+04:00" }))) as { content: { logs: Record<string, unknown>[] }[] };
for (const l of d.content.flatMap((x) => x.logs)) console.log("refill", l.timestamp, "fill_type", l.fill_type, "source", l.source, "change", l.quantity_change, "qty", l.quantity, "role", l.role_name);
// Events: level/type/source codes for one page of 12 Oct.
const e = (await c.get(TelevendClient.url(HOSTS.cloudApi, `/machinist/api/v1/${T}/events`, { page: 1, page_size: 100, from_timestamp: "2026-10-12T00:00:00+04:00", to_timestamp: "2026-10-13T00:00:00+04:00" }))) as { meta: Record<string, unknown>; content: Record<string, unknown>[] };
const combos = new Map<string, number>();
for (const ev of e.content) {
  const k = `level=${ev.level} type=${ev.type} source=${ev.source} desc=${String(ev.description).slice(0, 60)}`;
  combos.set(k, (combos.get(k) ?? 0) + 1);
}
console.log("events meta", JSON.stringify(e.meta), "rows", e.content.length);
for (const [k, n] of [...combos].sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(n, k);
console.log("sample start/resolved:", e.content.slice(0, 3).map((x) => [x.start_time, x.resolved_time, x.counter]));
console.log("requests:", c.sent);
