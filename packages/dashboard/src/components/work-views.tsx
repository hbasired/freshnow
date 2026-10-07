import { useMemo, useState } from "react";
import {
  api,
  companyToday,
  dmon,
  hhmm,
  NOTIFY_CHOICES,
  progressLabel,
  type AddedPerson,
  type Blocker,
  type DayUpdate,
  type Employee,
  type NeedsReview,
  type NewPerson,
  type NotifyChoice,
  type OpenTask,
  type PersonReach,
  type ProgressSource,
} from "../lib/api";
import { Button, Select, TextField, Toast, useAction } from "./form";
import { Icon } from "./icons";
import { Age, Card, Demo, Empty, Severity } from "./ui";

/**
 * The pages the Overview's numbers open (TASK-054): Pending work, Completed, Problems — plus the
 * pieces they share. Each page shows the rows behind one number on the Overview, filtered the
 * same way the number was counted (routes/dashboard.ts `/dashboard/summary`), so a tile that says
 * 7 opens a page that lists 7.
 */

/** "FN-57" — the key people say, type and see in email subjects. */
export function TaskKey({ n }: { n?: string | null | undefined }) {
  if (!n) return null;
  return <span className="mr-1.5 rounded bg-sunken px-1.5 py-0.5 font-mono text-[11px] font-semibold text-mut">FN-{n}</span>;
}

const DAY_FMT = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Dubai", year: "numeric", month: "2-digit", day: "2-digit" });
const dayOfIso = (iso: string) => DAY_FMT.format(new Date(iso));
/** "14:32 today" / "6 Oct 14:32" — when, in company time, in the fewest words. */
export function whenLabel(iso: string): string {
  return dayOfIso(iso) === companyToday() ? `${hhmm(iso)} today` : `${dmon(iso)} ${hhmm(iso)}`;
}

/** What a reported status means to the person reading, with its colour. */
const STATUS: Record<string, { label: string; cls: string }> = {
  open: { label: "Not started", cls: "border-edge text-mut" },
  pending: { label: "Pending", cls: "border-warn/50 text-warn" },
  in_progress: { label: "In progress", cls: "border-link/50 text-link" },
  blocker: { label: "Blocked", cls: "border-crit/50 text-crit" },
  done: { label: "Done", cls: "border-ok/50 text-ok" },
  cancelled: { label: "Cancelled", cls: "border-edge text-mut" },
};

export function StatusChip({ status }: { status: string | null | undefined }) {
  const s = STATUS[status ?? "open"] ?? { label: status ?? "—", cls: "border-edge text-mut" };
  return <span className={`inline-block whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-semibold ${s.cls}`}>{s.label}</span>;
}

/**
 * A task's percentage, said with its evidence — never a bare number. The person's own figure
 * ("60%" or "50–60%", amber) names who reported it and when, with their reason underneath. A
 * counted figure (green) says it was counted from steps. A figure that only follows from the
 * status (blue, faint) says so: "no % reported yet" — so a default never reads as a report.
 */
