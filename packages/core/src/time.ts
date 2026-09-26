/**
 * Time rendering for people.
 *
 * CLAUDE.md: "timestamptz always. Store UTC, render Asia/Dubai." The storage half was
 * right from the start; the rendering half was not. An employee in Dubai was shown
 * "05:11" for a message their own phone timestamped 09:11 — a four-hour discrepancy on
 * every time this system has ever displayed, which quietly makes a report look like it
 * was filed in the middle of the night.
 *
 * These helpers are the only sanctioned way to put a time in front of a person. Anything
 * calling `toISOString()` on a user-facing path is a bug.
 */

export const COMPANY_TZ = "Asia/Dubai";

/** "09:11" in company time. */
export function localTime(d: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: COMPANY_TZ,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d);
}

/** "09 Sep 09:11" in company time — for lists spanning more than one day. */
export function localDateTime(d: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: COMPANY_TZ,
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })
    .format(d)
    .replace(",", "");
}

/** "2026-09-09" in company time. */
export function localDate(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: COMPANY_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

/**
 * Today's date in COMPANY time, as YYYY-MM-DD.
 *
 * `new Date().toISOString().slice(0,10)` is wrong here: between 20:00 and midnight Dubai
 * it returns *yesterday*, so an end-of-day report run at 20:30 — exactly when someone
 * would run it — would summarise the wrong day.
 */
export function companyToday(): string {
  return localDate(new Date());
}
