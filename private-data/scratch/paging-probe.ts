import "dotenv/config";
import { HOSTS, PasswordSession, TelevendClient, readTelevendConfig } from "../../packages/televend/src/index.js";
const cfg = readTelevendConfig()!;
const s = new PasswordSession({ username: cfg.username!, password: cfg.password! }, { fetch: globalThis.fetch as never, now: Date.now });
const c = new TelevendClient(s, { tenantId: cfg.tenantId, companyId: cfg.companyId, minIntervalMs: 1000 });
const T = `tenants/${cfg.tenantId}/companies/${cfg.companyId}`;
const day = { from_timestamp: "2026-10-12T00:00:00+04:00", to_timestamp: "2026-10-13T00:00:00+04:00" };
type P = { meta: { page: number; has_next_page: boolean; number_of_items: number }; content: { vend_id: number; timestamp: string }[] };
for (const page of [1, 15, 16, 17, 31, 32, 33]) {
  const r = (await c.get(TelevendClient.url(HOSTS.cloudApi, `/machinist/api/v1/${T}/vends`, { page, page_size: 100, ...day }))) as P;
  const ts = r.content.map((x) => x.timestamp).sort();
  console.log(`page ${page}: rows ${r.content.length} has_next ${r.meta.has_next_page} items ${r.meta.number_of_items} first ${ts[0]} last ${ts.at(-1)}`);
}
console.log("requests:", c.sent);