export function ProgressMeter({
  t,
  big = false,
}: {
  t: {
    progress_pct?: number | null;
    progress_source?: ProgressSource | null;
    progress_band_low?: number | null;
    progress_band_high?: number | null;
    progress_by?: string | null;
    progress_updated_at?: string | null;
    progress_note?: string | null;
  };
  big?: boolean;
}) {
  const pct = t.progress_pct ?? 0;
  const source = t.progress_source ?? "status";
  const band = t.progress_band_low != null && t.progress_band_high != null ? { low: t.progress_band_low, high: t.progress_band_high } : null;
  const label = progressLabel({ progress_pct: pct, progress_band_low: t.progress_band_low ?? null, progress_band_high: t.progress_band_high ?? null });
  const fill = source === "self_reported" ? "bg-warn" : source === "counted" ? "bg-ok" : "bg-link/50";
  const said =
    source === "self_reported"
      ? `reported by ${t.progress_by ?? "them"}${t.progress_updated_at ? ` · ${whenLabel(t.progress_updated_at)}` : ""}`
      : source === "counted"
        ? "counted from the task's steps"
        : "by status — no % reported yet";
  return (
    <div className="min-w-0">
      <div className="flex items-baseline justify-between gap-2">
        <span className={`${big ? "text-2xl" : "text-base"} font-bold tabular-nums ${source === "status" ? "text-mut" : "text-ink"}`}>{label}</span>
        <span className="truncate text-right text-[11px] text-mut" title={said}>{said}</span>
      </div>
      <div className={`relative mt-1 w-full overflow-hidden rounded-full bg-sunken ${big ? "h-2.5" : "h-1.5"}`} role="img" aria-label={`${label} — ${said}`}>
        {band ? (
          <>
            <span className={`absolute left-0 top-0 h-full ${fill}`} style={{ width: `${band.low}%` }} />
            <span className={`absolute top-0 h-full ${fill} opacity-40`} style={{ left: `${band.low}%`, width: `${band.high - band.low}%` }} />
          </>
        ) : (
          <span className={`absolute left-0 top-0 h-full ${fill}`} style={{ width: `${pct}%` }} />
        )}
      </div>
      {big && source === "self_reported" && t.progress_note ? (
        <p className="mt-1.5 line-clamp-2 text-xs text-ink/90">“{t.progress_note}”</p>
      ) : null}
    </div>
  );
}

// ── Pending work ──────────────────────────────────────────────────────────────

export const PENDING_FILTERS = [
  { id: "all", label: "All open" },
  { id: "in-progress", label: "In progress" },
  { id: "not-started", label: "Not started" },
  { id: "blocked", label: "Blocked" },
  { id: "behind", label: "Behind" },
  { id: "older", label: "From earlier days" },
  { id: "today", label: "Reported today" },
] as const;
export type PendingFilter = (typeof PENDING_FILTERS)[number]["id"];

const isBlocked = (t: OpenTask) => (t.open_blockers ?? 0) > 0;
/** The same definitions `/dashboard/summary` counts with, so a tile and its list agree. */
const matches = (t: OpenTask, f: PendingFilter, date: string): boolean =>
  f === "in-progress" ? t.status === "pending" || t.status === "in_progress"
    : f === "not-started" ? t.status === "open"
      : f === "blocked" ? isBlocked(t)
        : f === "behind" ? t.behind
          : f === "older" ? dayOfIso(t.created_at) < date
            : f === "today" ? !!t.last_reported_at && dayOfIso(t.last_reported_at) === companyToday()
              : true;

/**
 * Every open task — what the Overview's "Pending" counts — one card each: the key and title,
 * whose it is and who gave it, how far along with the person's own figure and words, the last
 * thing they reported, and whether a problem is holding it up. Tap a card for everything else.
 */
