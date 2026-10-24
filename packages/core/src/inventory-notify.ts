import { notifyPeople } from "./alerts.js";
import { logAudit } from "./audit.js";
import { loadConfig } from "./config.js";
import { getServiceSql } from "./db.js";
import { PLACE, fmt, toMilli } from "./inventory-common.js";
import { ceoEmployeeId } from "./org.js";
import { localDate } from "./time.js";

/**
 * Who is told what about stock (TASK-060) — fixed rules, never a model (CLAUDE.md). App first: the inbox
 * and a phone notification; Telegram only for someone the app cannot reach on a device (D217).
 *
 *   a handover waits      → whoever must confirm it (the person, or the warehouse's keepers)
 *   less arrived / refused → whoever gave it; less arrived → the approvers too
 *   below its minimum      → the keepers and the approvers, once a day per item
 *   a count                → a recount: the warehouse; a decision: the approvers; closed: the stock list,
 *                            as the WhatsApp group had it — but from the record (VF74)
 *   reminders (worker)     → a handover still waiting; a count after stock was given out
 *
 * Every notice is best effort: a failure is logged and never undoes the stock that moved.
 */

const URL = "/app/#inventory";

/** The keepers; with none, the Ops Head; with neither, the CEO — the people who run the warehouse day to day. */
export async function warehousePeople(except: readonly (string | null)[] = []): Promise<string[]> {
  return firstOf(["warehouse_keeper", "ops_head"], except);
}

/** The Ops Head; with none, the CEO — who decide differences (D218). */
export async function approvers(except: readonly (string | null)[] = []): Promise<string[]> {
  return firstOf(["ops_head"], except);
}

async function firstOf(roles: readonly string[], except: readonly (string | null)[]): Promise<string[]> {
  const skip = except.filter((x): x is string => typeof x === "string");
  const sql = getServiceSql();
  for (const role of roles) {
    const rows = await sql<{ id: string }[]>`
      select id from employee where status = 'active' and access_role = ${role} and not (id = any(${skip}::uuid[]))`;
    if (rows.length > 0) return rows.map((r) => r.id);
  }
  const ceo = await ceoEmployeeId();
  return skip.includes(ceo) ? [] : [ceo];
}

export async function tell(p: {
  to: readonly string[];
  key: string;
  kind: string;
  text: string;
  title: string;
  tag: string;
  urgent?: boolean;
  reason: string;
  correlationId?: string;
}): Promise<number> {
  if (p.to.length === 0) return 0;
  const r = await notifyPeople({
    recipients: p.to.map((employeeId) => ({ employeeId, reason: p.reason })),
    keyFor: (employeeId, channel) => `${p.key}:${employeeId}:${channel}`,
    text: p.text,
    kind: p.kind,
    presentation: { title: p.title, url: URL, tag: p.tag, urgent: p.urgent ?? false },
    telegram: "fallback",
    ...(p.correlationId ? { correlationId: p.correlationId } : {}),
  });
  return r.enqueued;
}

const nameOf = async (id: string | null): Promise<string> =>
  id ? ((await getServiceSql()<{ n: string }[]>`select display_name as n from employee where id = ${id}`)[0]?.n ?? "Someone") : "Someone";

async function linesOf(docId: string, step?: string): Promise<string> {
  const rows = step
    ? await getServiceSql()<{ name: string; unit: string; icon: string | null; qty: string }[]>`
        select i.name, i.unit, i.icon, sum(m.qty)::text as qty from stock_move m join inv_item i on i.id = m.item_id
         where m.doc_id = ${docId} and m.step = ${step} group by i.name, i.unit, i.icon, i.sort_order order by i.sort_order`
    : await getServiceSql()<{ name: string; unit: string; icon: string | null; qty: string }[]>`
        select i.name, i.unit, i.icon, l.qty::text as qty from stock_doc_line l join inv_item i on i.id = l.item_id
         where l.doc_id = ${docId} order by i.sort_order`;
  return rows.map((r) => `${r.icon ? `${r.icon} ` : ""}${fmt(toMilli(r.qty), r.unit)} ${r.name}`).join(", ");
}

