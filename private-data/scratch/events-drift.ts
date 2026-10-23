import "dotenv/config";
import { BridgeSource, PasswordSession, TelevendClient, readTelevendConfig } from "../../packages/televend/src/index.js";
const cfg = readTelevendConfig()!;
const s = new PasswordSession({ username: cfg.username!, password: cfg.password! }, { fetch: globalThis.fetch as never, now: Date.now });
const c = new TelevendClient(s, { tenantId: cfg.tenantId, companyId: cfg.companyId, minIntervalMs: 1000 });
const src = new BridgeSource(c, { tenantId: cfg.tenantId, companyId: cfg.companyId });
const from = new Date("2026-10-15T06:00:00+04:00"), to = new Date("2026-10-15T09:00:00+04:00");
const ids = async () => new Set((await src.events({ from, to }, { maxRows: 20000 })).rows.map((e) => e.televendId));
const a = await ids();
const b = await ids();
const onlyA = [...a].filter((x) => !b.has(x)), onlyB = [...b].filter((x) => !a.has(x));
console.log(`3-hour window, paged twice: run1 ${a.size}, run2 ${b.size}, only in run1 ${onlyA.length}, only in run2 ${onlyB.length}`);
// Same window read as 15-minute slices (each fits one page).
const sliced = new Set<number | null>();
let maxPerSlice = 0;
for (let t = from.getTime(); t < to.getTime(); t += 15 * 60000) {
  const r = await src.events({ from: new Date(t), to: new Date(t + 15 * 60000) }, { maxRows: 5000 });
  maxPerSlice = Math.max(maxPerSlice, r.rows.length);
  r.rows.forEach((e) => sliced.add(e.televendId));
}
const missingFromPaged = [...sliced].filter((x) => !a.has(x as number) || !b.has(x as number)).length;
console.log(`15-minute slices: ${sliced.size} distinct events, largest slice ${maxPerSlice}, in slices but missing from a paged run: ${missingFromPaged}`);
console.log("requests:", c.sent);
