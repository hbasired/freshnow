import { useCallback, useEffect, useState } from "react";
import { api, companyDate, companyDateToIso, companyToday, dmon, hhmm, progressLabel, type OpenTask, type Priority, type RelationKind, type TaskDetail as Detail, type Watcher } from "../lib/api";
import { Card, Demo, Pill, Severity, Spinner, Words } from "./ui";
import { Button, Select, TextArea, TextField, Toast, useAction } from "./form";
import { Chips, dueShortcuts, ProgressReport, StatusReport } from "./quick";
import { Icon } from "./icons";

/**
 * One task, in depth: steps, progress and its evidence, schedule, relations, problems,
 * history, and how it ended.
 *
 * The percentage is never shown alone. It always says which of three things it is —
 * counted from steps, implied by the status, or self-reported with the person's note —
 * because a bare "70%" is the number the project-management literature warns about most.
 */

const SOURCE_LABEL = {
  counted: "counted from steps",
  status: "implied by the status",
  self_reported: "self-reported",
} as const;

const RELATION_LABEL: Record<RelationKind, string> = {
  blocks: "blocks",
  blocked_by: "is blocked by",
  precedes: "must finish before",
  follows: "starts after",
  relates: "relates to",
  duplicates: "duplicates",
};

const PRIORITIES: Priority[] = ["low", "normal", "high", "urgent"];
const CLOSE_REASONS = [
  { key: "wont_do", label: "Won't do" },
  { key: "duplicate", label: "Duplicate" },
  { key: "cancelled", label: "Cancelled" },
] as const;

