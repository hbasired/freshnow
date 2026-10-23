// Read-only: the Analytics figures for the last 7 whole days, from the live mirror, through core (the CEO's view).
import { config } from "dotenv";
config({ path: "C:/Users/acer/Downloads/freshnow/.env", quiet: true });
const core = await import("../../packages/core/src/index.ts");
const viewer = await core.loadViewer(core.DEMO_CEO_ID);
const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Dubai" }).format(new Date());
const add = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const range = { from: add(today, -7), to: add(today, -1) };
const t0 = Date.now();
const p = await core.machinePerformance(viewer!, range);
const ms = Date.now() - t0;
const f = p.fleet;
console.log(JSON.stringify({
  ms,
  period: p.period, before: p.before, coverage: { read: p.coverage.read.length, notRead: p.coverage.notRead, beforeRead: p.coverage.beforeRead.length, beforeNotRead: p.coverage.beforeNotRead, mirroredFrom: p.coverage.mirroredFrom },
  fleet: { machines: f.machines, selling: f.selling, cups: f.cups, perMachineDay: f.cupsPerMachineDay, before: f.before, changePct: f.changePct, incomeAED: Math.round(f.incomeFils / 100), cashShare: f.cashShare, cashMove: f.cashShareMove, tiers: f.tiers, top80: f.top80 },
  categories: p.categories.map((c) => ({ c: c.category, machines: c.machines, selling: c.selling, noSales: c.noSales, cpmd: c.cupsPerMachineDay, share: c.share, change: c.changePct, cash: c.cashShare, best: c.best?.assetNo, weakest: c.weakest?.assetNo })),
  insights: p.insights.map((i) => i.text),
}, null, 1));
await core.closeDb();
