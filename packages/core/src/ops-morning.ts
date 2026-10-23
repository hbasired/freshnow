import { randomUUID } from "node:crypto";
import { notifyPeople } from "./alerts.js";
import { logAudit } from "./audit.js";
import { getServiceSql } from "./db.js";
import { dayReport } from "./ops-fleet.js";
import { salesByHour } from "./ops-sales.js";
import { televendReachable } from "./consent.js";
import { ceoEmployeeId, loadViewer } from "./org.js";
import { televendHealth } from "./televend-sync.js";
import { localDate } from "./time.js";

/**
 * Yesterday's report, every morning (TASK-059): the numbers the CEO used to piece together from the
 * WhatsApp groups, in one message to the people who run the machines — counted by Postgres from
 * Televend (dayReport), never by a model. App first: the inbox and a phone notification; Telegram only
 * for someone the app cannot reach on a device (D217).
 *
 * Once a day, after 07:30 Dubai — the night shift's collections are in by then. A
 * marker in the audit log says it was sent; the outbox keys say the same per person, so a second run
 * sends nothing twice.
 */

const SEND_AFTER = "07:30";
/**
 * Until then, a report waits while Televend has not finished reading yesterday — the worker may have just
 * started after a night off (18 Oct: it sent "not read in full" minutes before the catch-up landed). After
 * it, the report goes as it is, saying plainly that it is short.
 */
const WAIT_FOR_TELEVEND_UNTIL = "10:00";

const AED = (fils: number) => `AED ${(fils / 100).toLocaleString("en-GB", { maximumFractionDigits: 2 })}`;
const dubaiHm = (d: Date) => new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Dubai", hour: "2-digit", minute: "2-digit", hour12: false }).format(d);
const dayName = (iso: string) =>
  new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "Asia/Dubai" }).format(new Date(`${iso}T12:00:00+04:00`));

export interface MorningResult {
  sent: boolean;
  /** Why not: too early, already sent, nobody to tell, no CEO. */
  reason?: string;
  date?: string;
  recipients?: number;
  enqueued?: number;
}

export async function sendMorningReport(opts: { now?: Date; correlationId?: string } = {}): Promise<MorningResult> {
  const now = opts.now ?? new Date();
  if (dubaiHm(now) < SEND_AFTER) return { sent: false, reason: "too early" };
  const date = localDate(new Date(now.getTime() - 86_400_000));
  const sql = getServiceSql();
  const [done] = await sql<{ n: number }[]>`
    select count(*)::int as n from audit_log where action = 'ops.morning_report' and entity_id = ${date}`;
  if ((done?.n ?? 0) > 0) return { sent: false, reason: "already sent", date };
  if (dubaiHm(now) < WAIT_FOR_TELEVEND_UNTIL && televendReachable()) {
    const h = await televendHealth(true, now);
    if (h.stale === true || (h.yesterdayIncomplete?.length ?? 0) > 0) return { sent: false, reason: "waiting for Televend to read yesterday in full", date };
  }

  // Everyone whose role sees the machines, per the role table — the same rule as the Operations portal. Televend's
  // "should have found" only for those who see all cash (D237): a Supervisor gets the report without it.
  const people = await sql<{ id: string; cash: boolean }[]>`
    select e.id, exists (select 1 from role_capability c where c.role = e.access_role and c.capability = 'cash.read') as cash
      from employee e
      join role_capability rc on rc.role = e.access_role and rc.capability = 'televend.read'
     where e.status = 'active'`;
  if (people.length === 0) return { sent: false, reason: "nobody runs the machines", date };
  const ceo = await loadViewer(await ceoEmployeeId());
  if (!ceo) return { sent: false, reason: "no CEO", date };

  const r = await dayReport(ceo, date, now);
  const covered = (await salesByHour(ceo, date, now)).covered.date;
  const t = r.totals;
  const lines = (withCash: boolean) => [
    `📊 Yesterday, ${dayName(date)} — the machines, from Televend`,
    "",
    `• ${t.cups.toLocaleString("en-GB")} cups sold (${t.cashCups} cash · ${t.cardCups} card)`,
    withCash
      ? `• ${t.collections} cash collections — Televend's cash sales say they should have found ${AED(t.expectedCashFils ?? 0)}`
      : `• ${t.collections} cash collections logged in Televend`,
    `• ${t.refills} refills logged`,
    `• ${t.alarmsNeedingSomeone} alarms stayed open long enough to need someone (${t.alarmsClearedThemselves} more cleared on their own)`,
    ...(t.silentMachines > 0 ? [`• ${t.silentMachines} machine${t.silentMachines === 1 ? "" : "s"} sold nothing all day`] : []),
    ...(covered ? [] : ["", "⚠️ Yesterday was not read from Televend in full — these numbers are short."]),
    "",
    "Operations → Day report has every machine.",
  ];
  const correlationId = opts.correlationId ?? randomUUID();
  let enqueued = 0;
  for (const withCash of [true, false]) {
    const to = people.filter((p) => p.cash === withCash);
    if (to.length === 0) continue;
    const res = await notifyPeople({
      recipients: to.map((p) => ({ employeeId: p.id, reason: "you run the machines (televend.read)" })),
      keyFor: (employeeId, channel) => `ops.morning_report:${date}:${employeeId}:${channel}`,
      text: lines(withCash).join("\n"),
      kind: "ops.morning_report",
      presentation: { title: `Yesterday: ${t.cups.toLocaleString("en-GB")} cups`, url: "/app/#operations/day", tag: `ops-day-${date}`, urgent: false },
      payload: { date },
      telegram: "fallback",
      correlationId,
    });
    enqueued += res.enqueued;
  }
  await logAudit({
    correlationId,
    actor: "system",
    action: "ops.morning_report",
    entity: "day",
    entityId: date,
    detail: { recipients: people.length, enqueued, totals: t, covered },
  });
  return { sent: true, date, recipients: people.length, enqueued };
}