interface DocRow {
  id: string;
  kind: string;
  state: string;
  created_by: string;
  confirm_side: string | null;
  confirm_by: string | null;
  answered_by: string | null;
  answer_reason: string | null;
  from_employee: string | null;
  to_employee: string | null;
  from_location_id: string;
  to_location_id: string;
}

async function docRow(docId: string): Promise<DocRow | null> {
  return (
    (await getServiceSql()<DocRow[]>`
      select d.id, d.kind, d.state, d.created_by, d.confirm_side, d.confirm_by, d.answered_by, d.answer_reason,
             lf.employee_id as from_employee, lt.employee_id as to_employee, d.from_location_id, d.to_location_id
        from stock_doc d join inv_location lf on lf.id = d.from_location_id join inv_location lt on lt.id = d.to_location_id
       where d.id = ${docId}`)[0] ?? null
  );
}

/**
 * A handover is waiting: tell whoever must confirm it. A reminder is its own message — under the first
 * one's delivery key the outbox would take it for a repeat and send nothing (found by the tests).
 */
export async function noticeHandoverWaiting(docId: string, correlationId?: string, opts: { reminder?: boolean } = {}): Promise<number> {
  const d = await docRow(docId);
  if (!d || d.kind !== "handover" || d.state !== "waiting") return 0;
  const what = await linesOf(docId);
  const creator = await nameOf(d.created_by);
  let to: string[];
  let text: string;
  if (d.confirm_side === "person") {
    to = d.confirm_by ? [d.confirm_by] : [];
    text = d.to_location_id === PLACE.warehouse
      ? `↩️ ${creator} at the warehouse took back from you: ${what}.\nOpen FreshNow → Stock to confirm it, or say what is different.`
      : `📦 ${creator} is giving you: ${what}.\nOpen FreshNow → Stock to accept it, or say what is different.`;
  } else {
    to = await warehousePeople([d.created_by, d.from_employee]);
    // Taken back at the desk from someone who cannot confirm it (they left, or their role changed): say whose it was.
    text =
      d.from_employee && d.from_employee !== d.created_by
        ? `⬅️ ${creator} took back ${await nameOf(d.from_employee)}'s stock: ${what}.\nOpen FreshNow → Stock to confirm what arrived.`
        : `↩️ ${creator} is giving back to the warehouse: ${what}.\nOpen FreshNow → Stock to confirm what arrived.`;
  }
  if (opts.reminder) text = `⏰ Still waiting for you. ${text}`;
  return tell({
    to, key: `${opts.reminder ? "stock.handover_reminder" : "stock.handover"}:${docId}`, kind: "stock.handover", text,
    title: opts.reminder ? "Still to confirm" : "Stock to confirm", tag: `stock-${docId}`, urgent: true,
    reason: "a handover waits for you", ...(correlationId ? { correlationId } : {}),
  });
}

/** The other side answered with less, or refused: tell the giver; less arrived — the approvers too. */
export async function noticeHandoverAnswered(docId: string, correlationId?: string): Promise<number> {
  const d = await docRow(docId);
  if (!d || d.kind !== "handover" || (d.state !== "refused" && d.state !== "part_accepted")) return 0;
  const who = await nameOf(d.answered_by);
  const sent = await linesOf(docId, "send");
  let n = 0;
  if (d.state === "refused") {
    n += await tell({
      to: [d.created_by], key: `stock.refused:${docId}`, kind: "stock.refused", title: "Handover refused", tag: `stock-${docId}`,
      text: `✋ ${who} refused ${sent} (${(d.answer_reason ?? "other").replace(/_/g, " ")}). It is back where it came from.`,
      reason: "you started this handover", ...(correlationId ? { correlationId } : {}),
    });
  } else {
    const took = await linesOf(docId, "accept");
    const text = `⚠️ Less arrived than was sent: ${who} counted ${took || "nothing"} of ${sent}. The rest waits in transit until the Ops Head settles it.`;
    n += await tell({ to: [d.created_by], key: `stock.short:${docId}`, kind: "stock.short", title: "Less arrived than was sent", tag: `stock-${docId}`, text, reason: "you started this handover", ...(correlationId ? { correlationId } : {}) });
    n += await tell({
      to: await approvers([d.created_by, d.answered_by, d.from_employee, d.to_employee]), key: `stock.settle:${docId}`, kind: "stock.settle",
      title: "A handover to settle", tag: `stock-${docId}`, text: `${text}\nOpen FreshNow → Stock to settle it.`, urgent: true,
      reason: "you approve stock differences", ...(correlationId ? { correlationId } : {}),
    });
  }
  return n;
}

