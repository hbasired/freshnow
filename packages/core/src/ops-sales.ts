import { withContext, type AppContext } from "./db.js";
import { can, type Actor } from "./permissions.js";
import { localDate } from "./time.js";

/**
 * Cups sold, hour by hour, against the same weekday a week earlier (TASK-058).
 *
 * The first chart of the Operations portal — the one that proves the portal shell, its permission
 * gate and the chart library end to end. The rest of the command centre is TASK-059.
 *
 * Every number is counted by Postgres over every row of the Televend mirror (CLAUDE.md rule 2), under
 * the viewer's row-level security: tv_vend is readable only with `televend.read`. A cup is
 * `sum(quantity)` — one per vend in practice (semantic/schema.yaml). Hours are Dubai hours; the day
 * runs midnight to midnight in Asia/Dubai, worked out by Postgres, not here.
 *
 * Fair comparisons only (TASK-058 review). The mirror holds sales up to the last read from Televend —
 * its horizon, minutes behind the clock, hours behind when the sync has stopped — so a day still being
 * read is counted up to that horizon and the earlier day up to the same moment a week before. The hour
 * in progress is reported apart, against the same minutes a week earlier.
 *
 * What the mirror did not read is null, never zero. "Read" means inside the windows the sync read to
 * their end (tv_sync_run.complete), so a day before the mirror began, a gap left by a sync stopped for
 * longer than it looks back (48 h), and the minutes after midnight before the day's first read all say
 * "not in the mirror" rather than "nothing sold".
 */

export interface HourlySales {
  /** The day shown, YYYY-MM-DD (Asia/Dubai). */
  date: string;
  /** The same weekday a week earlier. */
  comparedWith: string;
  /**
   * The hour being read now, while the day is not yet read to its end (today, or a day the sync is
   * behind on): earlier hours are whole, this one is partial, later ones have not been read. Null once
   * the whole day is read, and for a day not in the mirror.
   */
  throughHour: number | null;
  /**
   * Whole hours only: the hour in progress is `partial`, later hours are null for the day shown. A day
   * not in the mirror is null in every hour — `cups` for the day shown, `cupsLastWeek` for the earlier one.
   */
  hours: { hour: number; cups: number | null; cupsLastWeek: number | null }[];
  /** The hour in progress, so far — and the same minutes of that hour a week earlier (null if not read). */
  partial: { hour: number; cups: number; cupsLastWeekSameMinutes: number | null } | null;
  totals: {
    /** Up to the horizon; null when the day is not in the mirror. */
    cups: number | null;
    /**
     * A week earlier, up to the same moment — the fair comparison while a day is still being read. Null
     * unless both days are in the mirror: without the day there is no "same moment".
     */
    cupsLastWeekSameTime: number | null;
    /** Null when the earlier day is not in the mirror. */
    cupsLastWeekWholeDay: number | null;
  };
  /** How far Televend has been read (the vends cursor); null if never. */
  horizon: string | null;
  /** The first whole Dubai day the mirror read; days before it are not in the mirror. Null if never read. */
  mirroredFrom: string | null;
  /**
   * Whether each day was read from Televend with no gap — the day shown up to the horizon, the earlier
   * one whole. False: show "not in the mirror", never 0.
   */
  covered: { date: boolean; comparedWith: boolean };
  /** Whether a day check or backfill confirmed the day against Televend's own count (tv_sync_run). */
  complete: { date: boolean; comparedWith: boolean };
}

/** The viewer may not read Televend data (the API answers 403). */
export class OpsAccessRefused extends Error {
  constructor() {
    super("Televend data is for the people who run the machines (Operations).");
    this.name = "OpsAccessRefused";
  }
}

/** A day the portal cannot show: not a date, or one that has not begun (the API answers 400). */
export class OpsDayRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpsDayRefused";
  }
}

