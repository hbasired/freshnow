import { loadConfig } from "./config.js";
import { withContext, type AppContext } from "./db.js";
import type { Actor } from "./permissions.js";
import {
  AnalyticsRefused,
  NOT_COUNTED,
  addDays,
  attributed,
  attributedHours,
  checkCategories,
  checkRange,
  compared,
  fmt,
  machineInfo,
  machineOfRecord,
  machineRef,
  namePrice,
  nameOf,
  pct,
  r1,
  requireReader,
  storeDays,
  type Compared,
  type Insight,
  type Period,
} from "./analytics.js";

/**
 * Sales profiles and comparisons (TASK-075) — the pages behind the Analytics portal's buttons. The user (23 Oct): "the
 * machines and charts in the analytics page are small and not complete can you make them buttons and then it opens new
 * page", "last week same day percentage difference should also be mentioned", "a comparison page where I can select two
 * dates, or two machines, or two categories", and "key indication regarding the finances and sales … in short and direct
 * manner".
 *
 * A profile is one scope — the categories chosen, one category, or one machine — over whole days: each day beside the same
 * weekday a week before, the hours of the day, the days of the week, how people paid, the estimated income and a few short
 * sentences. A comparison is two profiles side by side with the differences worked out here, so the page only draws.
 *
 * The same rules as the performance page (core/analytics.ts), and the same SQL for what a machine is: only days the store
 * holds checked count; a day not read is said, never a zero; a change compares only days read on both sides; a machine's
 * sales count for the FreshNow machine it stood in that day, in its category now; income is cash cups at the cash price
 * plus the other paid cups at the price in the name — token cups are not paid. Everything is counted by Postgres under the
 * viewer's row security, then added up here by fixed code; no model is involved.
 */

export type ProfileScope =
  | { kind: "selection"; categories?: readonly string[] | null }
  | { kind: "category"; category: string }
  | { kind: "machine"; machine: string | number };

/** How a cup was paid, as the page groups Televend's types (VF85): card = Cashless + Cashless 3. */
export type PaymentKind = "cash" | "card" | "wallet" | "token" | "other";
export const PAYMENT_KINDS: readonly PaymentKind[] = ["cash", "card", "wallet", "token", "other"];

const WEEKDAY = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

export interface ProfileDay {
  date: string;
  /** Null when the store does not hold the day — not read is never zero. */
  cups: number | null;
  incomeFils: number | null;
  cashCups: number | null;
  /** The same weekday a week before — the user's "last week same day" — and the change against it in % (0.1). */
  lastWeek: { date: string; cups: number | null };
  changePct: number | null;
}

export interface ProfileTotals {
  cups: number;
  /** Cups per day read (0.1); null when no day was read. */
  cupsPerDay: number | null;
  /** Machines of the scope that sold in the period. */
  machinesSold: number;
  /** Cups per machine that sold, per day read (0.1). */
  cupsPerMachineDay: number | null;
  incomeFils: number;
  /** Income per day read, in fils (whole fils). */
  incomePerDayFils: number | null;
  /** Cups that were paid for: all but token cups. */
  paidCups: number;
  /** Income ÷ paid cups, in whole fils — what a paid cup brought on average. */
  avgPriceFils: number | null;
  cashShare: number | null;
  /** Cups a day against the same weekdays before, over the days read on both sides (0.1). */
  compare: Compared | null;
  /** Income a day (fils) against the same days before, over the same pairs. */
  incomeCompare: Compared | null;
  /** The last day read against the same weekday a week before. */
  lastDay: { date: string; cups: number; lastWeek: { date: string; cups: number | null }; changePct: number | null } | null;
  /** The hour with the most cups, and its share of the cups. */
  peak: { hour: number; cups: number; share: number } | null;
  bestDay: { date: string; cups: number } | null;
  weakestDay: { date: string; cups: number } | null;
}

export interface SalesProfile {
  period: Period;
  /** The same days of the week, `shiftDays` earlier — what the totals' changes compare with. */
  before: Period & { shiftDays: number };
  coverage: { read: string[]; notRead: string[]; beforeRead: string[]; compared: string[] };
  scope: {
    kind: ProfileScope["kind"];
    label: string;
    /** The categories chosen (selection), null for every category. */
    categories: string[] | null;
    category: string | null;
    machineKey: string | null;
    machineTvId: number | null;
    assetNo: number | null;
    /** Machines of the scope in the period: live now, or sold in it. */
    machines: number;
  };
  totals: ProfileTotals;
  days: ProfileDay[];
  /** Cups at each hour of the Dubai day: per day read (0.1), the period and the same days before, and the sums. */
  hours: { hour: number; now: number | null; before: number | null; nowCups: number; beforeCups: number }[];
  /** Each day of the week in the period (1 = Monday): how many were read and the cups per such day. */
  weekdays: { dow: number; label: string; days: number; cups: number; cupsPerDay: number | null }[];
  /** How the cups were paid: the period's days read, and the days read before. */
  payments: { kind: PaymentKind; now: number; nowShare: number | null; before: number; beforeShare: number | null }[];
  insights: Insight[];
}