export function PendingPage({
  tasks,
  date,
  filter,
  onFilter,
  onOpen,
}: {
  tasks: OpenTask[];
  /** The day shown — "from earlier days" means raised before it. */
  date: string;
  filter: PendingFilter;
  onFilter: (f: PendingFilter) => void;
  onOpen: (t: OpenTask) => void;
}) {
  const [person, setPerson] = useState("");
  const people = useMemo(() => {
    const m = new Map<string, { name: string; n: number }>();
    for (const t of tasks) m.set(t.employee_id, { name: t.employee_name, n: (m.get(t.employee_id)?.n ?? 0) + 1 });
    return [...m.entries()].sort((a, b) => a[1].name.localeCompare(b[1].name));
  }, [tasks]);
  const mine = person ? tasks.filter((t) => t.employee_id === person) : tasks;
  const shown = mine
    .filter((t) => matches(t, filter, date))
    // What needs a decision first: blocked, then behind, then the oldest.
    .sort((a, b) => Number(isBlocked(b)) - Number(isBlocked(a)) || Number(b.behind) - Number(a.behind) || b.age_days - a.age_days);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-1.5" role="tablist" aria-label="Show">
        {PENDING_FILTERS.map((f) => {
          const n = mine.filter((t) => matches(t, f.id, date)).length;
          const on = filter === f.id;
          return (
            <button
              key={f.id}
              role="tab"
              aria-selected={on}
              onClick={() => onFilter(f.id)}
              className={`min-h-9 rounded-full border px-3 py-1.5 text-sm ${on ? "border-ok bg-ok/15 font-semibold text-ok" : "border-edge bg-sunken text-ink hover:border-link"}`}
            >
              {f.label} <span className="tabular-nums opacity-80">· {n}</span>
            </button>
          );
        })}
        {people.length > 1 ? (
          <select
            value={person}
            onChange={(e) => setPerson(e.target.value)}
            aria-label="Whose work"
            className="ml-auto min-h-9 rounded-full border border-edge bg-sunken px-3 text-sm"
          >
            <option value="">Everyone · {tasks.length}</option>
            {people.map(([id, p]) => (
              <option key={id} value={id}>{p.name} · {p.n}</option>
            ))}
          </select>
        ) : null}
      </div>

      {shown.length === 0 ? (
        <Empty>{tasks.length === 0 ? "Nothing is open. 🎉" : "Nothing matches this filter."}</Empty>
      ) : (
        <ul className="grid gap-3 lg:grid-cols-2">
          {shown.map((t) => (
            <li key={t.id}>
              <button
                onClick={() => onOpen(t)}
                className={`group block h-full w-full rounded-xl border bg-panel p-4 text-left transition-colors hover:border-link ${
                  isBlocked(t) ? "border-crit/50" : t.behind ? "border-warn/50" : "border-edge"
                }`}
              >
                <div className="flex items-start gap-2">
                  <span className="min-w-0 flex-1">
                    <span className="block font-semibold leading-snug text-ink group-hover:text-link">
                      <TaskKey n={t.task_number} />
                      {t.title}
                      <Demo on={t.is_synthetic} />
                    </span>
                    <span className="mt-0.5 block text-xs text-mut">
                      <b className="font-semibold text-ink">{t.employee_name}</b>
                      {t.department ? ` · ${t.department}` : ""}
                      {t.assigned_by_name ? ` · given by ${t.assigned_by_name}` : ""}
                    </span>
                  </span>
                  <span className="mt-0.5 flex shrink-0 items-center text-xs text-link">Open <Icon.chevronRight size={16} /></span>
                </div>
                <div className="mt-3">
                  <ProgressMeter t={t} big />
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-1.5 text-xs text-mut">
                  <StatusChip status={isBlocked(t) ? "blocker" : t.status} />
                  {isBlocked(t) ? (
                    <span className="inline-flex items-center gap-1">
                      <Severity value={t.blocker_severity ?? null} /> {t.open_blockers} problem{t.open_blockers === 1 ? "" : "s"} open
                    </span>
                  ) : null}
                  {t.behind ? <span className="rounded-full border border-crit/40 px-2 py-0.5 text-[11px] text-crit">behind{t.elapsed_pct != null ? ` — ${t.elapsed_pct}% of the time used` : ""}</span> : null}
                  {t.priority === "urgent" || t.priority === "high" ? (
                    <span className={`rounded-full border px-2 py-0.5 text-[11px] ${t.priority === "urgent" ? "border-crit/40 text-crit" : "border-warn/40 text-warn"}`}>{t.priority}</span>
                  ) : null}
                  <span>open <Age days={t.age_days} /></span>
                  {t.due_at ? <span>· due {dmon(t.due_at)}</span> : null}
                  <span className="ml-auto">{t.last_reported_at ? `last report ${whenLabel(t.last_reported_at)}` : "never reported on"}</span>
                </div>
                {t.last_note && t.last_note !== t.progress_note ? (
                  <p className="mt-2 line-clamp-2 border-l-2 border-edge pl-2 text-xs text-mut">Last said: “{t.last_note}”</p>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs text-mut">
        <span className="mr-3"><span className="mr-1 inline-block h-2 w-3 rounded bg-warn align-middle" />reported by the person</span>
        <span className="mr-3"><span className="mr-1 inline-block h-2 w-3 rounded bg-ok align-middle" />counted from steps</span>
        <span><span className="mr-1 inline-block h-2 w-3 rounded bg-link/50 align-middle" />only what the status implies</span>
      </p>
    </div>
  );
}

// ── Completed ─────────────────────────────────────────────────────────────────

const VIA: Record<string, string> = { telegram: "Telegram", web: "the app", email: "email" };

/** Every "done" report on the day shown — what the Overview's "Completed" counts. */
export function DonePage({ rows, date, onOpen }: { rows: DayUpdate[]; date: string; onOpen: (taskId: string, ownerId: string) => void }) {
  const done = rows.filter((u) => u.status === "done");
  if (done.length === 0) return <Empty>Nothing was reported done {date === companyToday() ? "today" : `on ${dmon(date)}`}.</Empty>;
  return (
    <ul className="space-y-2">
      {done.map((u) => (
        <li key={u.id}>
          <Card className="border-l-4 border-l-ok">
            <div className="flex flex-wrap items-start gap-2">
              <span className="mt-0.5 text-ok"><Icon.checkCircle size={18} /></span>
              <span className="min-w-0 flex-1">
                {u.task_id ? (
                  <button onClick={() => onOpen(u.task_id!, u.employee_id ?? "")} className="text-left font-semibold hover:text-link hover:underline">
                    <TaskKey n={u.task_number} />
                    {u.task_title ?? "—"}
                  </button>
                ) : (
                  <span className="font-semibold">A general report (no task named)</span>
                )}
                <Demo on={u.is_synthetic} />
                <span className="mt-0.5 block text-xs text-mut">
                  <b className="text-ink">{u.employee_name}</b>
                  {u.department ? ` · ${u.department}` : ""} · {hhmm(u.submitted_at)}
                  {u.channel ? ` · via ${VIA[u.channel] ?? u.channel}` : ""}
                </span>
              </span>
            </div>
            {u.note_raw ? <p className="mt-2 border-l-2 border-edge pl-2 text-sm">“{u.note_raw}”</p> : null}
          </Card>
        </li>
      ))}
    </ul>
  );
}

// ── Problems ──────────────────────────────────────────────────────────────────

export const PROBLEM_FILTERS = [
  { id: "open", label: "Open" },
  { id: "urgent", label: "Urgent" },
  { id: "acknowledged", label: "Someone is on it" },
  { id: "all", label: "All" },
  { id: "unread", label: "Could not be read" },
] as const;
export type ProblemFilter = (typeof PROBLEM_FILTERS)[number]["id"];

const problemMatches = (b: Blocker, f: ProblemFilter) =>
  f === "open" ? b.status === "open"
    : f === "urgent" ? b.status === "open" && (b.severity === "critical" || b.severity === "high")
      : f === "acknowledged" ? b.status === "acknowledged"
        : f === "all";

/**
 * Every problem raised, what it is about and who must act — what the Overview's problem numbers
 * count — and the updates nobody could read, which need a person just as much.
 */
export function ProblemsPage({
  blockers,
  review,
  reviewTotal,
  filter,
  onFilter,
  viewer,
  canAck,
  onChanged,
  onOpen,
}: {
  blockers: Blocker[];
  review: NeedsReview[];
  reviewTotal: number;
  filter: ProblemFilter;
  onFilter: (f: ProblemFilter) => void;
  viewer: string;
  canAck: boolean;
  onChanged: () => void;
  onOpen: (taskId: string) => void;
}) {
  const act = useAction();
  const shown = blockers.filter((b) => problemMatches(b, filter));
  const count = (f: ProblemFilter) => (f === "unread" ? reviewTotal : blockers.filter((b) => problemMatches(b, f)).length);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Show">
        {PROBLEM_FILTERS.map((f) => {
          const on = filter === f.id;
          return (
            <button
              key={f.id}
              role="tab"
              aria-selected={on}
              onClick={() => onFilter(f.id)}
              className={`min-h-9 rounded-full border px-3 py-1.5 text-sm ${on ? "border-ok bg-ok/15 font-semibold text-ok" : "border-edge bg-sunken text-ink hover:border-link"}`}
            >
              {f.label} <span className="tabular-nums opacity-80">· {count(f.id)}</span>
            </button>
          );
        })}
      </div>
      <Toast message={act.message} tone={act.tone} onDone={act.clear} />

      {filter === "unread" ? (
        review.length === 0 ? (
          <Empty>Every update was understood. 👍</Empty>
        ) : (
          <div className="space-y-2">
            <p className="text-xs text-mut">
              The system could not read these, so a person must. {reviewTotal > review.length ? `Showing the latest ${review.length} of ${reviewTotal}.` : ""}
            </p>
            {review.map((r) => (
              <Card key={r.id} className="border-l-4 border-l-warn">
                <div className="text-xs text-mut"><b className="text-ink">{r.employee_name}</b> · {whenLabel(r.submitted_at)}</div>
                <p className="mt-1 text-sm">“{r.note_raw ?? ""}”</p>
              </Card>
            ))}
          </div>
        )
      ) : shown.length === 0 ? (
        <Empty>{filter === "urgent" ? "No urgent problem is open." : filter === "open" ? "No problem is open. 🎉" : "Nothing here."}</Empty>
      ) : (
        <ul className="grid gap-3 lg:grid-cols-2">
          {shown.map((b) => (
            <li key={b.id}>
              <Card className={`h-full border-l-4 ${b.severity === "critical" ? "border-l-crit" : b.severity === "high" ? "border-l-warn" : "border-l-link"}`}>
                <div className="flex flex-wrap items-center gap-2">
                  <Severity value={b.severity} />
                  <span className="font-semibold">
                    {b.category ?? "problem"}
                    {b.affected_asset ? ` — ${b.affected_asset}` : ""}
                  </span>
                  <Demo on={b.is_synthetic} />
                  <span className={`ml-auto rounded-full border px-2 py-0.5 text-[11px] font-semibold ${b.status === "open" ? "border-crit/40 text-crit" : b.status === "acknowledged" ? "border-warn/40 text-warn" : "border-ok/40 text-ok"}`}>
                    {b.status === "acknowledged" ? "someone is on it" : b.status}
                  </span>
                </div>
                {b.note_raw ? <p className="mt-2 text-sm">“{b.note_raw}”</p> : null}
                {b.summary && b.summary !== b.note_raw ? <p className="mt-0.5 text-xs text-mut">Read as: {b.summary}</p> : null}
                <div className="mt-2 text-xs text-mut">
                  Raised by <b className="text-ink">{b.raised_by_name}</b> · {whenLabel(b.raised_at)}
                  {b.resolver_name ? <> · for <b className="text-ink">{b.resolver_name}</b></> : null}
                  {b.status === "open" && b.sla_due_at ? <> · {new Date(b.sla_due_at) < new Date() ? <span className="text-crit">answer was due {whenLabel(b.sla_due_at)}</span> : `answer by ${whenLabel(b.sla_due_at)}`}</> : null}
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  {b.task_id ? (
                    <Button onClick={() => onOpen(b.task_id!)} title="Open the task this problem is on">
                      <TaskKey n={b.task_number} />{(b.task_title ?? "the task").slice(0, 48)}
                    </Button>
                  ) : (
                    <span className="text-xs text-mut">Not on a specific task</span>
                  )}
                  {b.status === "open" && canAck ? (
                    <Button
                      tone="primary"
                      busy={act.busy}
                      onClick={() =>
                        void act.run(async () => {
                          await api.ackBlocker(viewer, b.id);
                          onChanged();
                          return "Acknowledged — it will no longer escalate. Resolve it from the task when it is fixed.";
                        })
                      }
                    >
                      ✅ Acknowledge
                    </Button>
                  ) : null}
                </div>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ── Choosing how to tell someone ──────────────────────────────────────────────

const CHOICE_LABEL: Record<NotifyChoice, string> = { telegram: "Telegram", app: "App", email: "Email" };
const CHOICE_ICON = { telegram: "send", app: "bell", email: "mail" } as const;

/**
 * Telegram · App · Email, as three toggles. A choice that cannot reach the person is greyed out
 * with the reason beside it, rather than accepted and silently dropped. The first selection is
 * what their own rules would use, so doing nothing keeps today's behaviour.
 */
export function ChannelPicker({
  reach,
  value,
  onChange,
  name,
}: {
  reach: PersonReach | null;
  value: NotifyChoice[];
  onChange: (v: NotifyChoice[]) => void;
  name: string;
}) {
  return (
    <fieldset>
      <legend className="text-sm text-mut">Tell them by</legend>
      <div className="mt-1 grid grid-cols-3 gap-2">
        {NOTIFY_CHOICES.map((c) => {
          const r = reach?.[c];
          const ok = r ? r.ok : true;
          const on = value.includes(c);
          const I = Icon[CHOICE_ICON[c]];
          return (
            <button
              key={c}
              type="button"
              aria-pressed={on}
              disabled={!ok}
              title={ok ? (on ? `Will tell ${name} by ${CHOICE_LABEL[c]}` : `Tap to also tell ${name} by ${CHOICE_LABEL[c]}`) : r?.why}
              onClick={() => onChange(on ? value.filter((x) => x !== c) : NOTIFY_CHOICES.filter((x) => x === c || value.includes(x)))}
              className={`flex min-h-14 flex-col items-center justify-center gap-0.5 rounded-xl border px-2 py-2 text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-45 ${
                on ? "border-ok bg-ok/15 font-semibold text-ok" : "border-edge bg-sunken text-ink hover:border-link"
              }`}
            >
              <span className="flex items-center gap-1.5"><I size={16} /> {CHOICE_LABEL[c]} {on ? "✓" : ""}</span>
              <span className="text-[10px] font-normal leading-tight text-mut">
                {!ok ? "can't reach" : c === "app" ? (reach?.app.push ? "inbox + phone" : "app inbox") : c === "telegram" ? "linked" : "address on file"}
              </span>
            </button>
          );
        })}
      </div>
      {reach ? (
        <ul className="mt-1.5 space-y-0.5 text-xs text-mut">
          {NOTIFY_CHOICES.filter((c) => !reach[c].ok).map((c) => (
            <li key={c}>{CHOICE_LABEL[c]}: {reach[c].why}.</li>
          ))}
          {!reach.consented ? (
            <li className="text-warn">
              {name} has not agreed to the privacy notice yet — only the app inbox gets it until they do{reach.email.ok ? " (the notice was emailed to them; they reply I AGREE)" : ""}.
            </li>
          ) : null}
          {value.length === 0 ? <li className="text-crit">Choose at least one.</li> : null}
        </ul>
      ) : null}
    </fieldset>
  );
}

// ── Adding a person ───────────────────────────────────────────────────────────

/**
 * The CEO adds someone: their name and — so work can reach them without Telegram — their email,
 * where they sit and who they report to. A Telegram invite code bound to the same person is made
 * too, so joining the bot later never creates a second them.
 */
export function AddPersonCard({ viewer, people, onAdded, onClose }: { viewer: string; people: Employee[]; onAdded: () => void; onClose?: () => void }) {
  const act = useAction();
  const blank: NewPerson = { displayName: "", email: "", department: "", roleTitle: "", site: "", shift: "", accessRole: "employee", managerEmployeeId: null, telegramInvite: true };
  const [f, setF] = useState<NewPerson>(blank);
  const [done, setDone] = useState<(AddedPerson & { name: string }) | null>(null);
  const set = <K extends keyof NewPerson>(k: K, v: NewPerson[K]) => setF((x) => ({ ...x, [k]: v }));
  const managers = people.filter((p) => p.status === "active" && p.access_role !== "employee");

  return (
    <Card>
      <div className="mb-3 flex items-center gap-2">
        <h3 className="flex-1 text-sm font-semibold">➕ Add a person</h3>
        {onClose ? <button onClick={onClose} aria-label="Close" className="text-mut hover:text-ink"><Icon.x size={16} /></button> : null}
      </div>
      <Toast message={act.message} tone={act.tone} onDone={act.clear} />
      <form
        className="mt-2 grid gap-3 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          void act.run(async () => {
            const body: NewPerson = {
              displayName: f.displayName.trim(),
              email: f.email?.trim() || null,
              department: f.department?.trim() || null,
              roleTitle: f.roleTitle?.trim() || null,
              site: f.site?.trim() || null,
              shift: f.shift?.trim() || null,
              accessRole: f.accessRole ?? "employee",
              managerEmployeeId: f.managerEmployeeId || null,
              telegramInvite: f.telegramInvite ?? true,
            };
            const r = await api.addPerson(viewer, body);
            setDone({ ...r, name: body.displayName });
            setF(blank);
            onAdded();
            return `Added ${body.displayName}. They can be given work now.`;
          });
        }}
      >
        <TextField label="Name *" value={f.displayName} onChange={(v) => set("displayName", v)} placeholder="As it should appear on the board" maxLength={120} />
        <TextField label="Email" value={f.email ?? ""} onChange={(v) => set("email", v)} placeholder="name@example.com — for work by email" maxLength={254} />
        <TextField label="Department" value={f.department ?? ""} onChange={(v) => set("department", v)} placeholder="e.g. Production" maxLength={60} />
        <TextField label="Job title" value={f.roleTitle ?? ""} onChange={(v) => set("roleTitle", v)} placeholder="e.g. Route driver" maxLength={120} />
        <TextField label="Site" value={f.site ?? ""} onChange={(v) => set("site", v)} placeholder="e.g. Warehouse" maxLength={120} />
        <TextField label="Shift" value={f.shift ?? ""} onChange={(v) => set("shift", v)} placeholder="e.g. Day" maxLength={60} />
        <Select
          label="Reports to"
          value={f.managerEmployeeId ?? ""}
          onChange={(v) => set("managerEmployeeId", v || null)}
          options={[{ value: "", label: "The CEO (default)" }, ...managers.map((m) => ({ value: m.id, label: m.display_name }))]}
        />
        <Select
          label="Access"
          value={f.accessRole ?? "employee"}
          onChange={(v) => set("accessRole", v as NewPerson["accessRole"])}
          options={[
            { value: "employee", label: "Employee — their own work" },
            { value: "manager", label: "Manager — their reports" },
            { value: "lead", label: "Dept lead — their department" },
          ]}
        />
        <label className="flex items-center gap-2 text-sm sm:col-span-2">
          <input type="checkbox" checked={f.telegramInvite ?? true} onChange={(e) => set("telegramInvite", e.target.checked)} className="size-4" />
          Also make a Telegram invite code for them (optional — email or the app work without it)
        </label>
        <div className="sm:col-span-2">
          <Button type="submit" tone="primary" busy={act.busy} disabled={f.displayName.trim().length < 1}>Add person</Button>
        </div>
      </form>
      {done ? (
        <div className="mt-3 space-y-1.5 rounded-lg border border-ok/40 bg-ok/10 p-3 text-sm">
          <div className="font-semibold">{done.name} is on the team.</div>
          {done.sameName > 0 ? <div className="text-warn">Someone else is already called {done.name}: “assign to {done.name.split(" ")[0]}” will ask which one. Consider a fuller name.</div> : null}
          <div className="text-xs text-mut">
            {done.email
              ? done.consentRequested
                ? `The privacy notice was emailed to ${done.email}. Once they reply “I AGREE”, work can reach them by email; until then it waits in the app inbox.`
                : `Email is not switched on (Alerts → Channels), so the notice was not emailed. They will be asked when they join Telegram or sign in.`
              : "No email given: they will be asked to agree when they join Telegram or sign in to the app."}
          </div>
          {done.invite ? (
            <div className="pt-1">
              <div className="font-mono text-lg font-bold tracking-widest">{done.invite.code}</div>
              <div className="text-xs text-mut">
                Telegram invite, valid until {dmon(done.invite.expiresAt)} {hhmm(done.invite.expiresAt)}. They open the bot, send /start, tap “🔑 I have an invite code” and paste it — it links to this same person.
              </div>
              <div className="mt-2"><Button onClick={() => void navigator.clipboard?.writeText(done.invite!.code)}>Copy code</Button></div>
            </div>
          ) : null}
        </div>
      ) : null}
    </Card>
  );
}
