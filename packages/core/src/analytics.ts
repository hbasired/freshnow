import { loadConfig } from "./config.js";
import { getServiceSql, withContext, type AppContext, type Tx } from "./db.js";
import { correlationOf } from "./inventory-common.js";
import { can, type Actor } from "./permissions.js";
import { localDate } from "./time.js";

/**
 * Machine performance and categories (TASK-070) — the first pages of the Analytics portal.
 *
 * The user's words (19 Oct, R8.2–8.4): "priority segmentation based on the volume of sales … which machines'
 * performance is well and which ones is below average based on sales and income", "for each machine … the trendline
 * of number of sales each day and previous weeks same day", and "for the entire segregation like expo or hospital or
 * mall aggregate sales should also be shown and plotted with key insights". Their answers (D248): categories are
 * Televend's regions with FreshNow's corrections; three tiers against the fleet average; income estimated from the
 * prices.
 *
 * Every machine's totals are counted by Postgres over the analytics store (TASK-071, sales_day), under the viewer's
 * row-level security (televend.read). This file adds machines into categories, sorts them into tiers and fills fixed
 * sentences with the figures — no model is involved, and no sentence states a number that is not in its own list.
 *
 * Fair comparisons only (the review of 20 Oct tightened each):
 *   - A day counts only when the store holds it: the sync read it to its end AND its count equalled Televend's own (a daily
 *     check or a backfill), and the store's build of it agrees. A day not read is reported as not read — never as a day with
 *     no sales — and yesterday waits for its check (from about 04:00).
 *   - Complete days only: the range ends yesterday at the latest. Today's picture is Operations → Now.
 *   - The period before is the same days of the week, whole weeks earlier; a change compares only the days read on both
 *     sides — a day and the same weekday `shiftDays` earlier — so a weekday mix never reads as a change.
 *   - A LEVEL is per machine that sold (so a broken machine does not drag the average down); a CHANGE is on volume — cups
 *     per day compared, from the totals, for every machine that sold in either period (one switched off since counts in
 *     "before"). Per-selling-machine changes said "sales rose 6.2 %" while cups fell 12 % (G210).
 *   - A machine is FreshNow's machine: a Televend record's sales count for the machine it stood in that day, so a machine
 *     re-registered in Televend under a new record is one machine, and one whose record was switched off keeps its
 *     category and price.
 */

/** A tier against the fleet average of cups per machine per day (the user's choice, D248). */
export type Tier = "top" | "average" | "below" | "no_sales";
/** At or above 125 % of the fleet average is "top"; below 75 % is "below" (D248). */
export const TOP_RATIO = 1.25;
export const BELOW_RATIO = 0.75;
/** The category that takes a machine out of the figures — a test machine, one not in public. */
export const NOT_COUNTED = "Not counted";
/** The longest range one request may ask for, in days — a bound on every query below (CLAUDE.md rule 4). */
export const MAX_RANGE_DAYS = 92;
/** The machines that make this share of all cups are "the 80 % set". */
const PARETO_SHARE = 0.8;

export class AnalyticsRefused extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = "AnalyticsRefused";
  }
}

export interface Period {
  from: string;
  to: string;
  days: number;
}

/**
 * Now against the same weekdays before, over the days read on both sides only (review of 20 Oct): cups per day on those
 * days, now and before, and the change worked out from the two totals.
 */
export interface Compared {
  /** How many days were compared: the period's days read whose same weekday `shiftDays` earlier was read too. */
  days: number;
  now: number;
  before: number;
  /** The change in % (0.1), from the totals; null when nothing was sold on the days before. */
  changePct: number | null;
}

export interface MachinePrices {
  /** A cash sale: the price set on the machine, else the default (AED 10). */
  cashFils: number;
  cashSource: "set" | "default";
  /** A card or wallet sale: the "AED 12" in the machine's Televend name, else the cash price (A-T70.3). */
  cardFils: number;
  cardSource: "name" | "cash";
}

export interface MachinePerf {
  /** Unique per row: FreshNow's machine id, else "tv:<Televend record>" — what a machine's own calls name it by. */
  key: string;
  /** The Televend record that stands for the machine now (its current one, else its latest) — two machines can share one. */
  machineTvId: number;
  /** FreshNow's machine; null for a Televend record FreshNow has no machine for yet. */
  machineId: string | null;
  assetNo: number | null;
  label: string;
  /** FreshNow's category: its correction, else Televend's region. */
  category: string;
  televendRegion: string | null;
  corrected: boolean;
  emirate: string | null;
  /** "Card only" in the machine's Televend name. */
  cardOnly: boolean;
  /** Not live in Televend now (switched off, or moved to a new record that is not live). */
  disabledNow: boolean;
  prices: MachinePrices;
  counted: boolean;
  cups: number;
  /** Cups per day read (0.1); null when no day of the period was read. */
  cupsPerDay: number | null;
  /** The same, unrounded — where the chart draws the bar, against the tier lines (thresholds are unrounded too). */
  cupsPerDayExact: number | null;
  /** cupsPerDay ÷ the fleet average, cut down to the whole % (so 124.96 % shows as 124 %, under "top"). */
  vsAverage: number | null;
  tier: Tier | null;
  /** 1 = sold the most of the counted machines that sold (ties: the lower number first). */
  rank: number | null;
  cashCups: number;
  /** Cash cups as a % of cups (0.1); null with no cups. */
  cashShare: number | null;
  tokenCups: number;
  /** Estimated: cash cups × the cash price + the other paid cups × the card price; token cups are not paid. */
  incomeFils: number;
  /** The days before that were compared: their cups, and per day. */
  before: { cups: number; cupsPerDay: number | null };
  compare: Compared | null;
  /** = compare.changePct: the change of cups per day against the same days before, in % (0.1). */
  changePct: number | null;
  lastSaleAt: string | null;
  /** One of the fewest machines that together made 80 % of the cups. */
  inTop80: boolean;
}

export interface CategoryPerf {
  category: string;
  /** Machines in the period: live now, or sold in it. */
  machines: number;
  selling: number;
  noSales: number;
  cups: number;
  /** Cups per day read — the category's volume. */
  cupsPerDay: number | null;
  /** Cups per machine that sold, per day read — the level categories are compared on. */
  cupsPerMachineDay: number | null;
  /** Share of all counted cups, in % (0.1). */
  share: number;
  incomeFils: number;
  /** Cash cups as a % of cups (0.1); null with no cups. */
  cashShare: number | null;
  /** The days before that were compared (every machine of the category then, one switched off since too). */
  before: { cups: number; cupsPerDay: number | null; cupsPerMachineDay: number | null };
  /** The volume, now against the same days before. */
  compare: Compared | null;
  changePct: number | null;
  best: { assetNo: number | null; label: string; cupsPerDay: number } | null;
  weakest: { assetNo: number | null; label: string; cupsPerDay: number } | null;
  /**
   * Cups for each day of the period, and for the same weekday before — both divided by the machines that sold in the
   * period, the same machines the headline divides by, so the two lines compare volumes (review, 20 Oct).
   */
  daily: { date: string; cupsPerMachine: number | null; before: number | null }[];
}