/**
 * Who must not be shown the warehouse's figures now (D236; review of 20 Oct — the notices carried them past the screens'
 * hiding): someone counting the warehouse, someone who took its recount, and while a recount waits to be taken, everyone
 * who may take it — whoever runs the warehouse, except the person who counted. `mayCount` says whether the person runs it.
 */
export async function figuresHiddenFrom(): Promise<(employeeId: string, mayCount: boolean) => boolean> {
  const open = await getServiceSql()<{ state: string; started_by: string; recount_by: string | null }[]>`
    select state, started_by, recount_by from count_session where location_id = ${PLACE.warehouse} and state in ('counting', 'recount')`;
  return (id, mayCount) =>
    open.some(
      (c) =>
        (c.state === "counting" && c.started_by === id) ||
        (c.state === "recount" && (c.recount_by === id || (c.recount_by === null && mayCount && c.started_by !== id))),
    );
}

/** Items whose warehouse stock is now below their minimum: tell the keepers and the approvers, once a day per item. */
export async function noticeLowStock(itemIds: readonly string[], opts: { now?: Date; correlationId?: string } = {}): Promise<number> {
  if (itemIds.length === 0) return 0;
  const now = opts.now ?? new Date();
  const day = localDate(now);
  const sql = getServiceSql();
  const low = await sql<{ id: string; name: string; unit: string; icon: string | null; qty: string; min: string }[]>`
    select i.id, i.name, i.unit, i.icon, coalesce(b.qty, 0)::text as qty, i.min_level::text as min
      from inv_item i left join stock_balance b on b.item_id = i.id and b.location_id = ${PLACE.warehouse}
     where i.id = any(${itemIds}::uuid[]) and i.active and i.min_level is not null and coalesce(b.qty, 0) < i.min_level
       and not exists (select 1 from audit_log a where a.action = 'stock.low_alerted' and a.entity_id = i.id::text and a.detail->>'day' = ${day})`;
  let n = 0;
  const hidden = low.length > 0 ? await figuresHiddenFrom() : () => false;
  for (const it of low) {
    const to = [...new Set([...(await warehousePeople()), ...(await approvers())])];
    // Everyone told runs or approves the warehouse — someone counting it hears that it is low, not how many are left.
    const counting = to.filter((p) => hidden(p, true));
    const c = opts.correlationId ? { correlationId: opts.correlationId } : {};
    const base = { key: `stock.low:${it.id}:${day}`, kind: "stock.low", title: `Low: ${it.name}`, tag: `stock-low-${it.id}`, reason: "you run or approve the warehouse's stock", ...c };
    n += await tell({
      ...base,
      to: to.filter((p) => !counting.includes(p)),
      text: `🚨 ${it.icon ? `${it.icon} ` : ""}${it.name}: ${fmt(toMilli(it.qty), it.unit)} left in the warehouse — the minimum is ${fmt(toMilli(it.min), it.unit)}.`,
    });
    if (counting.length > 0) {
      n += await tell({ ...base, to: counting, text: `🚨 ${it.icon ? `${it.icon} ` : ""}${it.name} is below its minimum in the warehouse.` });
    }
    await logAudit({ ...(opts.correlationId ? { correlationId: opts.correlationId } : {}), actor: "system", action: "stock.low_alerted", entity: "inv_item", entityId: it.id, detail: { day, qty: it.qty, min: it.min } });
  }
  return n;
}