interface FactRow {
  key: string;
  machine_id: string | null;
  machine_tv_id: string;
  asset_no: number | null;
  label: string;
  category: string;
  enabled: boolean;
  set_price: number | null;
  name_price: number | null;
  day: string | null;
  cups: number;
  cash_cups: number;
  card_cups: number;
  wallet_cups: number;
  token_cups: number;
  other_cups: number;
}

interface Facts {
  key: string;
  machineId: string | null;
  machineTvId: number;
  assetNo: number | null;
  label: string;
  category: string;
  counted: boolean;
  live: boolean;
  cashFils: number;
  cardFils: number;
}

interface Sales {
  cups: number;
  cash: number;
  card: number;
  wallet: number;
  token: number;
  other: number;
}

const zero = (): Sales => ({ cups: 0, cash: 0, card: 0, wallet: 0, token: 0, other: 0 });
const add = (t: Sales, s: Sales): void => {
  t.cups += s.cups;
  t.cash += s.cash;
  t.card += s.card;
  t.wallet += s.wallet;
  t.token += s.token;
  t.other += s.other;
};
/**
 * Estimated: cash cups × the cash price + the other paid cups × the card price; token cups are not paid (A-T70.1, A-T70.3).
 * UNVERIFIED: wallet and "other" cups are paid at the card price (A-T75.2) until Televend's amounts arrive.
 */
