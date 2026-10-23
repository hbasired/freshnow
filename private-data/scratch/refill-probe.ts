import "dotenv/config";
import { HOSTS, PasswordSession, TelevendClient, readTelevendConfig } from "../../packages/televend/src/index.js";
const cfg = readTelevendConfig()!;
const s = new PasswordSession({ username: cfg.username!, password: cfg.password! }, { fetch: globalThis.fetch as never, now: Date.now });
const c = new TelevendClient(s, { tenantId: cfg.tenantId, companyId: cfg.companyId, minIntervalMs: 1000 });
const T = `tenants/${cfg.tenantId}/companies/${cfg.companyId}`;
const all: { id: number; caption: string; enabled: boolean }[] = [];
for (let page = 1; page <= 5; page++) {
  const r = (await c.get(TelevendClient.url(HOSTS.cloudApi, `/machinist/api/v1/${T}/machines`, { page, page_size: 100 }))) as {
    meta: { has_next_page: boolean; number_of_items: number };
    content: { id: number; caption: string; enabled: boolean }[];
  };
  all.push(...r.content.map((m) => ({ id: m.id, caption: m.caption, enabled: m.enabled })));
  console.log(`page ${page}: ${r.content.length} machines, total ${r.meta.number_of_items}, next ${r.meta.has_next_page}`);
  if (!r.meta.has_next_page) break;
}
console.log("enabled:", all.filter((m) => m.enabled).length, "of", all.length);
const target = all.find((m) => m.caption.startsWith("Metro Emirates Towers-315"));
console.log("target found:", Boolean(target));
if (target) {
  for (const path of ["details", "statistic"]) {
    const r = await c.get(TelevendClient.url(HOSTS.cloudApi, `/refillator/api/v1/refill-log-list/${target.id}/${path}`, { date: "2026-10-12T00:00:00+04:00" }));
    const content = (r as { content: unknown }).content;
    console.log(path, "->", Array.isArray(content) ? `${content.length} rows; keys: ${content[0] ? Object.keys(content[0] as object).join(",") : "-"}` : JSON.stringify(content).slice(0, 400));
  }
}
console.log("requests sent:", c.sent, "sign-ins:", s.passwordSignIns);
