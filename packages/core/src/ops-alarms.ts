import { randomUUID } from "node:crypto";
import { logAudit } from "./audit.js";
import { loadConfig } from "./config.js";
import { getServiceSql, withContext, type AppContext } from "./db.js";
import { SYSTEM_ACTOR_ID } from "./meta.js";
import { can, type Actor } from "./permissions.js";
import { resolveBlocker } from "./progress.js";
import { routeAndAlert } from "./routing.js";

/**
 * Machine alarms (TASK-059): which Televend alarms need someone, and — when OPS_ALARM_PROBLEMS is on —
 * the problem (blocker) each one becomes, so routing, SLA, escalation and acknowledgement work for
 * machines exactly as for people (migration 0031).
 *
 * Rules, not a model (CLAUDE.md: "the LLM never decides who or whether"): alarm_rule says per alarm
 * name whether it matters, how long it must stay open first (the on-delay that keeps self-clearing
 * blips out — ISA-18.2), its category (which routing_rule picks the resolver) and its severity. An
 * alarm name nobody has classified yet is treated as needing action after 30 minutes: hiding an
 * unknown alarm is the worse failure.
 */

export { SYSTEM_ACTOR_ID };

export interface AlarmRule {
  name: string;
  class: "actionable" | "noise" | "info";
  onDelayMinutes: number;
  category: string;
  severity: "low" | "medium" | "high" | "critical";
  advice: string;
}

/** For an alarm name with no rule yet. */
export const UNCLASSIFIED: Omit<AlarmRule, "name"> = {
  class: "actionable",
  onDelayMinutes: 30,
  category: "equipment",
  severity: "medium",
  advice: "A kind of alarm FreshNow has no rule for yet. Check it in Televend, and ask the Ops Head to classify it.",
};

/**
 * What to do with one Televend alarm now. Pure — the rule, the alarm's times and the clock in, the
 * answer out — so every outcome is a unit test.
 *   wait   still inside its on-delay: it may clear by itself
 *   raise  open past its on-delay: someone must act
 *   ignore an info rule, or cleared already
 */
export function alarmDecision(
  rule: Pick<AlarmRule, "class" | "onDelayMinutes"> | undefined,
  alarm: { startedAt: Date; resolvedAt: Date | null },
  now: Date,
): "wait" | "raise" | "ignore" {
  const r = rule ?? UNCLASSIFIED;
  if (r.class === "info" || alarm.resolvedAt !== null) return "ignore";
  return now.getTime() - alarm.startedAt.getTime() >= r.onDelayMinutes * 60_000 ? "raise" : "wait";
}

const SEVERITY_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

export async function loadAlarmRules(): Promise<Map<string, AlarmRule>> {
  const rows = await getServiceSql()<
    { name: string; class: AlarmRule["class"]; on_delay_minutes: number; category: string; severity: AlarmRule["severity"]; advice: string }[]
  >`select name, class, on_delay_minutes, category, severity, advice from alarm_rule`;
  return new Map(
    rows.map((r) => [r.name, { name: r.name, class: r.class, onDelayMinutes: r.on_delay_minutes, category: r.category, severity: r.severity, advice: r.advice }]),
  );
}

export interface AlarmSyncResult {
  /** New problems raised. */
  raised: number;
  /** Alarms that joined a problem already open for the same machine and alarm. */
  joined: number;
  /** Alarms still inside their on-delay. */
  waiting: number;
  /** Linked alarms Televend has since resolved. */
  cleared: number;
  /** Problems closed because every alarm behind them cleared. */
  resolved: number;
  /** Problems that could not be routed now — the unrouted sweep tries again. */
  unrouted: number;
  enabled: boolean;
}

const MAX_PER_RUN = 200;

/**
 * Bring the problems in line with Televend's alarms. Run by the worker after every Televend sync.
 * Idempotent: an alarm is linked once (machine_alarm is unique per event), and one problem stays
 * open per machine and alarm name however often Televend repeats it. Bounded per run. Only one run at
 * a time (an advisory lock), so two workers never raise the same problem twice.
 */
