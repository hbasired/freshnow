/**
 * TASK-055 verification: does a live, read-only pull agree with the exports people already
 * download from Televend?
 *
 *   pnpm televend:verify [--day 2026-10-12] [--exports data-televend]
 *
 * Compares, for one business day (Asia/Dubai):
 *   machines  — total and enabled counts, and the enabled names, live vs VendingMachines.xlsx
 *   refills   — per machine: number of log rows and Σ cups, live vs refill_log*.csv
 *   alarms    — every alarm/warning row in event_list*.xls matched to a live event on the same
 *               machine within the same minute; the live level/type codes of the matches
 *   vends     — live row count vs Televend's own aggregate count (internal consistency; no
 *               vends export exists to compare with)
 *
 * Read-only: all requests go through TelevendClient (allow-listed GETs + one sign-in), paced at
 * ≥ 1 s. Prints counts and machine names only — never a person's name. Writes the full result
 * to private-data/televend-verify/<day>.json (git-ignored).
 */
import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BridgeSource, dubaiDay } from "../packages/televend/src/sources/bridge.js";
import { FileSource } from "../packages/televend/src/sources/files.js";
import { assetNumber } from "../packages/televend/src/machine-names.js";
import { PasswordSession, TelevendClient, readTelevendConfig } from "../packages/televend/src/index.js";

const args = process.argv.slice(2);
const opt = (name: string, dflt: string): string => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? (args[i + 1] as string) : dflt;
};
const day = opt("--day", "2026-10-12");
const exportsDir = opt("--exports", "data-televend");

const config = readTelevendConfig();
if (!config?.username || !config.password) throw new Error("bridge credentials missing (.env TELEVEND_*)");
const session = new PasswordSession({ username: config.username, password: config.password }, { fetch: globalThis.fetch as never, now: Date.now });
const client = new TelevendClient(session, { tenantId: config.tenantId, companyId: config.companyId, minIntervalMs: Math.max(1_000, config.minIntervalMs) });
const live = new BridgeSource(client, { tenantId: config.tenantId, companyId: config.companyId });
const files = new FileSource(exportsDir);
const range = dubaiDay(day);

const result: Record<string, unknown> = { day, exportsDir, exportFiles: files.list() };

// ── Machines ────────────────────────────────────────────────────────────────
const [lm, fm] = [await live.machines(), await files.machines()];
const liveEnabled = new Set(lm.filter((m) => m.enabled).map((m) => m.caption.trim()));
const fileEnabled = new Set(fm.filter((m) => m.enabled).map((m) => m.caption.trim()));
result.machines = {
  live: { total: lm.length, enabled: liveEnabled.size },
  file: { total: fm.length, enabled: fileEnabled.size },
  enabledOnlyLive: [...liveEnabled].filter((x) => !fileEnabled.has(x)),
  enabledOnlyFile: [...fileEnabled].filter((x) => !liveEnabled.has(x)),
};

// ── Refills ─────────────────────────────────────────────────────────────────
const [lr, fr] = [await live.refills(day), await files.refills(day)];
const tally = (rows: { machineCaption: string | null; quantityChange: number }[]) => {
  const m = new Map<string, { rows: number; cups: number }>();
  for (const r of rows) {
    const k = (r.machineCaption ?? "?").trim();
    const t = m.get(k) ?? { rows: 0, cups: 0 };
    t.rows++;
    t.cups += r.quantityChange;
    m.set(k, t);
  }
  return m;
};
const lt = tally(lr);
const ft = tally(fr);
// Captions change (9 enabled machines were renamed between the 13 Oct export and 15 Oct), so
// the decisive comparison is per asset number — the number inside the name.
const byAsset = (rows: { machineCaption: string | null; quantityChange: number }[]) =>
  tally(rows.map((r) => ({ machineCaption: String(assetNumber(r.machineCaption) ?? r.machineCaption), quantityChange: r.quantityChange })));
const la = byAsset(lr);
const fa = byAsset(fr);
const assetMismatches = [...new Set([...la.keys(), ...fa.keys()])]
  .map((k) => ({ asset: k, live: la.get(k) ?? { rows: 0, cups: 0 }, file: fa.get(k) ?? { rows: 0, cups: 0 } }))
  .filter((x) => x.live.rows !== x.file.rows || x.live.cups !== x.file.cups);