/** Every item the document moved in or out of the warehouse — for the low-stock check. */
export async function warehouseItemsOf(docId: string): Promise<string[]> {
  const rows = await getServiceSql()<{ item_id: string }[]>`
    select distinct item_id from stock_move where doc_id = ${docId} and (from_location_id = ${PLACE.warehouse} or to_location_id = ${PLACE.warehouse})`;
  return rows.map((r) => r.item_id);
}

const KIND_WORDS: Readonly<Record<string, string>> = { opening: "opening", after_handout: "after the team left", closing: "closing", spot: "spot check" };
const hm = (d: Date) => new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Dubai", hour: "2-digit", minute: "2-digit", hour12: false }).format(d);
const dayWords = (d: Date) => new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Dubai", weekday: "short", day: "numeric", month: "short" }).format(d);

/** The warehouse's stock as the record has it now — the WhatsApp list, from the ledger. */
export async function stockList(): Promise<string> {
  const rows = await getServiceSql()<{ name: string; unit: string; icon: string | null; qty: string; min: string | null }[]>`
    select i.name, i.unit, i.icon, coalesce(b.qty, 0)::text as qty, i.min_level::text as min
      from inv_item i left join stock_balance b on b.item_id = i.id and b.location_id = ${PLACE.warehouse}
     where i.active order by i.sort_order, lower(i.name)`;
  return rows
    .map((r) => {
      const q = toMilli(r.qty);
      const low = r.min !== null && q < toMilli(r.min);
      return `${low ? "🚨" : (r.icon ?? "•")} ${r.name} ${fmt(q, r.unit)}${low ? ` — below ${fmt(toMilli(r.min!), r.unit)}` : ""}`;
    })
    .join("\n");
}

/** A count moved on: a recount to do, a decision to make, or — closed — the stock list for the approvers. */
export async function noticeCount(sessionId: string, correlationId?: string): Promise<number> {
  const [s] = await getServiceSql()<{ state: string; kind: string; started_by: string; recount_by: string | null; submitted_at: Date | null; decided_by: string | null }[]>`
    select state, kind, started_by, recount_by, submitted_at, decided_by from count_session where id = ${sessionId}`;
  if (!s || !s.submitted_at) return 0;
  const when = `${KIND_WORDS[s.kind] ?? s.kind} count of ${hm(s.submitted_at)}`;
  const counter = await nameOf(s.started_by);
  const c = correlationId ? { correlationId } : {};
  if (s.state === "recount") {
    return tell({
      to: [...new Set([...(await warehousePeople([s.started_by])), ...(await approvers([s.started_by]))])],
      key: `stock.recount:${sessionId}`, kind: "stock.recount", title: "A count to check", tag: `count-${sessionId}`,
      text: `🔢 ${counter}'s ${when} differs from the record. Someone else needs to count those items again.\nOpen FreshNow → Stock → Counts.`,
      reason: "a count needs a second person", ...c,
    });
  }
  if (s.state === "approval") {
    return tell({
      to: await approvers([s.started_by, s.recount_by]), key: `stock.decide:${sessionId}`, kind: "stock.decide", title: "A count to decide",
      tag: `count-${sessionId}`, text: `🔢 ${counter}'s ${when} differs from the record and waits for your decision.\nOpen FreshNow → Stock → Counts.`,
      urgent: true, reason: "you approve stock differences", ...c,
    });
  }
  if (s.state === "closed") {
    const decided = s.decided_by ? ` — decided by ${await nameOf(s.decided_by)}` : " — everything matched the record";
    const to = await approvers([s.started_by]);
    // An approver counting the warehouse, or who may still take a recount, gets the news without the figures (D236).
    const hidden = await figuresHiddenFrom();
    const counting = to.filter((p) => hidden(p, true));
    const base = { key: `stock.counted:${sessionId}`, kind: "stock.counted", title: `Warehouse stock, ${hm(s.submitted_at)}`, tag: `count-${sessionId}`, reason: "you approve the warehouse's stock", ...c };
    const head = `📦 Warehouse stock — ${dayWords(s.submitted_at)}, ${when}, counted by ${counter}${decided}.`;
    let n = await tell({ ...base, to: to.filter((p) => !counting.includes(p)), text: `${head}\n\n${await stockList()}` });
    if (counting.length > 0) {
      n += await tell({ ...base, to: counting, text: `${head}\nThe figures are not in this message while you count, or may take a recount — open FreshNow → Stock once that is done.` });
    }
    return n;
  }
  return 0;
}