export interface Insight {
  id: string;
  tone: "good" | "bad" | "info";
  /** One sentence, its numbers taken from `numbers`. */
  text: string;
  /** Every figure the sentence states, as it appears in it — the numeric gate's evidence (CLAUDE.md). */
  numbers: string[];
  /** What to do about it, when there is something to do. */
  action: { label: string; assetNos: number[] } | null;
}

export interface Performance {
  period: Period;
  /** The same days of the week, `shiftDays` earlier. */
  before: Period & { shiftDays: number };
  coverage: {
    read: string[];
    notRead: string[];
    beforeRead: string[];
    beforeNotRead: string[];
    /** The period's days compared: read, with their same weekday before read too. */
    compared: string[];
    mirroredFrom: string | null;
  };
  fleet: {
    /** Machines in the period: live now, or sold in it. */
    machines: number;
    selling: number;
    cups: number;
    /** Cups per day read — the fleet's volume. */
    cupsPerDay: number | null;
    /** The fleet average the tiers are measured against: cups per machine that sold, per day read. */
    cupsPerMachineDay: number | null;
    /** Where the tiers begin, in cups a day: 125 % and 75 % of the average (unrounded, for the chart's lines). */
    thresholds: { top: number; below: number } | null;
    incomeFils: number;
    cashShare: number | null;
    /** The days before that were compared — every machine that sold then, one switched off since too. */
    before: { cups: number; cupsPerDay: number | null; cupsPerMachineDay: number | null; cashShare: number | null };
    compare: Compared | null;
    changePct: number | null;
    /** The cash share on the days compared, now and before, and its move in points (0.1). */
    cashCompare: { now: number; before: number; move: number } | null;
    cashShareMove: number | null;
    tiers: Record<Tier, { machines: number; cupsShare: number }>;
    top80: number;
    /** top80 as a % of the machines that sold (0.1). */
    top80Share: number | null;
  };
  machines: MachinePerf[];
  categories: CategoryPerf[];
  insights: Insight[];
  /**
   * The categories asked for — null for every category — and every category there is, so the buttons that choose can
   * show the ones left out too (TASK-075). With a choice, every figure above is of the chosen categories' machines only:
   * the average, the tiers, the ranks, the 80 % set and the sentences.
   */
  selection: { categories: string[] | null; available: { category: string; machines: number; selling: number }[] };
}

/** The most categories one request may name, and the longest name (a category is 1 to 60 characters). */
export const MAX_CATEGORIES = 100;