export async function salesByHour(viewer: AppContext & Actor, date: string, now: Date = new Date()): Promise<HourlySales> {
  if (!can(viewer, "televend.read")) throw new OpsAccessRefused();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00+04:00`))) {
    throw new OpsDayRefused("The day must be a date, YYYY-MM-DD.");
  }
  if (date > localDate(now)) throw new OpsDayRefused("That day has not begun yet.");
  const comparedWith = localDate(new Date(Date.parse(`${date}T12:00:00+04:00`) - 7 * 86_400_000));

  return withContext(
    viewer,
    async (sql) => {
      const dayStart = new Date(`${date}T00:00:00+04:00`);
      // Where the day is cut: at the horizon (how far Televend has been read), the clock or the day's end,
      // whichever comes first — and never before the day began: just after midnight, before the day's
      // first read, the cut would otherwise fall on yesterday and every hour of today read as zero.
      // Worked out by Postgres and kept there: the horizon is a microsecond timestamp, and handing it to
      // JavaScript (milliseconds) and back could cut a moment early. A missing cursor cuts at the start.
      const cutSql = sql`
        select d0, cut,
               cut < d0 + interval '1 day' as running,
               date_trunc('hour', cut at time zone 'Asia/Dubai') at time zone 'Asia/Dubai' as hour_start
          from (select ${dayStart}::timestamptz as d0,
                       greatest(${dayStart}::timestamptz,
                                least(${dayStart}::timestamptz + interval '1 day', ${now}::timestamptz,
                                      coalesce((select read_until from tv_sync_cursor where stream = 'vends'), ${dayStart}::timestamptz))) as cut) x`;
      // What the mirror holds. `reads` is every window of vends read to its end (all pages; a whole day
      // also equal to Televend's own count) as one set of time ranges — only the runs touching the two
      // days, and never a window set back to front by a clock jump (tstzrange would refuse it). A day is
      // in the mirror when its span lies inside that set: no gap, no unread start.
      const [reach] = await sql<
        { running: boolean; cut_hour: number | null; horizon: Date | null; mirrored_from: string | null; date_read: boolean; compared_read: boolean }[]
      >`
        with b as (${cutSql}),
        reads as (
          select range_agg(tstzrange(r.window_from, r.window_to)) as m
            from tv_sync_run r, b
           where r.stream = 'vends' and r.complete and r.window_to > r.window_from
             and r.window_to > b.d0 - interval '7 days' and r.window_from < b.d0 + interval '1 day'
        ),
        first_read as (
          select min(window_from) as at from tv_sync_run where stream = 'vends' and complete and window_to > window_from
        )
        select b.running,
               case when b.running then extract(hour from b.cut at time zone 'Asia/Dubai')::int end as cut_hour,
               least(${now}::timestamptz, (select read_until from tv_sync_cursor where stream = 'vends')) as horizon,
               -- The first whole Dubai day: a first read that began mid-day leaves that day partly unread.
               case when f.at is null then null
                    when f.at = date_trunc('day', f.at at time zone 'Asia/Dubai') at time zone 'Asia/Dubai'
                      then to_char(f.at at time zone 'Asia/Dubai', 'YYYY-MM-DD')
                    else to_char((f.at at time zone 'Asia/Dubai') + interval '1 day', 'YYYY-MM-DD') end as mirrored_from,
               b.cut > b.d0 and coalesce(tstzrange(b.d0, b.cut) <@ reads.m, false) as date_read,
               coalesce(tstzrange(b.d0 - interval '7 days', b.d0 - interval '6 days') <@ reads.m, false) as compared_read
          from b, reads, first_read f`;
      const horizon = reach?.horizon ?? null;
      const mirroredFrom = reach?.mirrored_from ?? null;
      const dateRead = reach?.date_read ?? false;
      const comparedRead = reach?.compared_read ?? false;
      const running = reach?.running ?? true;
      // The hour being read now — only for a day in the mirror that is not yet read to its end.
      const cutHour = dateRead && running ? (reach?.cut_hour ?? 0) : null;

      const hours = await sql<{ hour: number; cups: number; cups_last_week: number }[]>`
        with b as (${cutSql}),
        per_hour as (
          select (v.at >= b.d0) as this_day,
                 extract(hour from v.at at time zone 'Asia/Dubai')::int as hour,
                 sum(v.quantity)::int as cups
            from tv_vend v, b
           where (v.at >= b.d0 and v.at < b.cut)
              or (v.at >= b.d0 - interval '7 days' and v.at < b.d0 - interval '6 days')
           group by 1, 2
        )
        select h.hour, coalesce(d.cups, 0) as cups, coalesce(w.cups, 0) as cups_last_week
          from generate_series(0, 23) as h (hour)
          left join per_hour d on d.this_day and d.hour = h.hour
          left join per_hour w on not w.this_day and w.hour = h.hour
         order by h.hour`;
      const [t] = await sql<{ cups: number; same_time: number; whole_day: number; partial_week: number }[]>`
        with b as (${cutSql})
        select coalesce(sum(v.quantity) filter (where v.at >= b.d0), 0)::int as cups,
               coalesce(sum(v.quantity) filter (where v.at < b.d0 and v.at < b.cut - interval '7 days'), 0)::int as same_time,
               coalesce(sum(v.quantity) filter (where v.at < b.d0), 0)::int as whole_day,
               coalesce(sum(v.quantity) filter (where v.at < b.d0 and b.running
                                                  and v.at >= b.hour_start - interval '7 days' and v.at < b.cut - interval '7 days'), 0)::int as partial_week
          from tv_vend v, b
         where (v.at >= b.d0 and v.at < b.cut)
            or (v.at >= b.d0 - interval '7 days' and v.at < b.d0 - interval '6 days')`;
      // A whole-day read that matched Televend's own count (televend-sync.ts, dayStreams).
      const checks = await sql<{ this_day: boolean; complete: boolean }[]>`
        with b as (select ${dayStart}::timestamptz as d0)
        select (r.window_from = b.d0) as this_day, bool_or(r.complete) as complete
          from tv_sync_run r, b
         where r.stream = 'vends' and r.mode in ('daily_check', 'backfill')
           and r.window_from in (b.d0, b.d0 - interval '7 days')
           and r.window_to = r.window_from + interval '1 day'
         group by 1`;
      const totals = t ?? { cups: 0, same_time: 0, whole_day: 0, partial_week: 0 };
      return {
        date,
        comparedWith,
        throughHour: cutHour,
        hours: hours.map((h) => ({
          hour: h.hour,
          cups: dateRead && (cutHour === null || h.hour < cutHour) ? h.cups : null,
          cupsLastWeek: comparedRead ? h.cups_last_week : null,
        })),
        partial:
          cutHour === null
            ? null
            : { hour: cutHour, cups: hours[cutHour]?.cups ?? 0, cupsLastWeekSameMinutes: comparedRead ? totals.partial_week : null },
        totals: {
          cups: dateRead ? totals.cups : null,
          // A whole day is compared whole; a day still being read only up to the same moment.
          cupsLastWeekSameTime: dateRead && comparedRead ? (running ? totals.same_time : totals.whole_day) : null,
          cupsLastWeekWholeDay: comparedRead ? totals.whole_day : null,
        },
        horizon: horizon ? new Date(horizon).toISOString() : null,
        mirroredFrom,
        covered: { date: dateRead, comparedWith: comparedRead },
        complete: {
          date: checks.some((c) => c.this_day === true && c.complete),
          comparedWith: checks.some((c) => c.this_day === false && c.complete),
        },
      };
    },
    { readOnly: true },
  );
}
