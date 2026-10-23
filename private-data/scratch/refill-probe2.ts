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
const m = all.find((x) => x.caption.startsWith("Metro Emirates Towers-315"));
if (!m) throw new Error("machine not found");
for (const date of ["2026-10-12T00:00:00+04:00", "2026-10-13T00:00:00+04:00", "2026-09-20T00:00:00+04:00"]) {
  const d = (await c.get(TelevendClient.url(HOSTS.cloudApi, `/refillator/api/v1/refill-log-list/${m.id}/details`, { date }))) as { content: { new_route_id: unknown; new_route_name: unknown; logs: Record<string, unknown>[] }[] };
  const logs = d.content.flatMap((x) => x.logs ?? []);
  console.log(`date=${date}: groups=${d.content.length} logs=${logs.length}`);
  for (const l of logs.slice(0, 6)) {
    const safe = Object.fromEntries(Object.entries(l).filter(([k]) => !/name|user|email|first|last|employee/i.test(k)));
    console.log("  ", JSON.stringify(safe).slice(0, 420));
  }
  if (logs[0]) console.log("   keys:", Object.keys(logs[0]).join(","));
}
console.log("requests sent:", c.sent);