/** The categories asked for, tidied as a correction tidies a name; null = every category. Refused in words when malformed. */
export function checkCategories(categories: readonly string[] | null | undefined): string[] | null {
  if (categories === null || categories === undefined) return null;
  if (categories.length > MAX_CATEGORIES) throw new AnalyticsRefused(`At most ${MAX_CATEGORIES} categories at a time.`, 400, "bad_category");
  const tidy = categories.map((c) => c.replace(/\s+/g, " ").trim());
  if (tidy.some((c) => c.length < 1 || c.length > 60)) throw new AnalyticsRefused("A category is 1 to 60 characters.", 400, "bad_category");
  return [...new Set(tidy)].sort((a, b) => a.localeCompare(b));
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
export const addDays = (d: string, n: number): string => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const daysBetween = (a: string, b: string): number => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
export const r1 = (n: number): number => Math.round(n * 10) / 10;
export const pct = (part: number, whole: number): number | null => (whole > 0 ? r1((part / whole) * 100) : null);

/**
 * Where a machine stands against the fleet average: its rate ÷ the average = cups × machines that sold ÷ all their cups (the days
 * cancel). Worked on whole numbers, so the tier and the % shown agree exactly — at exactly 125 % it is top and shows 125 %, a
 * hair under shows 124 % (review of the fixes, 20 Oct: floating point put "125 %" beside "About average").
 */
export function standing(cups: number, selling: number, soldCups: number): { vsAverage: number; tier: Exclude<Tier, "no_sales"> } {
  const scaled = cups * selling * 100;
  const pctShown = Math.floor(scaled / soldCups);
  const tier = scaled >= Math.round(TOP_RATIO * 100) * soldCups ? "top" : scaled < Math.round(BELOW_RATIO * 100) * soldCups ? "below" : "average";
  return { vsAverage: pctShown / 100, tier };
}

/** Now against before over `days` days each, from the two totals — the change is never worked out from rounded rates. */
export function compared(nowCups: number, beforeCups: number, days: number): Compared | null {
  if (days <= 0) return null;
  return { days, now: r1(nowCups / days), before: r1(beforeCups / days), changePct: beforeCups > 0 ? r1(((nowCups - beforeCups) / beforeCups) * 100) : null };
}

/** The range asked for, checked: whole days that exist, the earlier first, ending yesterday at the latest, at most 92 days. */
export function checkRange(range: { from: string; to: string }, now: Date = new Date()): Period & { shiftDays: number } {
  const { from, to } = range;
  // A day that does not exist ("2031-02-29") rolls over in JavaScript: it must read back as itself (review, 20 Oct).
  const real = (d: string) => DAY.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`)) && addDays(d, 0) === d;
  if (!real(from) || !real(to)) {
    throw new AnalyticsRefused("Days are dates, YYYY-MM-DD.", 400, "bad_day");
  }
  if (from > to) throw new AnalyticsRefused("The first day comes before the last.", 400, "bad_range");
  const yesterday = addDays(localDate(now), -1);
  if (to > yesterday) throw new AnalyticsRefused("Analytics counts whole days — up to yesterday. Today so far is in Operations → Now.", 400, "not_whole_day");
  const days = daysBetween(from, to) + 1;
  if (days > MAX_RANGE_DAYS) throw new AnalyticsRefused(`At most ${MAX_RANGE_DAYS} days at a time.`, 400, "range_too_long");
  return { from, to, days, shiftDays: 7 * Math.ceil(days / 7) };
}

export function requireReader(viewer: Actor): void {
  if (!can(viewer, "televend.read")) throw new AnalyticsRefused("Analytics is for the people who run the machines.", 403, "not_allowed");
}

/** Which of these days the store holds in full: its latest build is good and agrees with Televend's own count. */
export async function storeDays(sql: Tx, from: string, to: string): Promise<Map<string, boolean>> {
  const rows = await sql<{ day: string; covered: boolean }[]>`
    with runs as (
      select distinct on (day) day, status, agrees from analytics_run
       where kind = 'sales_day' and day between ${from}::date and ${to}::date
       order by day, started_at desc
    )
    select to_char(d, 'YYYY-MM-DD') as day, coalesce(r.status = 'ok' and r.agrees is not false, false) as covered
      from generate_series(${from}::date, ${to}::date, interval '1 day') as d
      left join runs r on r.day = d::date
     order by d`;
  return new Map(rows.map((r) => [r.day, r.covered]));
}

/**
 * Each Televend record's sales on the days given, from the store, credited to the FreshNow machine it stood in that day
 * (review, 20 Oct: a machine re-registered in Televend was split in two, and one whose record was switched off lost its
 * category and price). The placement in force at the end of the day counts; a record's first placement reaches back to
 * its first sale (placements began with the first sync, the sales go back months) and its last one forward. A record
 * never placed counts for the machine with its number; one with no number stays itself ("tv:<id>").
 */
const placements = (sql: Tx) => sql`
  pl as (
    select p.tv_machine_id, p.machine_id,
           case when p.valid_from = min(p.valid_from) over (partition by p.tv_machine_id) then '-infinity'::timestamptz else p.valid_from end as from_t,
           lead(p.valid_from) over (partition by p.tv_machine_id order by p.valid_from) as to_t
      from machine_placement p
  )`;
export const attributed = (sql: Tx, days: readonly string[]) => sql`
  ${placements(sql)},
  att as (
    select s.day, s.machine_tv_id, s.cups, s.cash_cups, s.cashless_cups, s.cashless3_cups, s.token_cups, s.wallet_cups, s.other_cups, s.last_sale_at,
           coalesce(pl.machine_id, (select m.id from tv_machine t join machine m on m.asset_no = t.asset_no where t.televend_id = s.machine_tv_id)) as machine_id
      from sales_day s
      left join pl on pl.tv_machine_id = s.machine_tv_id
                  and pl.from_t < ((s.day + 1)::timestamp at time zone 'Asia/Dubai')
                  and (pl.to_t is null or ((s.day + 1)::timestamp at time zone 'Asia/Dubai') <= pl.to_t)
     where s.day = any(${days}::date[])
  )`;
/**
 * The same for each hour of those days (sales_hour, TASK-075): an hour's cups go to the machine its day's cups go to — the
 * placement in force at the end of the day — so the hours of a machine always add up to its day.
 */
export const attributedHours = (sql: Tx, days: readonly string[]) => sql`
  ${placements(sql)},
  atth as (
    select h.day, h.machine_tv_id, h.hour, h.cups,
           coalesce(pl.machine_id, (select m.id from tv_machine t join machine m on m.asset_no = t.asset_no where t.televend_id = h.machine_tv_id)) as machine_id
      from sales_hour h
      left join pl on pl.tv_machine_id = h.machine_tv_id
                  and pl.from_t < ((h.day + 1)::timestamp at time zone 'Asia/Dubai')
                  and (pl.to_t is null or ((h.day + 1)::timestamp at time zone 'Asia/Dubai') <= pl.to_t)
     where h.day = any(${days}::date[])
  )`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A machine, named by FreshNow's id or by a Televend record (a record that moved between two machines stands for both;
 * the id says which). Refused in words when it is neither.
 */
export function machineRef(machine: string | number): { machineId: string } | { tvId: number } {
  if (typeof machine === "string" && UUID.test(machine)) return { machineId: machine.toLowerCase() };
  const n = typeof machine === "number" ? machine : /^\d{1,15}$/.test(machine) ? Number(machine) : NaN;
  if (!Number.isSafeInteger(n) || n <= 0) throw new AnalyticsRefused("No such machine.", 404, "no_machine");
  return { tvId: n };
}

/** The Televend record that stands for a FreshNow machine now: its open placement, else its latest. */
const recordOfMachine = (sql: Tx, machineId: string) => sql`
  select m.id as machine_id, m.asset_no, m.label, t.televend_id, t.caption, t.region_caption
    from machine m
    left join lateral (select p.tv_machine_id from machine_placement p where p.machine_id = m.id
                        order by (p.valid_to is null) desc, p.valid_from desc limit 1) pl on true
    left join tv_machine t on t.televend_id = coalesce(pl.tv_machine_id, (select t2.televend_id from tv_machine t2 where t2.asset_no = m.asset_no
                                                                          order by t2.enabled desc, t2.televend_id desc limit 1))
   where m.id = ${machineId}`;

/** The machine a Televend record stands for: its latest placement, open or closed, else the machine with its number. */
export const machineOfRecord = (sql: Tx, tvId: number) => sql`
  select t.televend_id, t.caption, t.asset_no as tv_asset_no, t.region_caption,
         coalesce((select p.machine_id from machine_placement p where p.tv_machine_id = t.televend_id
                    order by (p.valid_to is null) desc, p.valid_from desc limit 1),
                  (select m.id from machine m where m.asset_no = t.asset_no)) as machine_id
    from tv_machine t where t.televend_id = ${tvId}`;

/**
 * Each machine's facts now (TASK-070, shared since TASK-075): every machine with a sale in `att` (defined before it) and
 * every machine live now — its Televend record now, number, name, category (FreshNow's correction, else Televend's
 * region), set price and whether it is live. The performance and the profiles both read it, so a machine is the same
 * machine, in the same category, at the same price, on every page.
 */
export const machineInfo = (sql: Tx) => sql`
  -- Each Televend record's FreshNow machine now: its open placement, else its latest one — the machines sync closes a
  -- placement made by hand for a record with no number, and the record still stands for that machine (review of the
  -- fixes, 20 Oct) — else the machine with its number.
  rec as (
    select t.televend_id, t.enabled,
           coalesce((select p.machine_id from machine_placement p where p.tv_machine_id = t.televend_id
                      order by (p.valid_to is null) desc, p.valid_from desc limit 1),
                    (select m.id from machine m where m.asset_no = t.asset_no)) as machine_id
      from tv_machine t
  ),
  -- Every machine with a sale on a day read, and every machine live now (for "no sales").
  keys as (
    select distinct coalesce(a.machine_id::text, 'tv:' || a.machine_tv_id::text) as key, a.machine_id from att a
    union
    select coalesce(rec.machine_id::text, 'tv:' || rec.televend_id::text), rec.machine_id from rec where rec.enabled
  ),
  rep as (
    select k.key, k.machine_id,
           coalesce((select p.tv_machine_id from machine_placement p where p.machine_id = k.machine_id
                      order by (p.valid_to is null) desc, p.valid_from desc limit 1),
                    (select t.televend_id from tv_machine t join machine m on m.asset_no = t.asset_no where m.id = k.machine_id
                      order by t.enabled desc, t.televend_id desc limit 1),
                    case when k.machine_id is null then substring(k.key from 4)::bigint end) as tv_id
      from keys k
  ),
  info as (
    select r.key, r.machine_id, r.tv_id, coalesce(m.asset_no, t.asset_no) as asset_no, coalesce(m.label, t.caption, 'Machine') as label,
           coalesce(m.category_override, t.region_caption, 'No category') as category, t.region_caption as region,
           (m.category_override is not null) as corrected, t.caption, m.cash_price_fils,
           -- Live when any record that stands for it now is live.
           case when r.machine_id is null then coalesce(t.enabled, false)
                else exists (select 1 from rec where rec.machine_id = r.machine_id and rec.enabled) end as enabled
      from rep r left join machine m on m.id = r.machine_id left join tv_machine t on t.televend_id = r.tv_id
     where r.tv_id is not null
  )`;

/** The "AED 12" in the machine's Televend name (else its label), in fils — a whole word "AED" only (review, 20 Oct). */
export const namePrice = (sql: Tx) => sql`(regexp_match(coalesce(i.caption, i.label), '\\maed\\s*([0-9]{1,3})\\M', 'i'))[1]::int * 100`;

interface Row {
  key: string;
  machine_id: string | null;
  machine_tv_id: string | null;
  asset_no: number | null;
  label: string;
  category: string;
  region: string | null;
  corrected: boolean;
  emirate_code: string | null;
  card_only: boolean;
  enabled: boolean;
  set_price: number | null;
  name_price: number | null;
  cups: number;
  cash_cups: number;
  token_cups: number;
  pair_cups: number;
  pair_cash_cups: number;
  before_cups: number;
  before_cash_cups: number;
  last_sale_at: Date | null;
}

const EMIRATE: Readonly<Record<string, string>> = { DXB: "Dubai", SHJ: "Sharjah", AJM: "Ajman", UAQ: "Umm Al Quwain" };

/**
 * Machines, tiers, categories and what they say — for a range of whole days, and for the categories chosen (TASK-075:
 * "when one category like expo needs to be removed then I can unselect the button and the full analysis is shown … without
 * including expo"). Null or no `categories` = every category.
 */
export async function machinePerformance(
  viewer: AppContext & Actor,
  range: { from: string; to: string },
  now: Date = new Date(),
  opts: { categories?: readonly string[] | null } = {},
): Promise<Performance> {
  requireReader(viewer);
  const p = checkRange(range, now);
  const chosen = checkCategories(opts.categories);
  const before = { from: addDays(p.from, -p.shiftDays), to: addDays(p.to, -p.shiftDays), days: p.days, shiftDays: p.shiftDays };
  const defaultPrice = loadConfig().OPS_DEFAULT_CASH_PRICE_FILS;
  const periodDays = Array.from({ length: p.days }, (_, i) => addDays(p.from, i));
  const beforeDays = periodDays.map((d) => addDays(d, -p.shiftDays));

  const { held, rows, daily, mirroredFrom } = await withContext(
    viewer,
    async (sql) => {
      const held = new Map([...(await storeDays(sql, before.from, before.to)), ...(await storeDays(sql, p.from, p.to))]);
      const readNow = periodDays.filter((d) => held.get(d));
      const readBefore = beforeDays.filter((d) => held.get(d));
      const pairNow = readNow.filter((d) => held.get(addDays(d, -p.shiftDays)));
      const pairBefore = pairNow.map((d) => addDays(d, -p.shiftDays));
      const [first] = await sql<{ day: string | null }[]>`
        select to_char(min(day), 'YYYY-MM-DD') as day from analytics_run where kind = 'sales_day' and status = 'ok'`;
      const base = sql`
        with ${attributed(sql, [...readNow, ...readBefore])},
        per as (
          select coalesce(a.machine_id::text, 'tv:' || a.machine_tv_id::text) as key, a.machine_id,
                 coalesce(sum(a.cups) filter (where a.day = any(${readNow}::date[])), 0)::int as cups,
                 coalesce(sum(a.cash_cups) filter (where a.day = any(${readNow}::date[])), 0)::int as cash_cups,
                 coalesce(sum(a.token_cups) filter (where a.day = any(${readNow}::date[])), 0)::int as token_cups,
                 coalesce(sum(a.cups) filter (where a.day = any(${pairNow}::date[])), 0)::int as pair_cups,
                 coalesce(sum(a.cash_cups) filter (where a.day = any(${pairNow}::date[])), 0)::int as pair_cash_cups,
                 coalesce(sum(a.cups) filter (where a.day = any(${pairBefore}::date[])), 0)::int as before_cups,
                 coalesce(sum(a.cash_cups) filter (where a.day = any(${pairBefore}::date[])), 0)::int as before_cash_cups,
                 max(a.last_sale_at) filter (where a.day = any(${readNow}::date[])) as last_sale_at
            from att a group by 1, 2
        ),
        ${machineInfo(sql)}`;
      const rows = await sql<Row[]>`
        ${base}
        select i.key, i.machine_id::text as machine_id, i.tv_id::text as machine_tv_id, i.asset_no, i.label, i.category, i.region, i.corrected,
               upper(substring(i.caption from '-\\s*([A-Za-z]{3})\\s*$')) as emirate_code,
               coalesce(i.caption ~* '\\mcard\\M', false) as card_only,
               i.enabled,
               i.cash_price_fils as set_price,
               ${namePrice(sql)} as name_price,
               coalesce(per.cups, 0) as cups, coalesce(per.cash_cups, 0) as cash_cups, coalesce(per.token_cups, 0) as token_cups,
               coalesce(per.pair_cups, 0) as pair_cups, coalesce(per.pair_cash_cups, 0) as pair_cash_cups,
               coalesce(per.before_cups, 0) as before_cups, coalesce(per.before_cash_cups, 0) as before_cash_cups,
               per.last_sale_at
          from info i left join per on per.key = i.key
         order by i.asset_no nulls last, i.tv_id`;
      // Each category's cups per day read, the period and the period before (for its small chart).
      const daily = await sql<{ category: string; day: string; cups: number }[]>`
        ${base}
        select i.category, to_char(a.day, 'YYYY-MM-DD') as day, sum(a.cups)::int as cups
          from att a join info i on i.key = coalesce(a.machine_id::text, 'tv:' || a.machine_tv_id::text)
         group by 1, 2`;
      return { held, rows, daily, mirroredFrom: first?.day ?? null };
    },
    { readOnly: true },
  );

  const readNow = periodDays.filter((d) => held.get(d));
  const readBefore = beforeDays.filter((d) => held.get(d));
  const pairNow = readNow.filter((d) => held.get(addDays(d, -p.shiftDays)));
  const nDays = readNow.length;
  const nPairs = pairNow.length;

  // ── per machine ────────────────────────────────────────────────────────────
  // The compared days' cups and cash cups, per machine, for the fleet's and the categories' totals.
  const paired = new Map<MachinePerf, { cups: number; cash: number; beforeCash: number }>();
  const machines: MachinePerf[] = [];
  for (const r of rows) {
    if (r.machine_tv_id === null) continue;
    const counted = r.category !== NOT_COUNTED;
    const cashFils = r.set_price ?? defaultPrice;
    const cardFils = r.name_price ?? cashFils;
    const compare = compared(r.pair_cups, r.before_cups, nPairs);
    const m: MachinePerf = {
      key: r.key,
      machineTvId: Number(r.machine_tv_id),
      machineId: r.machine_id,
      assetNo: r.asset_no,
      label: r.label,
      category: r.category,
      televendRegion: r.region,
      corrected: r.corrected,
      emirate: r.emirate_code ? (EMIRATE[r.emirate_code] ?? null) : null,
      cardOnly: r.card_only,
      disabledNow: !r.enabled,
      prices: { cashFils, cashSource: r.set_price === null ? "default" : "set", cardFils, cardSource: r.name_price === null ? "cash" : "name" },
      counted,
      cups: r.cups,
      cupsPerDay: nDays > 0 ? r1(r.cups / nDays) : null,
      cupsPerDayExact: nDays > 0 ? r.cups / nDays : null,
      vsAverage: null,
      tier: null,
      rank: null,
      cashCups: r.cash_cups,
      cashShare: pct(r.cash_cups, r.cups),
      tokenCups: r.token_cups,
      incomeFils: r.cash_cups * cashFils + (r.cups - r.cash_cups - r.token_cups) * cardFils,
      before: { cups: r.before_cups, cupsPerDay: compare ? compare.before : null },
      compare,
      changePct: compare?.changePct ?? null,
      lastSaleAt: r.last_sale_at ? r.last_sale_at.toISOString() : null,
      inTop80: false,
    };
    paired.set(m, { cups: r.pair_cups, cash: r.pair_cash_cups, beforeCash: r.before_cash_cups });
    machines.push(m);
  }

  // Every category there is, for the buttons — counted before the choice, so a category left out still shows.
  const everyCounted = machines.filter((m) => m.counted);
  const available = [...new Set(everyCounted.map((m) => m.category))]
    .sort((a, b) => a.localeCompare(b))
    .map((category) => {
      const ms = everyCounted.filter((m) => m.category === category && (!m.disabledNow || m.cups > 0));
      return { category, machines: ms.length, selling: ms.filter((m) => m.cups > 0).length };
    });
  const inChoice = (m: MachinePerf) => chosen === null || chosen.includes(m.category);

  // ── the fleet: the average over counted machines that sold, the tiers, the 80 % set ──
  // "The fleet" is the machines of the categories chosen: every figure below follows the choice.
  const counted = everyCounted.filter(inChoice);
  // In the period: live now, or sold in it. A machine switched off since that sold only before counts in "before" only.
  const live = counted.filter((m) => !m.disabledNow || m.cups > 0);
  const selling = live.filter((m) => m.cups > 0);
  const totalCups = live.reduce((t, m) => t + m.cups, 0);
  const average = nDays > 0 && selling.length > 0 ? totalCups / nDays / selling.length : null;
  for (const m of live) {
    if (nDays === 0) continue;
    if (m.cups === 0) {
      m.tier = "no_sales";
      continue;
    }
    // Cut down, never rounded up, and decided on the same whole numbers: the % shown never crosses its tier's line.
    const st = standing(m.cups, selling.length, totalCups);
    m.vsAverage = st.vsAverage;
    m.tier = st.tier;
  }
  // By cups (ties by asset number, then record), so the ranks and the 80 % set are the same every run.
  const ranked = [...selling].sort((a, b) => b.cups - a.cups || (a.assetNo ?? 1e9) - (b.assetNo ?? 1e9) || a.machineTvId - b.machineTvId);
  ranked.forEach((m, i) => (m.rank = i + 1));
  let running = 0;
  for (const m of ranked) {
    if (running >= PARETO_SHARE * totalCups) break;
    m.inTop80 = true;
    running += m.cups;
  }
  const tierStat = (t: Tier) => {
    const ms = live.filter((m) => m.tier === t);
    return { machines: ms.length, cupsShare: pct(ms.reduce((s, m) => s + m.cups, 0), totalCups) ?? 0 };
  };
  const sum = (ms: MachinePerf[], f: (m: MachinePerf) => number) => ms.reduce((t, m) => t + f(m), 0);
  const fleetPairNow = sum(counted, (m) => paired.get(m)?.cups ?? 0);
  const fleetPairBefore = sum(counted, (m) => m.before.cups);
  const fleetCashNow = sum(counted, (m) => paired.get(m)?.cash ?? 0);
  const fleetCashBefore = sum(counted, (m) => paired.get(m)?.beforeCash ?? 0);
  const sellingBefore = counted.filter((m) => m.before.cups > 0).length;
  const fleetCompare = compared(fleetPairNow, fleetPairBefore, nPairs);
  const cashCompare =
    nPairs > 0 && fleetPairNow > 0 && fleetPairBefore > 0
      ? {
          now: r1((fleetCashNow / fleetPairNow) * 100),
          before: r1((fleetCashBefore / fleetPairBefore) * 100),
          move: r1((fleetCashNow / fleetPairNow - fleetCashBefore / fleetPairBefore) * 100),
        }
      : null;
  const top80 = live.filter((m) => m.inTop80).length;
  const fleet: Performance["fleet"] = {
    machines: live.length,
    selling: selling.length,
    cups: totalCups,
    cupsPerDay: nDays > 0 ? r1(totalCups / nDays) : null,
    cupsPerMachineDay: average === null ? null : r1(average),
    thresholds: average === null ? null : { top: average * TOP_RATIO, below: average * BELOW_RATIO },
    incomeFils: sum(live, (m) => m.incomeFils),
    cashShare: pct(sum(live, (m) => m.cashCups), totalCups),
    before: {
      cups: fleetPairBefore,
      cupsPerDay: fleetCompare ? fleetCompare.before : null,
      cupsPerMachineDay: nPairs > 0 && sellingBefore > 0 ? r1(fleetPairBefore / nPairs / sellingBefore) : null,
      cashShare: pct(fleetCashBefore, fleetPairBefore),
    },
    // On volume, never on the per-machine average (see the head of this file).
    compare: fleetCompare,
    changePct: fleetCompare?.changePct ?? null,
    cashCompare,
    cashShareMove: cashCompare?.move ?? null,
    tiers: { top: tierStat("top"), average: tierStat("average"), below: tierStat("below"), no_sales: tierStat("no_sales") },
    top80,
    top80Share: selling.length > 0 ? r1((top80 / selling.length) * 100) : null,
  };

  // ── categories ────────────────────────────────────────────────────────────
  const names = [...new Set(counted.map((m) => m.category))];
  const perDay = new Map<string, number>();
  for (const d of daily) perDay.set(`${d.category}|${d.day}`, d.cups);
  const isRead = new Set(readNow);
  const wasRead = new Set(readBefore);
  const categories: CategoryPerf[] = names.map((name) => {
    const all = counted.filter((m) => m.category === name);
    const ms = live.filter((m) => m.category === name);
    const sell = ms.filter((m) => m.cups > 0);
    const cups = sum(ms, (m) => m.cups);
    const pairNowCups = sum(all, (m) => paired.get(m)?.cups ?? 0);
    const pairBeforeCups = sum(all, (m) => m.before.cups);
    const bSelling = all.filter((m) => m.before.cups > 0).length;
    const compare = compared(pairNowCups, pairBeforeCups, nPairs);
    const order = [...sell].sort((a, b) => (b.cupsPerDay ?? 0) - (a.cupsPerDay ?? 0) || (a.assetNo ?? 1e9) - (b.assetNo ?? 1e9));
    const pick = (m: MachinePerf | undefined) => (m && m.cupsPerDay !== null ? { assetNo: m.assetNo, label: m.label, cupsPerDay: m.cupsPerDay } : null);
    return {
      category: name,
      machines: ms.length,
      selling: sell.length,
      noSales: ms.filter((m) => m.tier === "no_sales").length,
      cups,
      cupsPerDay: nDays > 0 ? r1(cups / nDays) : null,
      cupsPerMachineDay: nDays > 0 && sell.length > 0 ? r1(cups / nDays / sell.length) : null,
      share: pct(cups, totalCups) ?? 0,
      incomeFils: sum(ms, (m) => m.incomeFils),
      cashShare: pct(sum(ms, (m) => m.cashCups), cups),
      before: { cups: pairBeforeCups, cupsPerDay: compare ? compare.before : null, cupsPerMachineDay: nPairs > 0 && bSelling > 0 ? r1(pairBeforeCups / nPairs / bSelling) : null },
      // On volume: every machine of the category, before and now.
      compare,
      changePct: compare?.changePct ?? null,
      best: pick(order[0]),
      weakest: order.length > 1 ? pick(order[order.length - 1]) : null,
      daily: periodDays.map((date) => {
        const earlier = addDays(date, -p.shiftDays);
        return {
          date,
          cupsPerMachine: isRead.has(date) && sell.length > 0 ? r1((perDay.get(`${name}|${date}`) ?? 0) / sell.length) : null,
          before: wasRead.has(earlier) && sell.length > 0 ? r1((perDay.get(`${name}|${earlier}`) ?? 0) / sell.length) : null,
        };
      }),
    };
  });
  // Most cups per machine first; a category with no rate last, by name — the same order every run.
  categories.sort((a, b) => (b.cupsPerMachineDay ?? -1) - (a.cupsPerMachineDay ?? -1) || a.category.localeCompare(b.category));

  return {
    period: { from: p.from, to: p.to, days: p.days },
    before,
    coverage: {
      read: readNow,
      notRead: periodDays.filter((d) => !held.get(d)),
      beforeRead: readBefore,
      beforeNotRead: beforeDays.filter((d) => !held.get(d)),
      compared: pairNow,
      mirroredFrom,
    },
    fleet,
    // The machines of the categories chosen, and the machines left out of every figure (listed apart, to correct).
    machines: machines.filter((m) => !m.counted || inChoice(m)),
    categories,
    insights: insightsOf({ fleet, machines: counted, categories, nDays, chosen: chosen !== null }),
    selection: { categories: chosen, available },
  };
}

// ── what the figures say ─────────────────────────────────────────────────────
/** A machine that sold at least this many cups a day before, and fell by this share, is "a sharp drop". */
const DROP_MIN_BEFORE_PER_DAY = 10;
const DROP_SHARE = -40;
/** A category moving this much against the period before is worth a sentence. */
const CATEGORY_MOVE = 15;
/** The most machines one sentence names. */
const NAMED = 6;

export const fmt = (n: number): string => n.toLocaleString("en-GB", { maximumFractionDigits: 1 });
export const nameOf = (m: { assetNo: number | null; label: string }): string => (m.assetNo ? `${m.label} (${m.assetNo})` : m.label);
/** Machines named in a sentence — at most six, then "and K more" — with the figures the words state. */
const listOf = (ms: { assetNo: number | null; label: string }[]): { text: string; numbers: string[] } =>
  ms.length <= NAMED
    ? { text: ms.map(nameOf).join(", "), numbers: [] }
    : { text: `${ms.slice(0, NAMED).map(nameOf).join(", ")} and ${ms.length - NAMED} more`, numbers: [String(ms.length - NAMED)] };

/**
 * Fixed sentences filled from the figures above, most urgent first: machines to check, then the trend, then where
 * sales come from. Each carries the numbers it states, exactly as written.
 */
export function insightsOf(x: {
  fleet: Performance["fleet"];
  machines: MachinePerf[];
  categories: CategoryPerf[];
  nDays: number;
  /** Some categories only: the average is theirs, and the sentences say so rather than "the fleet's". */
  chosen?: boolean;
}): Insight[] {
  const out: Insight[] = [];
  if (x.nDays === 0) return out;
  const { fleet } = x;
  const byNumber = (a: MachinePerf, b: MachinePerf) => (a.assetNo ?? 1e9) - (b.assetNo ?? 1e9);

  const silent = x.machines.filter((m) => m.tier === "no_sales").sort(byNumber);
  if (silent.length > 0) {
    const n = String(silent.length);
    const list = listOf(silent);
    out.push({
      id: "no_sales",
      tone: "bad",
      text: `${n} machine${silent.length === 1 ? "" : "s"} sold nothing in the period: ${list.text}.`,
      numbers: [n, ...list.numbers],
      action: { label: "Check each: power, connection, stock and the payment reader", assetNos: silent.flatMap((m) => (m.assetNo ? [m.assetNo] : [])) },
    });
  }

  // Switched off since: their cups are in the figures before, none now — said, so a fall is not a mystery.
  const gone = x.machines.filter((m) => m.disabledNow && m.cups === 0 && m.before.cups > 0).sort(byNumber);
  if (gone.length > 0) {
    const n = String(gone.length);
    const list = listOf(gone);
    out.push({
      id: "switched_off",
      tone: "info",
      text: `${n} machine${gone.length === 1 ? "" : "s"} that sold on the days before ${gone.length === 1 ? "is" : "are"} switched off in Televend now: ${list.text}. ${gone.length === 1 ? "Its" : "Their"} cups count in the figures before, so the change includes ${gone.length === 1 ? "it" : "them"}.`,
      numbers: [n, ...list.numbers],
      action: null,
    });
  }

  const drops = x.machines
    .filter((m) => !m.disabledNow && m.compare !== null && m.compare.changePct !== null && m.compare.changePct <= DROP_SHARE && m.compare.before >= DROP_MIN_BEFORE_PER_DAY)
    .sort((a, b) => (a.compare!.changePct ?? 0) - (b.compare!.changePct ?? 0) || byNumber(a, b));
  for (const m of drops.slice(0, 3)) {
    const c = m.compare!;
    const was = fmt(c.before);
    const is = fmt(c.now);
    const by = fmt(Math.abs(c.changePct ?? 0));
    out.push({
      id: `drop:${m.machineTvId}`,
      tone: "bad",
      text: `${nameOf(m)} fell from ${was} to ${is} cups a day (−${by} %).`,
      numbers: [was, is, by],
      action: { label: "Open the machine: its alarms, refills and stock", assetNos: m.assetNo ? [m.assetNo] : [] },
    });
  }

  const fc = fleet.compare;
  if (fc && fc.changePct !== null) {
    const now = fmt(fc.now);
    const was = fmt(fc.before);
    const by = fmt(Math.abs(fc.changePct));
    const same = Math.abs(fc.changePct) < 5;
    // When some days could not be compared, the sentence says on how many it rests.
    const partial = fc.days < x.nDays;
    const on = partial ? ` (the ${fc.days} days read in both periods)` : "";
    out.push({
      id: "trend",
      tone: same ? "info" : fc.changePct > 0 ? "good" : "bad",
      text: same
        ? `Cups sold held steady: ${now} a day, against ${was} a day on the same days before${on}.`
        : `Cups sold ${fc.changePct > 0 ? "rose" : "fell"} ${by} %: ${now} a day, against ${was} a day on the same days before${on}.`,
      numbers: [...(same ? [now, was] : [by, now, was]), ...(partial ? [String(fc.days)] : [])],
      action: null,
    });
  }

  if (fleet.selling > 0 && fleet.top80 > 0 && fleet.top80Share !== null) {
    const n = String(fleet.top80);
    const of = String(fleet.selling);
    const share = fmt(fleet.top80Share);
    out.push({
      id: "top80",
      tone: "info",
      text: `${n} of the ${of} machines that sold (${share} %) made 80 % of the cups.`,
      numbers: [n, of, share, "80"],
      action: null,
    });
  }

  // Of the categories where two or more machines sold: a one-machine category is that machine (review, 20 Oct: the
  // sentence named another "most" than the chart, which shows every category).
  const rated = x.categories.filter((c) => c.cupsPerMachineDay !== null && c.selling >= 2);
  if (rated.length >= 2 && fleet.cupsPerMachineDay) {
    const best = rated[0]!;
    const worst = rated[rated.length - 1]!;
    const bv = fmt(best.cupsPerMachineDay!);
    const avg = fmt(fleet.cupsPerMachineDay);
    // From the two figures the sentence shows, so it can be checked from them.
    const times = fmt(r1(best.cupsPerMachineDay! / fleet.cupsPerMachineDay));
    out.push({
      id: "best_category",
      tone: "good",
      text: `Of the categories where two or more machines sold, ${best.category} sells the most per machine: ${bv} cups a day — ${times}× the ${x.chosen ? "chosen categories'" : "fleet's"} ${avg}.`,
      numbers: [bv, times, avg],
      action: null,
    });
    const wv = fmt(worst.cupsPerMachineDay!);
    out.push({
      id: "weakest_category",
      tone: "info",
      text: `Of the categories where two or more machines sold, ${worst.category} sells the least per machine: ${wv} cups a day across ${worst.selling} machines.`,
      numbers: [wv, String(worst.selling)],
      action: null,
    });
  }

  for (const c of x.categories) {
    const cc = c.compare;
    if (!cc || cc.changePct === null || Math.abs(cc.changePct) < CATEGORY_MOVE || c.selling < 2) continue;
    const by = fmt(Math.abs(cc.changePct));
    const now = fmt(cc.now);
    const was = fmt(cc.before);
    out.push({
      id: `category_move:${c.category}`,
      tone: cc.changePct > 0 ? "good" : "bad",
      text: `${c.category} sold ${by} % ${cc.changePct > 0 ? "more" : "fewer"} cups a day than on the same days before: ${now} against ${was}.`,
      numbers: [by, now, was],
      action: null,
    });
  }

  const cash = fleet.cashCompare;
  if (cash && Math.abs(cash.move) >= 5) {
    const now = fmt(cash.now);
    const was = fmt(cash.before);
    const by = fmt(Math.abs(cash.move));
    out.push({
      id: "cash_share",
      tone: "info",
      text: `Cash was ${now} % of cups, ${cash.move > 0 ? "up" : "down"} ${by} points from ${was} %.`,
      numbers: [now, by, was],
      action: null,
    });
  }
  return out;
}

// ── one machine, day by day ──────────────────────────────────────────────────
export interface MachineDaily {
  key: string;
  machineTvId: number;
  assetNo: number | null;
  label: string;
  /** Each day of the range with the same weekday a week earlier; null where the store does not hold the day. */
  days: { date: string; cups: number | null; weekBefore: number | null }[];
}

/**
 * One machine's cups each day of the range, beside the same weekday a week before (R8.3) — every Televend record it had.
 * Named by FreshNow's machine id (MachinePerf.key) or a Televend record.
 */
export async function machineDaily(
  viewer: AppContext & Actor,
  machine: string | number,
  range: { from: string; to: string },
  now: Date = new Date(),
): Promise<MachineDaily | null> {
  requireReader(viewer);
  const p = checkRange(range, now);
  const ref = machineRef(machine);
  const start = addDays(p.from, -7);
  return withContext(
    viewer,
    async (sql) => {
      let found: { key: string; tvId: number; assetNo: number | null; label: string } | null = null;
      if ("machineId" in ref) {
        const [m] = await sql<{ machine_id: string; asset_no: number | null; label: string; televend_id: string | null }[]>`${recordOfMachine(sql, ref.machineId)}`;
        if (m && m.televend_id) found = { key: m.machine_id, tvId: Number(m.televend_id), assetNo: m.asset_no, label: m.label };
      } else {
        const [rec] = await sql<{ televend_id: string; caption: string; tv_asset_no: number | null; machine_id: string | null }[]>`${machineOfRecord(sql, ref.tvId)}`;
        if (rec) {
          const [m] = rec.machine_id ? await sql<{ asset_no: number | null; label: string }[]>`select asset_no, label from machine where id = ${rec.machine_id}` : [];
          found = { key: rec.machine_id ?? `tv:${rec.televend_id}`, tvId: Number(rec.televend_id), assetNo: m?.asset_no ?? rec.tv_asset_no, label: m?.label ?? rec.caption };
        }
      }
      if (!found) return null;
      const held = await storeDays(sql, start, p.to);
      const read = [...held].filter(([, ok]) => ok).map(([d]) => d);
      const key = found.key;
      const rows = await sql<{ day: string; cups: number }[]>`
        with ${attributed(sql, read)}
        select to_char(a.day, 'YYYY-MM-DD') as day, sum(a.cups)::int as cups
          from att a where coalesce(a.machine_id::text, 'tv:' || a.machine_tv_id::text) = ${key}
         group by 1`;
      const cupsOn = new Map(rows.map((r) => [r.day, r.cups]));
      const at = (d: string): number | null => (held.get(d) ? (cupsOn.get(d) ?? 0) : null);
      return {
        key,
        machineTvId: found.tvId,
        assetNo: found.assetNo,
        label: found.label,
        days: Array.from({ length: p.days }, (_, i) => {
          const date = addDays(p.from, i);
          return { date, cups: at(date), weekBefore: at(addDays(date, -7)) };
        }),
      };
    },
    { readOnly: true },
  );
}

// ── correcting a machine's category ─────────────────────────────────────────
/** The categories to choose from: Televend's regions in use, the corrections made, and "Not counted". */
export async function categoryChoices(viewer: AppContext & Actor): Promise<string[]> {
  requireReader(viewer);
  const rows = await withContext(
    viewer,
    (sql) => sql<{ c: string }[]>`
      select distinct region_caption as c from tv_machine where region_caption is not null
      union select distinct category_override from machine where category_override is not null`,
    { readOnly: true },
  );
  return [...new Set([...rows.map((r) => r.c), NOT_COUNTED])].sort((a, b) => a.localeCompare(b));
}

/**
 * Put a machine in another category in FreshNow — or back in Televend's (null). Televend is never changed. Only the
 * Ops Head, the CEO or an Admin (machines.manage); each change is audited with the reason given. The machine is found
 * through any Televend record it ever had — one switched off too (review, 20 Oct) — and a record FreshNow has no machine
 * for yet (no number in its name) gets one, so it too can be marked "Not counted".
 */
export async function setMachineCategory(
  viewer: AppContext & Actor & { employeeId: string; status: string },
  machine: string | number,
  req: { category: string | null; note?: string | null },
  opts: { correlationId?: string } = {},
): Promise<{ machineId: string; machineTvId: number | null; category: string; corrected: boolean }> {
  if (viewer.status !== "active" || !can(viewer, "machines.manage")) {
    throw new AnalyticsRefused("Only the Ops Head, the CEO or an Admin corrects a machine's category.", 403, "not_allowed");
  }
  const category = req.category === null ? null : req.category.replace(/\s+/g, " ").trim();
  if (category !== null && (category.length < 1 || category.length > 60)) throw new AnalyticsRefused("A category is 1 to 60 characters.", 400, "bad_category");
  const note = req.note ? req.note.replace(/\s+/g, " ").trim().slice(0, 300) || null : null;
  const ref = machineRef(machine);
  return getServiceSql().begin(async (tx) => {
    let machineId: string | null;
    let machineTvId: number | null;
    let region: string | null;
    if ("machineId" in ref) {
      const [m] = await tx<{ machine_id: string; televend_id: string | null; region_caption: string | null }[]>`${recordOfMachine(tx, ref.machineId)}`;
      if (!m) throw new AnalyticsRefused("No such machine.", 404, "no_machine");
      machineId = m.machine_id;
      machineTvId = m.televend_id === null ? null : Number(m.televend_id);
      region = m.region_caption;
    } else {
      const [rec] = await tx<{ televend_id: string; caption: string; tv_asset_no: number | null; region_caption: string | null; machine_id: string | null }[]>`
        ${machineOfRecord(tx, ref.tvId)}`;
      if (!rec) throw new AnalyticsRefused("No such machine in Televend's list.", 404, "no_machine");
      machineId = rec.machine_id;
      machineTvId = ref.tvId;
      region = rec.region_caption;
      if (!machineId) {
      // A record with no FreshNow machine (no number in its name): one is made for it, placed by hand. The sync closes a
      // placement of a record it does not place itself; the closed one still says which machine it was.
        const [made] = await tx<{ id: string }[]>`
          insert into machine (asset_no, label) values (${rec.tv_asset_no}, ${rec.caption}) returning id`;
        machineId = made!.id;
        await tx`insert into machine_placement (machine_id, tv_machine_id, source) values (${machineId}, ${ref.tvId}, 'manual')`;
      }
    }
    const [m] = await tx<{ id: string; before: string | null }[]>`select id, category_override as before from machine where id = ${machineId} for update`;
    // Choosing Televend's own region is the same as no correction.
    const override = category === null || category === region ? null : category;
    await tx`
      update machine set category_override = ${override}, category_note = ${override === null ? null : note},
                         category_set_by = ${viewer.employeeId}, category_set_at = now(), updated_at = now()
       where id = ${m!.id}`;
    // The reason's words stay on the machine row, where the retention sweep and erasure reach them — the audit log
    // (kept for good) records only that a reason was given.
    const detail = { machineTvId, from: m!.before ?? region, to: override ?? region, corrected: override !== null, reasonGiven: note !== null };
    await tx`
      insert into audit_log (correlation_id, actor, action, entity, entity_id, detail)
      values (${correlationOf(opts.correlationId)}, ${`employee:${viewer.employeeId}`}, 'machine.category_set', 'machine', ${m!.id}, ${tx.json(detail as never)})`;
    return { machineId: m!.id, machineTvId, category: override ?? region ?? "No category", corrected: override !== null };
  });
}
