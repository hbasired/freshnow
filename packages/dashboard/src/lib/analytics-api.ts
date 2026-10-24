import { get, post } from "./api";

/**
 * The Analytics portal's calls (TASK-070) — /dashboard/analytics/* — and the shapes they return (core/analytics.ts).
 * Every figure is counted by Postgres; this page only draws it.
 */

export type Tier = "top" | "average" | "below" | "no_sales";

/** Now against the same weekdays before, over the days read on both sides only: cups a day, and the change from the totals. */
export interface Compared {
  days: number;
  now: number;
  before: number;
  changePct: number | null;
}

export interface MachinePerf {
  /** Unique per row — FreshNow's machine id, else "tv:<record>": what its own calls name it by. */
  key: string;
  machineTvId: number;
  machineId: string | null;
  assetNo: number | null;
  label: string;
  category: string;
  televendRegion: string | null;
  corrected: boolean;
  emirate: string | null;
  cardOnly: boolean;
  disabledNow: boolean;
  /** Cash: set on the machine, else AED 10; card: the "AED n" in its Televend name, else the cash price. */
  prices: { cashFils: number; cashSource: "set" | "default"; cardFils: number; cardSource: "name" | "cash" };
  counted: boolean;
  cups: number;
  cupsPerDay: number | null;
  /** Unrounded — where the chart draws the bar against the server's tier lines. */
  cupsPerDayExact: number | null;
  /** Of the fleet average, cut down to the whole % — never shown above its tier's line. */
  vsAverage: number | null;
  tier: Tier | null;
  /** 1 = sold the most of the counted machines that sold — worked out by the server. */
  rank: number | null;
  cashCups: number;
  cashShare: number | null;
  tokenCups: number;
  incomeFils: number;
  before: { cups: number; cupsPerDay: number | null };
  compare: Compared | null;
  changePct: number | null;
  lastSaleAt: string | null;
  inTop80: boolean;
}

export interface CategoryPerf {
  category: string;
  machines: number;
  selling: number;
  noSales: number;
  cups: number;
  cupsPerDay: number | null;
  cupsPerMachineDay: number | null;
  share: number;
  incomeFils: number;
  cashShare: number | null;
  before: { cups: number; cupsPerDay: number | null; cupsPerMachineDay: number | null };
  /** On volume (cups per day), never on the per-machine level — over the days read on both sides. */
  compare: Compared | null;
  changePct: number | null;
  best: { assetNo: number | null; label: string; cupsPerDay: number } | null;
  weakest: { assetNo: number | null; label: string; cupsPerDay: number } | null;
  daily: { date: string; cupsPerMachine: number | null; before: number | null }[];
}

export interface Insight {
  id: string;
  tone: "good" | "bad" | "info";
  text: string;
  numbers: string[];
  action: { label: string; assetNos: number[] } | null;
}

export interface Performance {
  period: { from: string; to: string; days: number };
  before: { from: string; to: string; days: number; shiftDays: number };
  coverage: { read: string[]; notRead: string[]; beforeRead: string[]; beforeNotRead: string[]; compared: string[]; mirroredFrom: string | null };
  fleet: {
    machines: number;
    selling: number;
    cups: number;
    cupsPerDay: number | null;
    cupsPerMachineDay: number | null;
    /** Where the tiers begin, in cups a day (125 % and 75 % of the average) — the chart's dashed lines. */
    thresholds: { top: number; below: number } | null;
    incomeFils: number;
    cashShare: number | null;
    before: { cups: number; cupsPerDay: number | null; cupsPerMachineDay: number | null; cashShare: number | null };
    /** On volume (cups per day), never on the per-machine level — over the days read on both sides. */
    compare: Compared | null;
    changePct: number | null;
    cashCompare: { now: number; before: number; move: number } | null;
    cashShareMove: number | null;
    tiers: Record<Tier, { machines: number; cupsShare: number }>;
    top80: number;
    top80Share: number | null;
  };
  machines: MachinePerf[];
  categories: CategoryPerf[];
  insights: Insight[];
  /** The categories chosen (null = every one) and every category there is, for the buttons that choose (TASK-075). */
  selection: { categories: string[] | null; available: { category: string; machines: number; selling: number }[] };
}