export async function syncMachineAlarms(opts: { now?: Date; correlationId?: string } = {}): Promise<AlarmSyncResult> {
  const enabled = loadConfig().OPS_ALARM_PROBLEMS === "on";
  const result: AlarmSyncResult = { raised: 0, joined: 0, waiting: 0, cleared: 0, resolved: 0, unrouted: 0, enabled };
  if (!enabled) return result;
  const now = opts.now ?? new Date();
  const correlationId = opts.correlationId ?? randomUUID();
  const rules = await loadAlarmRules();
  const sql = getServiceSql();

  const plan = await sql.begin(async (tx) => {
    const [lock] = await tx<{ ok: boolean }[]>`select pg_try_advisory_xact_lock(hashtext('machine_alarm_sync')) as ok`;
    if (!lock?.ok) return null;

    // 1. Televend resolved it: the link says so.
    const cleared = await tx`
      update machine_alarm ma set cleared_at = e.resolved_at
        from tv_event e
       where e.source = ma.event_source and e.external_id = ma.event_id
         and ma.cleared_at is null and e.resolved_at is not null`;
    result.cleared = cleared.count;

    // 2. Open alarms not linked yet, oldest first — on machines Televend still has switched on (a moved
    //    machine's old record never reports its alarms resolved, G160, review command-centre#5), and
    //    never an info rule's (they are never problems, and left in the batch they would crowd out
    //    newer alarms, review #8).
    const open = await tx<
      { source: string; external_id: string; name: string; started_at: Date; machine_tv_id: string; machine_id: string | null; label: string; is_synthetic: boolean }[]
    >`
      select e.source, e.external_id, coalesce(e.name, '(unnamed alarm)') as name, e.started_at, e.machine_tv_id::text as machine_tv_id,
             p.machine_id, coalesce(m.label, t.caption) as label, e.is_synthetic
        from tv_event e
        join tv_machine t on t.televend_id = e.machine_tv_id and t.enabled
        left join machine_placement p on p.tv_machine_id = e.machine_tv_id and p.valid_to is null
        left join machine m on m.id = p.machine_id
        left join alarm_rule r on r.name = coalesce(e.name, '(unnamed alarm)')
       where e.kind in ('alarm', 'warning') and e.resolved_at is null and e.machine_tv_id is not null
         and e.started_at > ${now}::timestamptz - interval '14 days' and e.started_at <= ${now}
         and coalesce(r.class, 'actionable') <> 'info'
         -- Unlinked — or linked to a problem closed while its record was switched off (released): back on, it is raised again.
         and not exists (select 1 from machine_alarm ma where ma.event_source = e.source and ma.event_id = e.external_id and ma.released_at is null)
       order by e.started_at
       limit ${MAX_PER_RUN}`;

    const toRoute: string[] = [];
    for (const a of open) {
      const rule = rules.get(a.name);
      // A repeat of an alarm that already has an open problem joins it at once, on-delay or not: the
      // problem must not close while a repeat is still open, only to be raised again later (review #3).
      const [existing] = await tx<{ blocker_id: string }[]>`
        select ma.blocker_id from machine_alarm ma join blocker b on b.id = ma.blocker_id
         where ma.machine_tv_id = ${a.machine_tv_id}::bigint and ma.alarm_name = ${a.name}
           and b.status in ('open', 'acknowledged')
         order by ma.linked_at desc limit 1`;
      let blockerId = existing?.blocker_id;
      if (blockerId) {
        result.joined++;
      } else {
        const decision = alarmDecision(rule, { startedAt: a.started_at, resolvedAt: null }, now);
        if (decision === "wait") {
          result.waiting++;
          continue;
        }
        if (decision === "ignore") continue;
        const r = rule ?? { ...UNCLASSIFIED, name: a.name };
        const [b] = await tx<{ id: string }[]>`
          insert into blocker (raised_by, category, severity, affected_asset, risk, correlation_id, is_synthetic)
          values (${SYSTEM_ACTOR_ID}, ${r.category}, ${r.severity}, ${a.label},
                  ${`${a.name}: ${r.advice}`.slice(0, 500)}, ${correlationId}, ${a.is_synthetic})
          returning id`;
        blockerId = b!.id;
        toRoute.push(blockerId);
        result.raised++;
      }
      await tx`
        insert into machine_alarm (event_source, event_id, machine_tv_id, machine_id, alarm_name, started_at, blocker_id, is_synthetic, correlation_id)
        values (${a.source}, ${a.external_id}, ${a.machine_tv_id}::bigint, ${a.machine_id}, ${a.name}, ${a.started_at}, ${blockerId},
                ${a.is_synthetic}, ${correlationId})
        on conflict (event_source, event_id) do update
          set blocker_id = excluded.blocker_id, released_at = null, linked_at = now(), correlation_id = excluded.correlation_id
          where machine_alarm.released_at is not null`;
    }

    // 3. Problems whose alarms have all cleared in Televend — and no repeat of the same alarm on the
    //    same machine is still open, linked or not (review #3) — or whose Televend record has been
    //    switched off since: a retired record never reports its alarms resolved (review #5).
    const done = await tx<{ blocker_id: string; last_cleared: Date | null; retired: boolean; reclassified: boolean }[]>`
      with c as (
        -- A linked alarm whose rule is now "info" counts as done: the rules say it is never a problem, and Televend keeps such
        -- alarms open (review of the fixes, 20 Oct).
        select ma.blocker_id, max(ma.cleared_at) as last_cleared,
               bool_and(ma.cleared_at is not null or coalesce(ar.class, 'actionable') = 'info') as all_cleared,
               not bool_and(ma.cleared_at is not null) as reclassified,
               min(ma.machine_tv_id) as tv, min(ma.alarm_name) as alarm
          from machine_alarm ma join blocker b on b.id = ma.blocker_id
          left join alarm_rule ar on ar.name = ma.alarm_name
         where b.raised_by = ${SYSTEM_ACTOR_ID} and b.status in ('open', 'acknowledged')
         group by ma.blocker_id)
      select c.blocker_id, c.last_cleared, not coalesce(t.enabled, false) as retired, c.reclassified
        from c left join tv_machine t on t.televend_id = c.tv
       where not coalesce(t.enabled, false)
          or (c.all_cleared
              and not exists (select 1 from tv_event e
                               left join alarm_rule r on r.name = coalesce(e.name, '(unnamed alarm)')
                               where e.machine_tv_id = c.tv and coalesce(e.name, '(unnamed alarm)') = c.alarm
                                 and e.kind in ('alarm', 'warning') and e.resolved_at is null
                                 -- the alarms step 2 links, no others: an info repeat never holds a problem open (review, 20 Oct)
                                 and coalesce(r.class, 'actionable') <> 'info'
                                 and e.started_at > ${now}::timestamptz - interval '14 days' and e.started_at <= ${now}))
       limit ${MAX_PER_RUN}`;
    // A record switched off: its alarms still open are let go here, in the same transaction — never after resolveBlocker, whose
    // own steps may fail after it committed (review of the fixes, 20 Oct; D260).
    const retired = done.filter((d) => d.retired).map((d) => d.blocker_id);
    if (retired.length > 0) {
      await tx`update machine_alarm set released_at = now() where blocker_id = any(${retired}::uuid[]) and cleared_at is null and released_at is null`;
    }
    return { toRoute, done };
  });
  if (!plan) return result;

  // Routing and paging after the commit: they read the rows this transaction wrote.
  for (const id of plan.toRoute) {
    try {
      await routeAndAlert(id, correlationId);
    } catch {
      // No routing rule matched (or the outbox failed): the blocker stays unrouted and the hourly
      // sweep (sweepUnroutedBlockers) tries again and reports it — never silently dropped.
      result.unrouted++;
    }
  }
  for (const d of plan.done) {
    const at = d.last_cleared
      ? new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Dubai", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(d.last_cleared)
      : null;
    const note = d.retired
      ? "Closed: Televend switched this machine record off (moved or removed), so its alarms will never report cleared."
      : d.reclassified
        ? "Closed: its alarm is now classified as information only — never a problem."
        : `Cleared in Televend (${at}).`;
    try {
      await resolveBlocker({ blockerId: d.blocker_id, resolvedBy: SYSTEM_ACTOR_ID, note, correlationId });
      result.resolved++;
    } catch {
      /* closed by a person in the meantime */
    }
  }
  if (result.raised + result.joined + result.resolved > 0) {
    await logAudit({ correlationId, actor: "system", action: "ops.alarms_synced", entity: "machine_alarm", detail: { ...result } });
  }
  return result;
}

