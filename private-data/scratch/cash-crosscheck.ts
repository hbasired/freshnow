import "dotenv/config";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { BridgeSource, PasswordSession, TelevendClient, readTelevendConfig, assetNumber, CASH_COLLECTED_DESCRIPTION } from "../../packages/televend/src/index.js";

// 1. WhatsApp: "[10/14/26, 3:41:39 PM] +971…: <image omitted> Marina tower 693\n30 dhs\nDavid"
const chat = readFileSync("CASH COLLECTION DAILY VENDING/chat.txt", "utf-8");
const msgs = chat.split(/\n(?=\[\d{1,2}\/\d{1,2}\/\d{2}, )/);
type Post = { at: Date; asset: number | null; amount: number | null; who: string | null; text: string };
const posts: Post[] = [];
for (const m of msgs) {
  const h = /^\[(\d{1,2})\/(\d{1,2})\/(\d{2}), (\d{1,2}):(\d{2}):(\d{2}) (AM|PM)\] [^:]+: (<image omitted>|<album message>)?\s*([\s\S]*)$/.exec(m.trim());
  if (!h || h[8] !== "<image omitted>") continue;
  const body = (h[9] ?? "").trim();
  if (!body || /^\d{1,2}\s*[-/]\s*\d{1,2}/.test(body)) continue; // summary lists / dates
  let hh = Number(h[4]) % 12; if (h[7] === "PM") hh += 12;
  const at = new Date(`20${h[3]}-${h[1]!.padStart(2, "0")}-${h[2]!.padStart(2, "0")}T${String(hh).padStart(2, "0")}:${h[5]}:${h[6]}+04:00`);
  const asset = (() => { const x = /(?:^|\D)(\d{3,4})(?!\d)/.exec(body); return x ? Number(x[1]) : null; })();
  // Order matters: "Expo798 aed 0" must read 0, not 798; "Naif 318 AED 180" must read 180.
  const amt = (() => {
    const x = /AED\s*(\d+)/i.exec(body) ?? /(?:^|\s)(\d+)\s*(?:dhs|AED)\b/i.exec(body) ?? /\n(\d{1,4})\s*(?:\n|$)/.exec(body);
    return x ? Number(x[1]) : null;
  })();
  const who = (/(David|NEWTON|Newton|Kiran|Kamran|Yakup)/.exec(body) ?? [])[1] ?? null;
  posts.push({ at, asset, amount: amt, who, text: body.replace(/\s+/g, " ").slice(0, 60) });
}

// 2. Televend: machine events "Cash has been collected from the machine." on 14 and 15 Oct.
const cfg = readTelevendConfig()!;
const s = new PasswordSession({ username: cfg.username!, password: cfg.password! }, { fetch: globalThis.fetch as never, now: Date.now });
const c = new TelevendClient(s, { tenantId: cfg.tenantId, companyId: cfg.companyId, minIntervalMs: 1000 });
const src = new BridgeSource(c, { tenantId: cfg.tenantId, companyId: cfg.companyId });
const range = { from: new Date("2026-10-14T12:00:00+04:00"), to: new Date("2026-10-15T11:00:00+04:00") };
const ev = await src.events(range, { maxRows: 20000 });
const tv = ev.rows.filter((e) => (e.description ?? "").trim() === CASH_COLLECTED_DESCRIPTION).map((e) => ({ at: e.startedAt, asset: assetNumber(e.machineCaption), machine: e.machineCaption }));

// 3. Match by asset number within ±90 minutes.
const WINDOW = 90 * 60_000;
const used = new Set<number>();
const rows = posts.map((p) => {
  const i = tv.findIndex((t, k) => !used.has(k) && t.asset === p.asset && Math.abs(t.at.getTime() - p.at.getTime()) <= WINDOW);
  if (i >= 0) used.add(i);
  const t = i >= 0 ? tv[i] : undefined;
  return { post: p, televend: t, minutesApart: t ? Math.round((p.at.getTime() - t.at.getTime()) / 60000) : null };
});
const unreported = tv.filter((_, k) => !used.has(k));
const dubai = (d: Date) => new Date(d.getTime() + 4 * 3600000).toISOString().slice(5, 16).replace("T", " ");
const out = {
  window: `${dubai(range.from)} → ${dubai(range.to)} (Asia/Dubai)`,
  whatsappCashPosts: posts.length,
  matchedToTelevendEvent: rows.filter((r) => r.televend).length,
  whatsappPostsWithoutTelevendEvent: rows.filter((r) => !r.televend).map((r) => ({ at: dubai(r.post.at), asset: r.post.asset, amount: r.post.amount, who: r.post.who, text: r.post.text })),
  televendCollectionsInWindow: tv.length,
  televendCollectionsWithoutWhatsappPost: unreported.map((t) => ({ at: dubai(t.at), asset: t.asset, machine: t.machine })),
  matched: rows.filter((r) => r.televend).map((r) => ({ asset: r.post.asset, who: r.post.who, amount: r.post.amount, whatsapp: dubai(r.post.at), televend: dubai(r.televend!.at), minutesApart: r.minutesApart })),
  requests: c.sent,
};
mkdirSync("private-data/reports", { recursive: true });
writeFileSync("private-data/reports/cash-crosscheck-2026-10-14.json", JSON.stringify(out, null, 2));
console.log(JSON.stringify({ ...out, matched: `${out.matched.length} rows (see file)` }, null, 2));