/** How a cup was paid, as the server groups Televend's types: card = Cashless + Cashless 3 (TASK-075). */
export type PaymentKind = "cash" | "card" | "wallet" | "token" | "other";
export const PAYMENT_WORDS: Record<PaymentKind, string> = { cash: "Cash", card: "Card", wallet: "Wallet", token: "Token", other: "Other" };

export interface ProfileDay {
  date: string;
  /** Null when the store does not hold the day — not read, never zero. */
  cups: number | null;
  incomeFils: number | null;
  cashCups: number | null;
  /** The same weekday a week before, and the change against it in %. */
  lastWeek: { date: string; cups: number | null };
  changePct: number | null;
}

/** One scope — the categories chosen, a category, or a machine — over whole days (core/analytics-explore.ts). */
export interface SalesProfile {
  period: { from: string; to: string; days: number };
  before: { from: string; to: string; days: number; shiftDays: number };
  coverage: { read: string[]; notRead: string[]; beforeRead: string[]; compared: string[] };
  scope: {
    kind: "selection" | "category" | "machine";
    label: string;
    categories: string[] | null;
    category: string | null;
    machineKey: string | null;
    machineTvId: number | null;
    assetNo: number | null;
    machines: number;
  };
  totals: {
    cups: number;
    cupsPerDay: number | null;
    machinesSold: number;
    cupsPerMachineDay: number | null;
    incomeFils: number;
    incomePerDayFils: number | null;
    paidCups: number;
    avgPriceFils: number | null;
    cashShare: number | null;
    compare: Compared | null;
    incomeCompare: Compared | null;
    lastDay: { date: string; cups: number; lastWeek: { date: string; cups: number | null }; changePct: number | null } | null;
    peak: { hour: number; cups: number; share: number } | null;
    bestDay: { date: string; cups: number } | null;
    weakestDay: { date: string; cups: number } | null;
  };
  days: ProfileDay[];
  hours: { hour: number; now: number | null; before: number | null; nowCups: number; beforeCups: number }[];
  weekdays: { dow: number; label: string; days: number; cups: number; cupsPerDay: number | null }[];
  payments: { kind: PaymentKind; now: number; nowShare: number | null; before: number; beforeShare: number | null }[];
  insights: Insight[];
}

export type CompareMode = "days" | "periods" | "machines" | "categories";

export interface CompareRow {
  id: string;
  label: string;
  unit: "cups" | "fils" | "pct" | "count";
  a: number | null;
  b: number | null;
  /** B − A in the row's unit (points for a %). */
  diff: number | null;
  /** (B − A) ÷ A in %; null for a % row or when A is zero. */
  diffPct: number | null;
}

export interface SalesComparison {
  mode: CompareMode;
  a: SalesProfile;
  b: SalesProfile;
  rows: CompareRow[];
  hours: { hour: number; a: number | null; b: number | null }[];
  days: { date: string; a: number | null; b: number | null }[] | null;
  payments: { kind: PaymentKind; a: number | null; b: number | null }[];
  categories: { category: string; a: number | null; b: number | null; changePct: number | null }[] | null;
  movers: { key: string; label: string; assetNo: number | null; a: number; b: number; change: number }[] | null;
  insights: Insight[];
}

export type ProfileQuery =
  | { scope: "selection"; categories: string[] | null }
  | { scope: "category"; category: string }
  | { scope: "machine"; machine: string | number };

export type CompareQuery =
  | { mode: "days"; a: string; b: string; categories: string[] | null }
  | { mode: "periods"; a: { from: string; to: string }; b: { from: string; to: string }; categories: string[] | null }
  | { mode: "machines"; from: string; to: string; a: string | number; b: string | number }
  | { mode: "categories"; from: string; to: string; a: string; b: string };

/** The categories chosen travel as one JSON array — a category's name is free text. Absent = every category. */
const cats = (categories: string[] | null): Record<string, string> => (categories === null ? {} : { categories: JSON.stringify(categories) });

