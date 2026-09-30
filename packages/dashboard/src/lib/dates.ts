/**
 * Company-time date shortcuts for the due-date chips. Pure, so it can be tested without a
 * browser. The UAE working week is Monday–Friday, so "end of week" is Friday.
 */

const ymd = (x: Date): string =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Dubai", year: "numeric", month: "2-digit", day: "2-digit" }).format(x);

/** Today, tomorrow, this Friday and next Monday, from company day `today` (`YYYY-MM-DD`), each date once. */
export function dueShortcuts(today: string): { label: string; date: string }[] {
  // Midday in Dubai: no display zone can round it onto a neighbouring day, and because Dubai's
  // offset is a fixed +4 with no daylight saving, getUTCDay() of this instant is Dubai's weekday.
  const d = new Date(`${today}T12:00:00+04:00`);
  const add = (n: number) => new Date(d.getTime() + n * 86_400_000);
  const dow = d.getUTCDay(); // 0 Sun … 5 Fri, 6 Sat
  const toFriday = (5 - dow + 7) % 7;
  const toMonday = (1 - dow + 7) % 7 || 7;
  const out = [
    { label: "Today", date: ymd(d) },
    { label: "Tomorrow", date: ymd(add(1)) },
    { label: "Friday · end of week", date: ymd(add(toFriday)) },
    { label: "Next Monday", date: ymd(add(toMonday)) },
  ];
  // On a Friday, "Friday" is today; on a Thursday it is tomorrow. Offer each date once.
  return out.filter((o, i) => out.findIndex((x) => x.date === o.date) === i);
}