const refillMismatches = [...new Set([...lt.keys(), ...ft.keys()])]
  .map((k) => ({ machine: k, live: lt.get(k) ?? { rows: 0, cups: 0 }, file: ft.get(k) ?? { rows: 0, cups: 0 } }))
  .filter((x) => x.live.rows !== x.file.rows || x.live.cups !== x.file.cups);
result.refills = {
  live: { rows: lr.length, cups: lr.reduce((s, r) => s + r.quantityChange, 0), machines: lt.size },
  file: { rows: fr.length, cups: fr.reduce((s, r) => s + r.quantityChange, 0), machines: ft.size },
  captionMismatches: refillMismatches,
  assetMismatches,
  liveActions: Object.fromEntries([...new Set(lr.map((r) => r.action))].map((a) => [a, lr.filter((r) => r.action === a).length])),
  liveOrigins: Object.fromEntries([...new Set(lr.map((r) => r.origin))].map((a) => [a, lr.filter((r) => r.origin === a).length])),
};

// ── Alarms / events ─────────────────────────────────────────────────────────
const le = await live.events(range, { maxRows: 20_000 });
const fe = await files.events(range);
const minute = (d: Date) => Math.floor(d.getTime() / 60_000);
const byKey = new Map<string, typeof le.rows>();
for (const e of le.rows) {
  const k = `${assetNumber(e.machineCaption) ?? (e.machineCaption ?? "").trim()}|${minute(e.startedAt)}`;
  byKey.set(k, [...(byKey.get(k) ?? []), e]);
}
let matched = 0;
const matchedCodes = new Map<string, number>();
const unmatchedFile: { machine: string | null; type: unknown; name: string | null; start: string }[] = [];
for (const f of fe.rows) {
  const candidates = byKey.get(`${assetNumber(f.machineCaption) ?? (f.machineCaption ?? "").trim()}|${minute(f.startedAt)}`) ?? [];
  // An alarm row in the export is matched to the most severe live event of that machine-minute.
  const hit = [...candidates].sort((a, b) => (b.level ?? 0) - (a.level ?? 0));
  if (hit?.length) {
    matched++;
    const k = `${String(f.type)} -> level ${hit[0]?.level} / type ${String(hit[0]?.type)}`;
    matchedCodes.set(k, (matchedCodes.get(k) ?? 0) + 1);
  } else if (unmatchedFile.length < 25) {
    unmatchedFile.push({ machine: f.machineCaption, type: f.type, name: f.name, start: f.startedAt.toISOString() });
  }
}
const levels = new Map<string, number>();
for (const e of le.rows) levels.set(`level ${e.level} / type ${String(e.type)}`, (levels.get(`level ${e.level} / type ${String(e.type)}`) ?? 0) + 1);
result.events = {
  live: { rows: le.rows.length, complete: le.complete, byLevelType: Object.fromEntries(levels) },
  file: { rows: fe.rows.length, note: "exports hold alarms/warnings only, for the periods someone chose" },
  fileRowsMatchedToLive: matched,
  matchedCodes: Object.fromEntries(matchedCodes),
  unmatchedFileSample: unmatchedFile,
};

// ── Vends ───────────────────────────────────────────────────────────────────
const lv = await live.vends(range, { maxRows: 20_000 });
const totals = await live.vendTotals(range);
const uniqueVends = new Set(lv.rows.map((v) => v.televendId)).size;
const pay = new Map<string, number>();
for (const v of lv.rows) pay.set(v.paymentTypeCaption ?? String(v.paymentType), (pay.get(v.paymentTypeCaption ?? String(v.paymentType)) ?? 0) + v.quantity);
result.vends = {
  listRows: lv.rows.length,
  uniqueVendIds: uniqueVends,
  complete: lv.complete,
  aggregate: { vends: totals.vends, quantity: totals.quantity, revenue: totals.revenue },
  quantityInList: lv.rows.reduce((s, v) => s + v.quantity, 0),
  byPaymentType: Object.fromEntries(pay),
  valuesVisible: lv.rows.some((v) => v.value !== null),
};

result.requests = { sent: client.sent, passwordSignIns: session.passwordSignIns };
const outDir = join("private-data", "televend-verify");
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, `${day}.json`), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