export interface NeedsAction {
  machineTvId: number;
  assetNo: number | null;
  machine: string;
  alarm: string;
  /** The alarm's rule: classified, or the default for one nobody has classified yet. */
  classified: boolean;
  class: AlarmRule["class"];
  category: string;
  severity: AlarmRule["severity"];
  advice: string;
  /** The earliest of the open alarms of this kind on this machine. */
  since: string;
  /** Televend repeats an alarm; how many open ones this line stands for. */
  repeats: number;
  /** The problem it became, when OPS_ALARM_PROBLEMS is on. */
  problem: { blockerId: string; status: string; slaDueAt: string | null; resolver: string | null } | null;
}

export interface AlarmsNow {
  needsAction: NeedsAction[];
  /** Open alarms still inside their on-delay — may clear by themselves. */
  waiting: number;
  /** Open alarms that are blips by rule and have not outlasted their on-delay. */
  quietNoise: number;
  problemsEnabled: boolean;
}

export class OpsRefused extends Error {
  constructor() {
    super("The machines are for the people who run them (Operations).");
    this.name = "OpsRefused";
  }
}

/**
 * The alarms that need someone now, under the viewer's row-level security (televend.read): one line
 * per machine and alarm, past its on-delay, most severe and oldest first — with the problem it became,
 * if any. The counting is Postgres's; this only groups the rows it returned (≤ 200).
 */