export function TaskDetailPanel({
  taskId,
  viewer,
  canManage,
  mine = false,
  candidates,
  onClose,
  onChanged,
}: {
  taskId: string;
  viewer: string;
  /** Whether the viewer may change the task — the API refuses regardless. */
  canManage: boolean;
  /** The viewer's own task: status can be reported from here (the API allows only the owner). */
  mine?: boolean;
  /** Other tasks the viewer can see, for linking. */
  candidates: OpenTask[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const [d, setD] = useState<Detail | null>(null);
  const [watchers, setWatchers] = useState<Watcher[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const act = useAction();
  const [step, setStep] = useState("");
  const [priority, setPriority] = useState<Priority>("normal");
  const [due, setDue] = useState("");
  const [linkTo, setLinkTo] = useState("");
  const [linkKind, setLinkKind] = useState<RelationKind>("blocked_by");
  const [resolving, setResolving] = useState<string | null>(null);
  const [resolution, setResolution] = useState("");
  const [closing, setClosing] = useState<"" | "wont_do" | "duplicate" | "cancelled">("");

  const load = useCallback(async () => {
    try {
      const detail = await api.taskDetail(viewer, taskId);
      setD(detail);
      setWatchers(await api.watchers(viewer, taskId).catch(() => []));
      setPriority(detail.task.priority);
      setDue(companyDate(detail.task.due_at));
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not load the task");
    }
  }, [viewer, taskId]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Run a change, then refresh both this panel and the board behind it. */
  const change = (fn: () => Promise<string>) =>
    act.run(async () => {
      const msg = await fn();
      await load();
      onChanged();
      return msg;
    });

  if (err) {
    return (
      <Drawer onClose={onClose} title="Task">
        <p className="text-sm text-crit">{err}</p>
      </Drawer>
    );
  }
  if (!d) {
    return (
      <Drawer onClose={onClose} title="Task">
        <Spinner label="Loading…" />
      </Drawer>
    );
  }

  const t = d.task;
  const open = t.status_category !== "done";
  const doneSteps = d.steps.filter((s) => s.done).length;

  return (
    <Drawer onClose={onClose} title={t.title}>
      <div className="space-y-5 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-mut">{t.employee_name}</span>
          <Pill tone={t.status_category === "done" ? "ok" : t.status_category === "in_progress" ? "warn" : "mut"}>{t.status}</Pill>
          {t.resolution && t.resolution !== "done" ? <Pill tone="crit">{t.resolution.replace("_", " ")}</Pill> : null}
          <Pill tone={t.priority === "urgent" ? "crit" : t.priority === "high" ? "warn" : "mut"}>{t.priority}</Pill>
          {t.due_at ? <span className="text-xs text-mut">due {dmon(t.due_at)}</span> : null}
          <Demo on={t.is_synthetic} />
        </div>
        <Toast message={act.message} tone={act.tone} onDone={act.clear} />

        {/* ── Progress, with its evidence ── */}
        <section>
          <div className="mb-1 flex items-baseline justify-between gap-2">
            <span className="shrink-0 whitespace-nowrap text-2xl font-bold">{progressLabel(t)}</span>
            <span className="text-right text-xs text-mut">
              {SOURCE_LABEL[t.progress_source]}
              {t.progress_source === "counted" ? ` — ${doneSteps} of ${d.steps.length}` : ""}
              {t.progress_band_low != null ? ` · a range, counted as ${t.progress_pct}% in totals` : ""}
              {t.progress_updated_at ? ` · ${dmon(t.progress_updated_at)} ${hhmm(t.progress_updated_at)}` : ""}
            </span>
          </div>
          <div className="relative h-2 overflow-hidden rounded bg-sunken">
            <div
              className={`h-full ${t.progress_source === "self_reported" ? "bg-warn" : "bg-ok"}`}
              style={{ width: `${t.progress_pct}%` }}
            />
            {t.elapsed_pct != null ? (
              <div className="absolute top-0 h-full w-0.5 bg-link" style={{ left: `${t.elapsed_pct}%` }} title={`${t.elapsed_pct}% of the time between start and due date has passed`} />
            ) : null}
          </div>
          {t.progress_source === "self_reported" && t.progress_note ? (
            <p className="mt-1 text-xs text-warn">Self-reported: &ldquo;{t.progress_note}&rdquo; — replaced by the next counted change.</p>
          ) : null}
          {t.behind ? (
            <p className="mt-1 text-xs text-crit">
              ⚠ Behind: {t.elapsed_pct}% of the time has passed and {progressLabel(t)} of the work is reported (flagged past {t.behind_threshold} points apart).
            </p>
          ) : null}
        </section>

        {/* ── Report status — the owner's three buttons, same as My work and the bot ── */}
        {mine && open ? (
          <section>
            <h4 className="mb-1 font-semibold">How is it going?</h4>
            <StatusReport viewer={viewer} task={{ id: t.id, title: t.title }} onChanged={() => { void load(); onChanged(); }} />
          </section>
        ) : null}

        {/* ── Steps ── */}
        <section>
          <h4 className="mb-1 font-semibold">Steps</h4>
          {d.steps.length === 0 ? <p className="text-xs text-mut">No steps yet. Add them and the percentage becomes a count.</p> : null}
          <ul className="space-y-1">
            {d.steps.map((s) => (
              <li key={s.id} className="flex items-start gap-2">
                <input
                  type="checkbox"
                  checked={s.done}
                  disabled={!canManage || !open || act.busy}
                  onChange={(e) => void change(async () => { await api.setStep(viewer, s.id, e.target.checked); return e.target.checked ? `Ticked: ${s.title}` : `Unticked: ${s.title}`; })}
                  className="mt-1"
                />
                <span className={s.done ? "text-mut line-through" : ""}>{s.title}</span>
                {s.done && s.done_by_name ? <span className="text-[11px] text-mut">— {s.done_by_name}</span> : null}
              </li>
            ))}
          </ul>
          {canManage && open ? (
            <form
              className="mt-2 flex gap-2"
              onSubmit={(e) => { e.preventDefault(); if (step.trim().length < 2) return; void change(async () => { await api.addStep(viewer, taskId, step.trim()); setStep(""); return "Step added."; }); }}
            >
              <div className="flex-1"><TextField label="" value={step} onChange={setStep} placeholder="Add a step" maxLength={200} /></div>
              <Button type="submit" busy={act.busy} disabled={step.trim().length < 2}>Add</Button>
            </form>
          ) : null}
        </section>

        {/* ── Self-reported progress: a range from a list, with a note ── */}
        {canManage && open ? (
          <section>
            <h4 className="mb-1 font-semibold">Report progress</h4>
            <p className="mb-2 text-xs text-mut">Pick a range — it is shown as self-reported and needs a note. Ticking steps above is stronger evidence and replaces it.</p>
            <ProgressReport viewer={viewer} task={t} onSaved={() => { void load(); onChanged(); }} />
          </section>
        ) : null}

        {/* ── Schedule and priority: taps first, the date picker for anything else ── */}
        {canManage && open ? (
          <section className="space-y-3">
            <h4 className="font-semibold">Priority and due date</h4>
            <Chips label="Priority" options={PRIORITIES} selected={priority} onPick={(v) => setPriority(v as Priority)} />
            <div>
              <Chips
                label="Due"
                options={[...dueShortcuts(companyToday()).map((s) => s.label), "No due date"]}
                selected={due === "" ? "No due date" : dueShortcuts(companyToday()).find((s) => s.date === due)?.label ?? null}
                onPick={(label) => setDue(label === "No due date" ? "" : dueShortcuts(companyToday()).find((s) => s.label === label)?.date ?? due)}
              />
              <label className="mt-2 block text-sm"><span className="text-mut">…or pick a date</span>
                <input type="date" value={due} onChange={(e) => setDue(e.target.value)} className="mt-1 w-full rounded-lg border border-edge bg-sunken px-3 py-2 text-sm sm:w-56" />
              </label>
            </div>
            <Button busy={act.busy} className="w-full sm:w-auto" onClick={() => void change(async () => { await api.updateTask(viewer, taskId, { priority, dueAt: companyDateToIso(due) }); return "Saved."; })}>Save priority and due date</Button>
          </section>
        ) : null}

        {/* ── Relations ── */}
        <section>
          <h4 className="mb-1 font-semibold">Related tasks</h4>
          {d.relations.length === 0 ? <p className="text-xs text-mut">None.</p> : null}
          <ul className="space-y-1">
            {d.relations.map((r) => (
              <li key={r.id} className="text-sm">
                <span className="text-mut">{RELATION_LABEL[r.kind]}</span> {r.other_title}
                <span className="ml-1 text-xs text-mut">({r.other_owner ?? "?"} · {r.other_status})</span>
              </li>
            ))}
          </ul>
          {canManage && open && candidates.some((c) => c.id !== taskId) ? (
            <div className="mt-2 grid gap-2 sm:grid-cols-[1fr_2fr_auto]">
              <Select label="This task" value={linkKind} onChange={(v) => setLinkKind(v as RelationKind)} options={(Object.keys(RELATION_LABEL) as RelationKind[]).map((k) => ({ value: k, label: RELATION_LABEL[k] }))} />
              <Select label="Other task" value={linkTo} onChange={setLinkTo} options={[{ value: "", label: "— choose —" }, ...candidates.filter((c) => c.id !== taskId).map((c) => ({ value: c.id, label: `${c.title} (${c.employee_name})` }))]} />
              <div className="self-end"><Button busy={act.busy} disabled={!linkTo} onClick={() => void change(async () => { await api.linkTasks(viewer, taskId, linkTo, linkKind); setLinkTo(""); return "Linked."; })}>Link</Button></div>
            </div>
          ) : null}
        </section>

        {/* ── Who is told ── */}
        <section>
          <h4 className="mb-1 font-semibold">Who is told about this task</h4>
          <p className="mb-2 text-xs text-mut">
            The owner and whoever assigned it always are. Anyone watching is told when it is finished or a problem is raised on it.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            {watchers.map((w) => (
              <Pill key={w.employeeId} tone={w.me ? "ok" : "mut"}>👁 {w.name}{w.reason !== "watcher" ? ` · ${w.reason}` : ""}</Pill>
            ))}
            {watchers.some((w) => w.me) ? (
              <Button busy={act.busy} onClick={() => void change(async () => { await api.unwatch(viewer, taskId); return "You will no longer be told about this task."; })}>Stop watching</Button>
            ) : (
              <Button busy={act.busy} onClick={() => void change(async () => { await api.watch(viewer, taskId); return "You will be told when this task changes."; })}>👁 Watch</Button>
            )}
          </div>
        </section>

        {/* ── Problems ── */}
        <section>
          <h4 className="mb-1 font-semibold">Problems raised on this task</h4>
          {d.blockers.length === 0 ? <p className="text-xs text-mut">None.</p> : null}
          <div className="space-y-2">
            {d.blockers.map((b) => (
              <Card key={b.id} className="space-y-1 p-3">
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <Severity value={b.severity} /> <span className="text-mut">{b.category ?? "—"}</span>
                  <Pill tone={b.status === "resolved" ? "ok" : b.status === "acknowledged" ? "warn" : "crit"}>{b.status}</Pill>
                  <span className="text-mut">{dmon(b.raised_at)} {hhmm(b.raised_at)}</span>
                </div>
                {b.note_raw ? <Words text={b.note_raw} /> : null}
                {b.status === "resolved" ? (
                  <p className="text-xs text-ok">Resolved by {b.resolved_by_name ?? "?"}: {b.resolution_note}</p>
                ) : canManage ? (
                  resolving === b.id ? (
                    <div className="space-y-2">
                      <TextArea label="How was it resolved?" value={resolution} onChange={setResolution} rows={2} maxLength={1000} />
                      <div className="flex gap-2">
                        <Button tone="primary" busy={act.busy} disabled={resolution.trim().length < 3} onClick={() => void change(async () => { await api.resolveBlocker(viewer, b.id, resolution.trim()); setResolving(null); setResolution(""); return "Problem resolved."; })}>Resolve</Button>
                        <Button onClick={() => setResolving(null)}>Cancel</Button>
                      </div>
                    </div>
                  ) : (
                    <Button onClick={() => setResolving(b.id)}>✔ Resolve</Button>
                  )
                ) : null}
              </Card>
            ))}
          </div>
        </section>

        {/* ── History ── */}
        {d.history.length > 0 ? (
          <section>
            <h4 className="mb-1 font-semibold">Progress history</h4>
            <ul className="space-y-0.5 text-xs text-mut">
              {d.history.map((h, i) => (
                <li key={i}>
                  {dmon(h.created_at)} {hhmm(h.created_at)} · <b className="text-ink">{h.band_low != null && h.band_high != null ? `${h.band_low}–${h.band_high}%` : `${h.pct}%`}</b> {SOURCE_LABEL[h.source]}
                  {h.by_name ? ` · ${h.by_name}` : ""}{h.note ? ` — “${h.note}”` : ""}
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {/* ── Close for a reason ── */}
        {canManage && open ? (
          <section className="border-t border-edge pt-3">
            <h4 className="mb-1 font-semibold">Stop this task</h4>
            <p className="mb-2 text-xs text-mut">&ldquo;Done&rdquo; is reported on the board. This is for work that stops for another reason.</p>
            <div className="space-y-2">
              <Chips
                label="Reason"
                options={CLOSE_REASONS.map((r) => r.label)}
                selected={CLOSE_REASONS.find((r) => r.key === closing)?.label ?? null}
                onPick={(label) => setClosing(CLOSE_REASONS.find((r) => r.label === label)?.key ?? "")}
              />
              <Button tone="danger" busy={act.busy} disabled={!closing} className="w-full sm:w-auto" onClick={() => void change(async () => { await api.closeTask(viewer, taskId, closing as "wont_do"); setClosing(""); return "Task closed."; })}>
                {closing ? `Close task — ${CLOSE_REASONS.find((r) => r.key === closing)?.label.toLowerCase()}` : "Choose a reason to close"}
              </Button>
            </div>
          </section>
        ) : null}
      </div>
    </Drawer>
  );
}

/**
 * A right-hand panel over the board; on a phone it is the whole screen — a page of its own,
 * with a Back button where a thumb expects one. Simple on purpose: one Escape, one way out.
 */
function Drawer({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-scrim" onClick={onClose}>
      <aside
        role="dialog"
        aria-label={title}
        className="h-full w-full max-w-xl overflow-y-auto border-l border-edge bg-canvas shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-edge bg-canvas/95 px-3 py-2.5 pt-[max(0.625rem,env(safe-area-inset-top))] backdrop-blur sm:px-4">
          <button
            onClick={onClose}
            aria-label="Back"
            className="flex min-h-10 items-center gap-1 rounded-lg px-2 text-sm font-semibold text-link hover:bg-sunken sm:hidden"
          >
            <Icon.chevronLeft size={18} /> Back
          </button>
          <h3 className="min-w-0 flex-1 truncate text-base font-semibold">{title}</h3>
          <button onClick={onClose} aria-label="Close" className="hidden rounded-lg border border-edge bg-sunken px-2 py-1 text-sm hover:border-crit sm:block">✕</button>
        </div>
        <div className="p-4 pb-[max(1.5rem,env(safe-area-inset-bottom))]">{children}</div>
      </aside>
    </div>
  );
}