// ── reminders (the worker, every minute) ─────────────────────────────────────
/**
 * Handovers still waiting past INVENTORY_HANDOVER_REMIND_MINUTES: whoever must confirm is reminded,
 * once; and when stock was given out and nobody has counted the warehouse since, after
 * INVENTORY_COUNT_REMIND_MINUTES the keepers are asked to count what is left — once per round.
 */
export async function inventoryReminders(opts: { now?: Date; correlationId?: string } = {}): Promise<{ handovers: number; counts: number }> {
  const now = opts.now ?? new Date();
  const cfg = loadConfig();
  const sql = getServiceSql();
  const c = opts.correlationId ? { correlationId: opts.correlationId } : {};
  let handovers = 0;
  let counts = 0;

  if (cfg.INVENTORY_HANDOVER_REMIND_MINUTES > 0) {
    const due = await sql<{ id: string }[]>`
      select d.id from stock_doc d
       where d.kind = 'handover' and d.state = 'waiting'
         and d.recorded_at <= ${now}::timestamptz - make_interval(mins => ${cfg.INVENTORY_HANDOVER_REMIND_MINUTES})
         and not exists (select 1 from audit_log a where a.action = 'stock.handover_reminded' and a.entity_id = d.id::text)
       order by d.recorded_at limit 50`;
    for (const d of due) {
      await logAudit({ ...c, actor: "system", action: "stock.handover_reminded", entity: "stock_doc", entityId: d.id });
      handovers += await noticeHandoverWaiting(d.id, opts.correlationId, { reminder: true });
    }
  }

  if (cfg.INVENTORY_COUNT_REMIND_MINUTES > 0) {
    // The last hand-out from the warehouse after the last count handed in.
    const [last] = await sql<{ doc_id: string; at: Date }[]>`
      select m.doc_id, max(m.posted_at) as at from stock_move m
       where m.from_location_id = ${PLACE.warehouse} and m.step = 'send'
         and m.posted_at > coalesce((select max(s.submitted_at) from count_session s
                                      where s.location_id = ${PLACE.warehouse} and s.state <> 'cancelled'), '-infinity'::timestamptz)
       group by m.doc_id order by at desc limit 1`;
    if (last && now.getTime() - last.at.getTime() >= cfg.INVENTORY_COUNT_REMIND_MINUTES * 60_000) {
      const [done] = await sql<{ n: number }[]>`select count(*)::int as n from audit_log where action = 'stock.count_reminded' and entity_id = ${last.doc_id}`;
      if ((done?.n ?? 0) === 0) {
        const items = await sql<{ name: string }[]>`
          select distinct i.name, i.sort_order from stock_move m join inv_item i on i.id = m.item_id
           where m.from_location_id = ${PLACE.warehouse} and m.step = 'send'
             and m.posted_at > ${new Date(now.getTime() - 12 * 3_600_000)} order by i.sort_order`;
        await logAudit({ ...c, actor: "system", action: "stock.count_reminded", entity: "stock_doc", entityId: last.doc_id });
        counts += await tell({
          to: await warehousePeople(), key: `stock.count_reminder:${last.doc_id}`, kind: "stock.count_reminder", title: "Count what is left",
          tag: "count-reminder", text: `🔢 Stock was given out at ${hm(last.at)} (${items.map((i) => i.name).join(", ")}). Count what is left in the warehouse.\nOpen FreshNow → Stock → Count.`,
          reason: "you run the warehouse", ...c,
        });
      }
    }
  }
  return { handovers, counts };
}