export async function alarmsNow(viewer: AppContext & Actor, now: Date = new Date()): Promise<AlarmsNow> {
  if (!can(viewer, "televend.read")) throw new OpsRefused();
  const rows = await withContext(
    viewer,
    (sql) => sql<
      {
        machine_tv_id: string;
        asset_no: number | null;
        machine: string;
        name: string;
        rule_name: string | null;
        class: AlarmRule["class"] | null;
        on_delay_minutes: number | null;
        category: string | null;
        severity: AlarmRule["severity"] | null;
        advice: string | null;
        since: Date;
        repeats: number;
        blocker_id: string | null;
        blocker_status: string | null;
        sla_due_at: Date | null;
        resolver: string | null;
      }[]
    >`
      with open as (
        select e.machine_tv_id, coalesce(e.name, '(unnamed alarm)') as name, min(e.started_at) as since, count(*)::int as repeats,
               (array_agg(ma.blocker_id order by ma.linked_at desc) filter (where ma.blocker_id is not null))[1] as blocker_id
          from tv_event e
          left join machine_alarm ma on ma.event_source = e.source and ma.event_id = e.external_id
         where e.kind in ('alarm', 'warning') and e.resolved_at is null and e.machine_tv_id is not null
           and e.started_at <= ${now}
           -- The last 14 days — and, whatever its age, an alarm behind a problem still open, which the re-check keeps reading
           -- (D260): a screen never drops an alarm the problems board still pages about (review of the fixes, 20 Oct).
           and (e.started_at > ${now}::timestamptz - interval '14 days'
                or exists (select 1 from machine_alarm mb join blocker bb on bb.id = mb.blocker_id
                            where mb.event_source = e.source and mb.event_id = e.external_id and bb.status in ('open', 'acknowledged')))
         group by 1, 2
      )
      select o.machine_tv_id::text as machine_tv_id, coalesce(m.asset_no, t.asset_no) as asset_no, coalesce(m.label, t.caption) as machine,
             o.name, r.name as rule_name, r.class, r.on_delay_minutes, r.category, r.severity, r.advice, o.since, o.repeats,
             b.id as blocker_id, b.status as blocker_status, b.sla_due_at, employee_display_name(b.assigned_resolver) as resolver
        from open o
        join tv_machine t on t.televend_id = o.machine_tv_id and t.enabled
        left join machine_placement p on p.tv_machine_id = o.machine_tv_id and p.valid_to is null
        left join machine m on m.id = p.machine_id
        left join alarm_rule r on r.name = o.name
        left join blocker b on b.id = o.blocker_id and b.status in ('open', 'acknowledged')
       limit 500`,
    { readOnly: true },
  );
  const out: NeedsAction[] = [];
  let waiting = 0;
  let quietNoise = 0;
  for (const r of rows) {
    const rule = r.rule_name
      ? { class: r.class!, onDelayMinutes: r.on_delay_minutes!, category: r.category!, severity: r.severity!, advice: r.advice! }
      : UNCLASSIFIED;
    const d = alarmDecision(rule, { startedAt: r.since, resolvedAt: null }, now);
    if (d === "ignore") continue;
    if (d === "wait") {
      if (rule.class === "noise") quietNoise++;
      else waiting++;
      continue;
    }
    out.push({
      machineTvId: Number(r.machine_tv_id),
      assetNo: r.asset_no,
      machine: r.machine,
      alarm: r.name,
      classified: r.rule_name !== null,
      class: rule.class,
      category: rule.category,
      severity: rule.severity,
      advice: rule.advice,
      since: r.since.toISOString(),
      repeats: r.repeats,
      problem: r.blocker_id
        ? { blockerId: r.blocker_id, status: r.blocker_status!, slaDueAt: r.sla_due_at?.toISOString() ?? null, resolver: r.resolver }
        : null,
    });
  }
  out.sort((a, b) => (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9) || a.since.localeCompare(b.since));
  return { needsAction: out, waiting, quietNoise, problemsEnabled: loadConfig().OPS_ALARM_PROBLEMS === "on" };
}