const incomeOf = (s: Sales, f: Facts): number => s.cash * f.cashFils + (s.cups - s.cash - s.token) * f.cardFils;
const isoWeekday = (d: string): number => ((new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;
/** "Thu 23 Oct" — the words a sentence names a day with. */
export const dayWords = (d: string): string =>
  new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${d}T00:00:00Z`));
/** The day of the month in a day's words — a figure the sentence states. */
const dom = (d: string): string => String(Number(d.slice(8, 10)));
const hh = (h: number): string => String(h).padStart(2, "0");
const aed2 = (fils: number): string => (fils / 100).toFixed(2);
const aed0 = (fils: number): string => Math.round(fils / 100).toLocaleString("en-GB");

interface Built {
  profile: SalesProfile;
  /** Each machine of the scope with its cups over the days read — for a comparison's movers and categories. */
  perKey: Map<string, { label: string; assetNo: number | null; category: string; cups: number }>;
  nRead: number;
}

/** One scope over a range of whole days — null when the machine asked for is not known. */
export async function salesProfile(
  viewer: AppContext & Actor,
  range: { from: string; to: string },
  scope: ProfileScope,
  now: Date = new Date(),
): Promise<SalesProfile | null> {
  return (await build(viewer, range, scope, now))?.profile ?? null;
}

async function build(viewer: AppContext & Actor, range: { from: string; to: string }, scope: ProfileScope, now: Date): Promise<Built | null> {
  requireReader(viewer);
  const p = checkRange(range, now);
  const chosen = scope.kind === "selection" ? checkCategories(scope.categories) : null;
  const category = scope.kind === "category" ? (checkCategories([scope.category]) ?? [])[0]! : null;
  const ref = scope.kind === "machine" ? machineRef(scope.machine) : null;
  const before = { from: addDays(p.from, -p.shiftDays), to: addDays(p.to, -p.shiftDays), days: p.days, shiftDays: p.shiftDays };
  const defaultPrice = loadConfig().OPS_DEFAULT_CASH_PRICE_FILS;
  const periodDays = Array.from({ length: p.days }, (_, i) => addDays(p.from, i));
  const beforeDays = periodDays.map((d) => addDays(d, -p.shiftDays));
  const weekDays = periodDays.map((d) => addDays(d, -7));

  const loaded = await withContext(
    viewer,
    async (sql) => {
      // The earliest day needed is the first day before (shiftDays ≥ 7); the latest the period's last.
      const held = await storeDays(sql, before.from, p.to);
      const read = [...new Set([...periodDays, ...beforeDays, ...weekDays])].filter((d) => held.get(d)).sort();
      let machineKey: string | null = null;
      if (ref && "machineId" in ref) machineKey = ref.machineId;
      else if (ref) {
        const [rec] = await sql<{ televend_id: string; machine_id: string | null }[]>`${machineOfRecord(sql, ref.tvId)}`;
        if (!rec) return null;
        machineKey = rec.machine_id ?? `tv:${rec.televend_id}`;
      }
      const rows = await sql<FactRow[]>`
        with ${attributed(sql, read)},
        ${machineInfo(sql)},
        per as (
          select coalesce(a.machine_id::text, 'tv:' || a.machine_tv_id::text) as key, a.day,
                 sum(a.cups)::int as cups, sum(a.cash_cups)::int as cash_cups, sum(a.cashless_cups + a.cashless3_cups)::int as card_cups,
                 sum(a.wallet_cups)::int as wallet_cups, sum(a.token_cups)::int as token_cups, sum(a.other_cups)::int as other_cups
            from att a group by 1, 2
        )
        select i.key, i.machine_id::text as machine_id, i.tv_id::text as machine_tv_id, i.asset_no, i.label, i.category, i.enabled,
               i.cash_price_fils as set_price, ${namePrice(sql)} as name_price,
               to_char(per.day, 'YYYY-MM-DD') as day,
               coalesce(per.cups, 0) as cups, coalesce(per.cash_cups, 0) as cash_cups, coalesce(per.card_cups, 0) as card_cups,
               coalesce(per.wallet_cups, 0) as wallet_cups, coalesce(per.token_cups, 0) as token_cups, coalesce(per.other_cups, 0) as other_cups
          from info i left join per on per.key = i.key
         order by i.key, per.day`;
      const facts = new Map<string, Facts>();
      const sales = new Map<string, Map<string, Sales>>();
      for (const r of rows) {
        if (!facts.has(r.key)) {
          const cashFils = r.set_price ?? defaultPrice;
          facts.set(r.key, {
            key: r.key,
            machineId: r.machine_id,
            machineTvId: Number(r.machine_tv_id),
            assetNo: r.asset_no,
            label: r.label,
            category: r.category,
            counted: r.category !== NOT_COUNTED,
            live: r.enabled,
            cashFils,
            cardFils: r.name_price ?? cashFils,
          });
          sales.set(r.key, new Map());
        }
        if (r.day) {
          sales.get(r.key)!.set(r.day, { cups: r.cups, cash: r.cash_cups, card: r.card_cups, wallet: r.wallet_cups, token: r.token_cups, other: r.other_cups });
        }
      }
      const inScope = (f: Facts): boolean =>
        scope.kind === "selection" ? f.counted && (chosen === null || chosen.includes(f.category)) : scope.kind === "category" ? f.category === category : f.key === machineKey;
      const keys = [...facts.values()].filter(inScope).map((f) => f.key);
      if (scope.kind === "machine" && keys.length === 0) return null;
      const readNow = periodDays.filter((d) => held.get(d));
      const readBefore = beforeDays.filter((d) => held.get(d));
      const hours = await sql<{ hour: number; now_cups: number; before_cups: number }[]>`
        with ${attributedHours(sql, [...readNow, ...readBefore])}
        select a.hour::int as hour,
               coalesce(sum(a.cups) filter (where a.day = any(${readNow}::date[])), 0)::int as now_cups,
               coalesce(sum(a.cups) filter (where a.day = any(${readBefore}::date[])), 0)::int as before_cups
          from atth a
         where coalesce(a.machine_id::text, 'tv:' || a.machine_tv_id::text) = any(${keys}::text[])
         group by 1`;
      return { held, facts, sales, keys, hours, machineKey };
    },
    { readOnly: true },
  );
  if (!loaded) return null;
  const { held, facts, sales, keys, hours } = loaded;

  const readNow = periodDays.filter((d) => held.get(d));
  const readBefore = beforeDays.filter((d) => held.get(d));
  const pairNow = readNow.filter((d) => held.get(addDays(d, -p.shiftDays)));
  const nRead = readNow.length;
  const scoped = keys.map((k) => facts.get(k)!);

  // ── each day of the scope, and its income ─────────────────────────────────
  const dayTotal = (d: string): { s: Sales; income: number } => {
    const s = zero();
    let income = 0;
    for (const f of scoped) {
      const x = sales.get(f.key)!.get(d);
      if (!x) continue;
      add(s, x);
      income += incomeOf(x, f);
    }
    return { s, income };
  };
  const cupsOn = (d: string): number | null => (held.get(d) ? dayTotal(d).s.cups : null);
  const days: ProfileDay[] = periodDays.map((date) => {
    const lw = addDays(date, -7);
    const t = held.get(date) ? dayTotal(date) : null;
    const lwCups = cupsOn(lw);
    const cups = t ? t.s.cups : null;
    return {
      date,
      cups,
      incomeFils: t ? t.income : null,
      cashCups: t ? t.s.cash : null,
      lastWeek: { date: lw, cups: lwCups },
      changePct: cups !== null && lwCups !== null && lwCups > 0 ? r1(((cups - lwCups) / lwCups) * 100) : null,
    };
  });

  // ── the totals ─────────────────────────────────────────────────────────────
  const nowSales = zero();
  const beforeSales = zero();
  let income = 0;
  let pairCups = 0;
  let pairBeforeCups = 0;
  let pairIncome = 0;
  let pairBeforeIncome = 0;
  const perKey: Built["perKey"] = new Map();
  for (const f of scoped) {
    let cups = 0;
    for (const d of readNow) {
      const x = sales.get(f.key)!.get(d);
      if (!x) continue;
      add(nowSales, x);
      income += incomeOf(x, f);
      cups += x.cups;
    }
    for (const d of readBefore) {
      const x = sales.get(f.key)!.get(d);
      if (x) add(beforeSales, x);
    }
    for (const d of pairNow) {
      const x = sales.get(f.key)!.get(d);
      if (x) {
        pairCups += x.cups;
        pairIncome += incomeOf(x, f);
      }
      const y = sales.get(f.key)!.get(addDays(d, -p.shiftDays));
      if (y) {
        pairBeforeCups += y.cups;
        pairBeforeIncome += incomeOf(y, f);
      }
    }
    perKey.set(f.key, { label: f.label, assetNo: f.assetNo, category: f.category, cups });
  }
  const machinesSold = [...perKey.values()].filter((x) => x.cups > 0).length;
  const paidCups = nowSales.cups - nowSales.token;
  const readDays = days.filter((d) => d.cups !== null) as (ProfileDay & { cups: number })[];
  const last = readDays[readDays.length - 1];
  const byCups = [...readDays].sort((a, b) => b.cups - a.cups || a.date.localeCompare(b.date));
  const hourRows = Array.from({ length: 24 }, (_, hour) => {
    const h = hours.find((x) => x.hour === hour);
    return { hour, nowCups: h?.now_cups ?? 0, beforeCups: h?.before_cups ?? 0 };
  });
  const hourCups = hourRows.reduce((t, h) => t + h.nowCups, 0);
  const peakRow = [...hourRows].sort((a, b) => b.nowCups - a.nowCups || a.hour - b.hour)[0]!;
  const totals: ProfileTotals = {
    cups: nowSales.cups,
    cupsPerDay: nRead > 0 ? r1(nowSales.cups / nRead) : null,
    machinesSold,
    cupsPerMachineDay: nRead > 0 && machinesSold > 0 ? r1(nowSales.cups / nRead / machinesSold) : null,
    incomeFils: income,
    incomePerDayFils: nRead > 0 ? Math.round(income / nRead) : null,
    paidCups,
    avgPriceFils: paidCups > 0 ? Math.round(income / paidCups) : null,
    cashShare: pct(nowSales.cash, nowSales.cups),
    compare: compared(pairCups, pairBeforeCups, pairNow.length),
    incomeCompare: compared(pairIncome, pairBeforeIncome, pairNow.length),
    lastDay: last ? { date: last.date, cups: last.cups, lastWeek: last.lastWeek, changePct: last.changePct } : null,
    peak: hourCups > 0 ? { hour: peakRow.hour, cups: peakRow.nowCups, share: pct(peakRow.nowCups, hourCups)! } : null,
    bestDay: byCups.length >= 2 ? { date: byCups[0]!.date, cups: byCups[0]!.cups } : null,
    weakestDay: byCups.length >= 2 ? { date: byCups[byCups.length - 1]!.date, cups: byCups[byCups.length - 1]!.cups } : null,
  };

  const payments = PAYMENT_KINDS.map((kind) => ({
    kind,
    now: nowSales[kind],
    nowShare: pct(nowSales[kind], nowSales.cups),
    before: beforeSales[kind],
    beforeShare: pct(beforeSales[kind], beforeSales.cups),
  }));
  const weekdays = WEEKDAY.map((label, i) => {
    const ds = readDays.filter((d) => isoWeekday(d.date) === i + 1);
    const cups = ds.reduce((t, d) => t + d.cups, 0);
    return { dow: i + 1, label, days: ds.length, cups, cupsPerDay: ds.length > 0 ? r1(cups / ds.length) : null };
  });
  const one = scope.kind === "machine" ? scoped[0]! : null;
  const label =
    scope.kind === "machine"
      ? nameOf(one!)
      : scope.kind === "category"
        ? category!
        : chosen === null
          ? "Every category"
          : chosen.length === 1
            ? chosen[0]!
            : `${chosen.length} categories`;

  const profile: SalesProfile = {
    period: { from: p.from, to: p.to, days: p.days },
    before,
    coverage: { read: readNow, notRead: periodDays.filter((d) => !held.get(d)), beforeRead: readBefore, compared: pairNow },
    scope: {
      kind: scope.kind,
      label,
      categories: chosen,
      category,
      machineKey: one?.key ?? null,
      machineTvId: one?.machineTvId ?? null,
      assetNo: one?.assetNo ?? null,
      machines: scoped.filter((f) => f.live || (perKey.get(f.key)?.cups ?? 0) > 0).length,
    },
    totals,
    days,
    hours: hourRows.map((h) => ({
      hour: h.hour,
      now: nRead > 0 ? r1(h.nowCups / nRead) : null,
      before: readBefore.length > 0 ? r1(h.beforeCups / readBefore.length) : null,
      nowCups: h.nowCups,
      beforeCups: h.beforeCups,
    })),
    weekdays,
    payments,
    insights: [],
  };
  profile.insights = profileInsights(profile);
  return { profile, perKey, nRead };
}

// ── what a profile says ──────────────────────────────────────────────────────
/**
 * Short sentences filled from the profile's own figures — the user asked for "key insights and key indications in short
 * and direct manner". Each carries every figure it states, as written (the numeric gate's evidence, CLAUDE.md).
 */
export function profileInsights(p: Omit<SalesProfile, "insights">): Insight[] {
  const out: Insight[] = [];
  const t = p.totals;
  if (t.lastDay && t.lastDay.changePct !== null && t.lastDay.lastWeek.cups !== null) {
    const c = t.lastDay.changePct;
    const n = fmt(t.lastDay.cups);
    const by = fmt(Math.abs(c));
    const same = Math.abs(c) < 0.05;
    out.push({
      id: "last_day",
      // Under 5 % either way is a day's noise, as for the trend: said, not coloured. UNVERIFIED: FreshNow's own line (A-T75.1).
      tone: Math.abs(c) < 5 ? "info" : c > 0 ? "good" : "bad",
      text: same
        ? `${dayWords(t.lastDay.date)}: ${n} cups, the same as ${dayWords(t.lastDay.lastWeek.date)}.`
        : `${dayWords(t.lastDay.date)}: ${n} cups, ${by} % ${c > 0 ? "more" : "fewer"} than ${dayWords(t.lastDay.lastWeek.date)}.`,
      numbers: same ? [dom(t.lastDay.date), n, dom(t.lastDay.lastWeek.date)] : [dom(t.lastDay.date), n, by, dom(t.lastDay.lastWeek.date)],
      action: null,
    });
  }
  if (t.compare && t.compare.changePct !== null && p.period.days > 1) {
    const c = t.compare.changePct;
    const by = fmt(Math.abs(c));
    const a = fmt(t.compare.now);
    const b = fmt(t.compare.before);
    // When some days could not be compared, the sentence says on how many it rests (as the performance page's does).
    const partial = t.compare.days < p.coverage.read.length;
    out.push({
      id: "trend",
      tone: Math.abs(c) < 5 ? "info" : c > 0 ? "good" : "bad",
      text: `Cups a day ${c >= 0 ? "up" : "down"} ${by} % on the same days before: ${a} against ${b}${partial ? ` (the ${t.compare.days} days read in both)` : ""}.`,
      numbers: [by, a, b, ...(partial ? [String(t.compare.days)] : [])],
      action: null,
    });
  }
  if (t.peak) {
    const share = fmt(t.peak.share);
    out.push({
      id: "peak_hour",
      tone: "info",
      text: `Busiest hour: ${hh(t.peak.hour)}:00 to ${hh(t.peak.hour + 1)}:00, ${share} % of the cups.`,
      numbers: [hh(t.peak.hour), "00", hh(t.peak.hour + 1), share],
      action: null,
    });
  }
  if (t.bestDay && t.weakestDay && p.coverage.read.length >= 3) {
    const b = fmt(t.bestDay.cups);
    const w = fmt(t.weakestDay.cups);
    out.push({
      id: "best_day",
      tone: "info",
      text: `Best day ${dayWords(t.bestDay.date)}, ${b} cups; weakest ${dayWords(t.weakestDay.date)}, ${w}.`,
      numbers: [dom(t.bestDay.date), b, dom(t.weakestDay.date), w],
      action: null,
    });
  }
  if (t.avgPriceFils !== null && t.incomePerDayFils !== null) {
    const price = aed2(t.avgPriceFils);
    const day = aed0(t.incomePerDayFils);
    out.push({
      id: "income",
      tone: "info",
      text: `About AED ${day} a day — AED ${price} for each paid cup (estimated from the prices).`,
      numbers: [day, price],
      action: null,
    });
  }
  const cash = p.payments.find((x) => x.kind === "cash")!;
  const nowAll = p.payments.reduce((t, x) => t + x.now, 0);
  const beforeAll = p.payments.reduce((t, x) => t + x.before, 0);
  // The move in points from the exact shares, never from the rounded ones shown (43.75 → 23.44 is 20.3 points, not 20.4).
  const move = cash.nowShare !== null && cash.beforeShare !== null ? r1((cash.now / nowAll - cash.before / beforeAll) * 100) : null;
  if (move !== null && Math.abs(move) >= 1) {
    const now = fmt(cash.nowShare!);
    const by = fmt(Math.abs(move));
    out.push({
      id: "cash_share",
      tone: "info",
      text: `Cash ${now} % of the cups, ${move > 0 ? "up" : "down"} ${by} points.`,
      numbers: [now, by],
      action: null,
    });
  }
  return out;
}

// ── two side by side ─────────────────────────────────────────────────────────
export type CompareRequest =
  | { mode: "days"; a: string; b: string; categories?: readonly string[] | null }
  | { mode: "periods"; a: { from: string; to: string }; b: { from: string; to: string }; categories?: readonly string[] | null }
  | { mode: "machines"; range: { from: string; to: string }; a: string | number; b: string | number }
  | { mode: "categories"; range: { from: string; to: string }; a: string; b: string };

export interface CompareRow {
  id: string;
  label: string;
  unit: "cups" | "fils" | "pct" | "count";
  a: number | null;
  b: number | null;
  /** B − A, in the row's unit (points for a %). */
  diff: number | null;
  /** (B − A) ÷ A in % (0.1); null for a % row, or when A is zero or missing. */
  diffPct: number | null;
}

export interface SalesComparison {
  mode: CompareRequest["mode"];
  a: SalesProfile;
  b: SalesProfile;
  rows: CompareRow[];
  /** Cups at each hour, per day read, A and B. */
  hours: { hour: number; a: number | null; b: number | null }[];
  /** Day by day, A and B — for two machines or two categories over the same days. */
  days: { date: string; a: number | null; b: number | null }[] | null;
  /** The share of cups paid each way, A and B. */
  payments: { kind: PaymentKind; a: number | null; b: number | null }[];
  /** Each category's cups a day, A and B — for two days or two periods. */
  categories: { category: string; a: number | null; b: number | null; changePct: number | null }[] | null;
  /** The machines that moved most between A and B, in cups a day — for two days or two periods. */
  movers: { key: string; label: string; assetNo: number | null; a: number; b: number; change: number }[] | null;
  insights: Insight[];
}

/** How many machines a comparison names each way. */
const MOVERS = 5;

/** Two days, two periods, two machines or two categories, side by side — null when a machine asked for is not known. */
export async function compareSales(viewer: AppContext & Actor, req: CompareRequest, now: Date = new Date()): Promise<SalesComparison | null> {
  requireReader(viewer);
  let ra: { from: string; to: string };
  let rb: { from: string; to: string };
  let sa: ProfileScope;
  let sb: ProfileScope;
  if (req.mode === "days" || req.mode === "periods") {
    ra = req.mode === "days" ? { from: req.a, to: req.a } : req.a;
    rb = req.mode === "days" ? { from: req.b, to: req.b } : req.b;
    sa = sb = { kind: "selection", categories: req.categories ?? null };
  } else if (req.mode === "machines") {
    if (String(req.a).toLowerCase() === String(req.b).toLowerCase()) throw new AnalyticsRefused("Choose two different machines.", 400, "same_twice");
    ra = rb = req.range;
    sa = { kind: "machine", machine: req.a };
    sb = { kind: "machine", machine: req.b };
  } else {
    if (req.a.trim() === req.b.trim()) throw new AnalyticsRefused("Choose two different categories.", 400, "same_twice");
    ra = rb = req.range;
    sa = { kind: "category", category: req.a };
    sb = { kind: "category", category: req.b };
  }
  const A = await build(viewer, ra, sa, now);
  const B = await build(viewer, rb, sb, now);
  if (!A || !B) return null;
  const a = A.profile;
  const b = B.profile;
  if (req.mode === "machines" && a.scope.machineKey === b.scope.machineKey) {
    throw new AnalyticsRefused("Those are the same machine (one Televend record of it, and FreshNow's own).", 400, "same_twice");
  }

  // Each figure exact, from the totals — rounded only for showing, so a difference is never worked out from rounded rates.
  const show = (unit: CompareRow["unit"], n: number): number => (unit === "fils" ? Math.round(n) : unit === "count" ? n : r1(n));
  const row = (id: string, label: string, unit: CompareRow["unit"], x: number | null, y: number | null): CompareRow => ({
    id,
    label,
    unit,
    a: x === null ? null : show(unit, x),
    b: y === null ? null : show(unit, y),
    diff: x === null || y === null ? null : show(unit, y - x),
    diffPct: unit === "pct" || x === null || y === null || x === 0 ? null : r1(((y - x) / x) * 100),
  });
  const exact = (side: Built) => {
    const t = side.profile.totals;
    const cash = side.profile.payments.find((x) => x.kind === "cash")!.now;
    const n = side.nRead;
    return {
      cups: t.cups,
      cupsPerDay: n > 0 ? t.cups / n : null,
      machinesSold: t.machinesSold,
      perMachine: n > 0 && t.machinesSold > 0 ? t.cups / n / t.machinesSold : null,
      income: t.incomeFils,
      incomePerDay: n > 0 ? t.incomeFils / n : null,
      avgPrice: t.paidCups > 0 ? t.incomeFils / t.paidCups : null,
      cashShare: t.cups > 0 ? (cash / t.cups) * 100 : null,
    };
  };
  const ea = exact(A);
  const eb = exact(B);
  const rows: CompareRow[] = [
    ...(req.mode === "days"
      ? [row("cups", "Cups", "cups", ea.cups, eb.cups)]
      : [row("cups_per_day", "Cups a day", "cups", ea.cupsPerDay, eb.cupsPerDay), row("cups", "Cups in all", "cups", ea.cups, eb.cups)]),
    ...(req.mode === "machines"
      ? []
      : [row("machines_sold", "Machines that sold", "count", ea.machinesSold, eb.machinesSold), row("per_machine", "Cups per machine a day", "cups", ea.perMachine, eb.perMachine)]),
    ...(req.mode === "days"
      ? [row("income", "Income (est.)", "fils", ea.income, eb.income)]
      : [row("income_per_day", "Income a day (est.)", "fils", ea.incomePerDay, eb.incomePerDay), row("income", "Income in all (est.)", "fils", ea.income, eb.income)]),
    row("avg_price", "Per paid cup (est.)", "fils", ea.avgPrice, eb.avgPrice),
    row("cash_share", "Paid in cash", "pct", ea.cashShare, eb.cashShare),
  ];

  const sameDays = req.mode === "machines" || req.mode === "categories";
  const bySelection = req.mode === "days" || req.mode === "periods";
  const perDay = (cups: number, n: number) => (n > 0 ? r1(cups / n) : null);
  let categories: SalesComparison["categories"] = null;
  let movers: SalesComparison["movers"] = null;
  if (bySelection) {
    const names = [...new Set([...A.perKey.values(), ...B.perKey.values()].map((x) => x.category))].sort((x, y) => x.localeCompare(y));
    const sumCat = (m: Built["perKey"], c: string) => [...m.values()].filter((x) => x.category === c).reduce((t, x) => t + x.cups, 0);
    categories = names
      .map((c) => {
        const x = perDay(sumCat(A.perKey, c), A.nRead);
        const y = perDay(sumCat(B.perKey, c), B.nRead);
        return { category: c, a: x, b: y, changePct: x !== null && y !== null && x > 0 ? r1(((y - x) / x) * 100) : null };
      })
      .sort((x, y) => (y.b ?? 0) + (y.a ?? 0) - ((x.b ?? 0) + (x.a ?? 0)) || x.category.localeCompare(y.category));
    if (A.nRead > 0 && B.nRead > 0) {
      const keys = new Set([...A.perKey.keys(), ...B.perKey.keys()]);
      const moved = [...keys]
        .map((key) => {
          const x = A.perKey.get(key);
          const y = B.perKey.get(key);
          const info = (y ?? x)!;
          const ax = r1((x?.cups ?? 0) / A.nRead);
          const by = r1((y?.cups ?? 0) / B.nRead);
          return { key, label: info.label, assetNo: info.assetNo, a: ax, b: by, change: r1(by - ax) };
        })
        .filter((m) => m.change !== 0);
      const order = (s: number) => (x: { change: number; assetNo: number | null; key: string }, y: { change: number; assetNo: number | null; key: string }) =>
        s * (y.change - x.change) || (x.assetNo ?? 1e9) - (y.assetNo ?? 1e9) || x.key.localeCompare(y.key);
      const up = moved.filter((m) => m.change > 0).sort(order(1)).slice(0, MOVERS);
      const down = moved.filter((m) => m.change < 0).sort(order(-1)).slice(0, MOVERS);
      movers = [...up, ...down];
    }
  }

  const comparison: SalesComparison = {
    mode: req.mode,
    a,
    b,
    rows,
    hours: a.hours.map((h, i) => ({ hour: h.hour, a: h.now, b: b.hours[i]!.now })),
    days: sameDays ? a.days.map((d, i) => ({ date: d.date, a: d.cups, b: b.days[i]!.cups })) : null,
    payments: PAYMENT_KINDS.map((kind) => ({
      kind,
      a: a.payments.find((x) => x.kind === kind)!.nowShare,
      b: b.payments.find((x) => x.kind === kind)!.nowShare,
    })),
    categories,
    movers,
    insights: [],
  };
  comparison.insights = compareInsights(comparison);
  return comparison;
}

/** What a side is called in a sentence: its day or days, its machine, or its category. */
const sideName = (c: SalesComparison, p: SalesProfile): string =>
  c.mode === "days" ? dayWords(p.period.from) : c.mode === "periods" ? `${dayWords(p.period.from)} – ${dayWords(p.period.to)}` : p.scope.label;
/** The figures a side's name states — a day's number of the month (names of machines and categories are not figures). */
const sideNumbers = (c: SalesComparison, p: SalesProfile): string[] =>
  c.mode === "days" ? [dom(p.period.from)] : c.mode === "periods" ? [dom(p.period.from), dom(p.period.to)] : [];

/** Short sentences: the volume, per machine, the income, the busiest hours, the biggest movers. */
export function compareInsights(c: SalesComparison): Insight[] {
  const out: Insight[] = [];
  const A = sideName(c, c.a);
  const B = sideName(c, c.b);
  const nums = [...sideNumbers(c, c.a), ...sideNumbers(c, c.b)];
  const r = (id: string) => c.rows.find((x) => x.id === id);
  const vol = r(c.mode === "days" ? "cups" : "cups_per_day");
  if (vol && vol.a !== null && vol.b !== null) {
    const x = fmt(vol.a);
    const y = fmt(vol.b);
    const unit = c.mode === "days" ? "cups" : "cups a day";
    if (vol.diffPct === null || Math.abs(vol.diffPct) < 0.05) {
      out.push({ id: "volume", tone: "info", text: `${B}: ${y} ${unit}; ${A}: ${x}.`, numbers: [...nums, y, x], action: null });
    } else {
      const by = fmt(Math.abs(vol.diffPct));
      out.push({
        id: "volume",
        tone: vol.diffPct > 0 ? "good" : "bad",
        text: `${B} sold ${by} % ${vol.diffPct > 0 ? "more" : "fewer"} ${unit} than ${A}: ${y} against ${x}.`,
        numbers: [...nums, by, y, x],
        action: null,
      });
    }
  }
  const pm = r("per_machine");
  if (c.mode === "categories" && pm && pm.a !== null && pm.b !== null) {
    const x = fmt(pm.a);
    const y = fmt(pm.b);
    out.push({ id: "per_machine", tone: "info", text: `Per machine that sold: ${B} ${y} cups a day, ${A} ${x}.`, numbers: [y, x], action: null });
  }
  const inc = r(c.mode === "days" ? "income" : "income_per_day");
  if (inc && inc.a !== null && inc.b !== null && inc.diffPct !== null) {
    const x = aed0(inc.a);
    const y = aed0(inc.b);
    const by = fmt(Math.abs(inc.diffPct));
    out.push({
      id: "income",
      tone: "info",
      text: `Income${c.mode === "days" ? "" : " a day"} (est.): AED ${y} against AED ${x}, ${inc.diffPct >= 0 ? "+" : "−"}${by} %.`,
      numbers: [y, x, by],
      action: null,
    });
  }
  const pa = c.a.totals.peak;
  const pb = c.b.totals.peak;
  if (pa && pb) {
    out.push({
      id: "peak",
      tone: "info",
      text: pa.hour === pb.hour ? `Both are busiest at ${hh(pa.hour)}:00.` : `Busiest hour: ${A} ${hh(pa.hour)}:00, ${B} ${hh(pb.hour)}:00.`,
      numbers: pa.hour === pb.hour ? [hh(pa.hour), "00"] : [...nums, hh(pa.hour), "00", hh(pb.hour)],
      action: null,
    });
  }
  const moved = (c.categories ?? []).filter((x) => x.changePct !== null && x.a !== null && x.a >= 1).sort((x, y) => Math.abs(y.changePct!) - Math.abs(x.changePct!));
  if (moved.length > 0 && c.categories!.length > 1) {
    const m = moved[0]!;
    const by = fmt(Math.abs(m.changePct!));
    const x = fmt(m.a!);
    const y = fmt(m.b ?? 0);
    out.push({
      id: "category_move",
      tone: m.changePct! >= 0 ? "good" : "bad",
      text: `Moved most: ${m.category}, ${y} cups a day against ${x} (${m.changePct! >= 0 ? "+" : "−"}${by} %).`,
      numbers: [y, x, by],
      action: null,
    });
  }
  const top = [...(c.movers ?? [])].sort((x, y) => Math.abs(y.change) - Math.abs(x.change))[0];
  if (top) {
    const x = fmt(top.a);
    const y = fmt(top.b);
    out.push({ id: "machine_move", tone: top.change > 0 ? "good" : "bad", text: `Machine that moved most: ${nameOf(top)}, ${x} → ${y} cups a day.`, numbers: [x, y], action: null });
  }
  return out;
}