export interface MachineDaily {
  key: string;
  machineTvId: number;
  assetNo: number | null;
  label: string;
  days: { date: string; cups: number | null; weekBefore: number | null }[];
}

const P = (viewer: string) => ({ viewer });

export const analytics = {
  performance: (viewer: string, from: string, to: string, categories: string[] | null = null) =>
    get<Performance>("/dashboard/analytics/performance", { viewer, from, to, ...cats(categories) }),
  /** One scope's days beside the same weekday a week before, its hours, weekdays, payments and income (TASK-075). */
  profile: (viewer: string, from: string, to: string, q: ProfileQuery) =>
    get<SalesProfile>("/dashboard/analytics/profile", {
      viewer,
      from,
      to,
      scope: q.scope,
      ...(q.scope === "selection" ? cats(q.categories) : q.scope === "category" ? { category: q.category } : { machine: String(q.machine) }),
    }),
  /** Two days, periods, machines or categories side by side — the differences worked out by the server (TASK-075). */
  compare: (viewer: string, q: CompareQuery) =>
    get<SalesComparison>("/dashboard/analytics/compare", {
      viewer,
      mode: q.mode,
      ...(q.mode === "days"
        ? { a: q.a, b: q.b, ...cats(q.categories) }
        : q.mode === "periods"
          ? { aFrom: q.a.from, aTo: q.a.to, bFrom: q.b.from, bTo: q.b.to, ...cats(q.categories) }
          : { from: q.from, to: q.to, a: String(q.a), b: String(q.b) }),
    }),
  /** A machine by FreshNow's id, or a Televend record id for one FreshNow has no machine for: MachinePerf.machineId ?? machineTvId. */
  daily: (viewer: string, machine: string | number, from: string, to: string) =>
    get<MachineDaily>(`/dashboard/analytics/machines/${encodeURIComponent(String(machine))}/daily`, { viewer, from, to }),
  categories: (viewer: string) => get<string[]>("/dashboard/analytics/categories", P(viewer)),
  setCategory: (viewer: string, machine: string | number, category: string | null, note?: string) =>
    post<{ machineId: string; machineTvId: number | null; category: string; corrected: boolean }>(
      `/dashboard/analytics/machines/${encodeURIComponent(String(machine))}/category`,
      { category, ...(note ? { note } : {}) },
      P(viewer),
      "PUT",
    ),
};

export const TIER_WORDS: Record<Tier, string> = { top: "Top", average: "About average", below: "Below average", no_sales: "No sales" };
/** The diverging scale (index.css): blue above the average, gray about it, orange below. "No sales" has no bar. */
export const TIER_COLOR: Record<Tier, string> = {
  top: "var(--color-mark-accent)",
  average: "var(--color-mark-base)",
  below: "var(--color-mark-below)",
  no_sales: "var(--color-mark-crit)",
};
export const NOT_COUNTED = "Not counted";

/** "AED 1,234" from fils, rounded to the dirham — an estimate is never shown to the fils. */
export const aedRound = (fils: number): string => `AED ${Math.round(fils / 100).toLocaleString("en-GB")}`;
export const n1 = (n: number): string => n.toLocaleString("en-GB", { maximumFractionDigits: 1 });

/** A Dubai day, n days from today. */
export function dubaiDay(offset = 0): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Dubai" }).format(new Date(Date.now() + offset * 86_400_000));
}
export const addDays = (d: string, n: number): string => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
/** "AED 10.62" from fils — a price, to the fils. */
export const aedPrice = (fils: number): string => `AED ${(fils / 100).toFixed(2)}`;
/** "18:00". */
export const hourLabel = (h: number): string => `${String(h).padStart(2, "0")}:00`;
/** A change in %, signed: "+5.2 %", "−3 %"; "—" with nothing to compare. */
export const signedPct = (n: number | null): string => (n === null ? "—" : `${n > 0 ? "+" : n < 0 ? "−" : "±"}${n1(Math.abs(n))} %`);
/** "Mon 13 Oct". */
export const dayLabel = (d: string): string =>
  new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${d}T00:00:00Z`));
