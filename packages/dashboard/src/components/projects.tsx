import { useCallback, useEffect, useMemo, useState } from "react";
import {
  api,
  dmon,
  hhmm,
  type Employee,
  type IssueKind,
  type Moscow,
  type ProjectDetail,
  type ProjectHealth,
  type ProjectRow,
  type RequirementKind,
} from "../lib/api";
import { Card, DataTable, Empty, Pill, Severity, Spinner, Words } from "./ui";
import { Button, PersonPicker, Select, TextArea, TextField, Toast, useAction } from "./form";

/**
 * The project portal.
 *
 * The rule this UI exists to enforce visually: a project's percentage is COMPUTED, and it is
 * never shown without saying what it was computed from. Where a person's own claim exists
 * (a status update's "where we think we are"), it is shown NEXT TO the computed figure, in a
 * different colour, with the gap named — because the gap is the thing worth looking at.
 */

const MOSCOW_TONE: Record<Moscow, "crit" | "warn" | "ok" | "mut"> = {
  must: "crit",
  should: "warn",
  could: "ok",
  wont: "mut",
};
const MOSCOW_LABEL: Record<Moscow, string> = {
  must: "Must",
  should: "Should",
  could: "Could",
  wont: "Won't",
};
const HEALTH_TONE: Record<ProjectHealth, "ok" | "warn" | "crit"> = { green: "ok", amber: "warn", red: "crit" };

/** A computed percentage, always with its basis. Amber when time is running ahead of work. */
function Computed({ pct, source, elapsed, behind }: { pct: number; source: string; elapsed: number | null; behind: boolean }) {
  return (
    <span className="inline-flex items-center gap-2 whitespace-nowrap text-xs" title={`${pct}% — computed from ${source}${elapsed != null ? ` · ${elapsed}% of the planned time used` : ""}`}>
      <span className="relative inline-block h-2 w-24 overflow-hidden rounded bg-sunken align-middle">
        <span className={`absolute left-0 top-0 h-full ${behind ? "bg-warn" : "bg-ok"}`} style={{ width: `${pct}%` }} />
        {elapsed != null ? (
          <span className="absolute top-0 h-full w-px bg-ink/70" style={{ left: `${elapsed}%` }} title={`${elapsed}% of the time used`} />
        ) : null}
      </span>
      <b>{pct}%</b>
      <span className="text-mut">{source === "milestones" ? "milestones" : "tasks"}</span>
      {behind ? <Pill tone="crit">behind</Pill> : null}
    </span>
  );
}

// ── The list ──────────────────────────────────────────────────────────────────

export function ProjectsPortal({
  viewer,
  people,
  canStart,
  projectId,
  onOpen,
}: {
  viewer: string;
  people: Employee[];
  canStart: boolean;
  projectId: string | null;
  onOpen: (id: string | null) => void;
}) {
  const [rows, setRows] = useState<ProjectRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setRows(await api.projects(viewer));
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not load projects");
    }
  }, [viewer]);

  useEffect(() => {
    void load();
  }, [load]);

  if (projectId) {
    return <ProjectPage viewer={viewer} people={people} id={projectId} onBack={() => { onOpen(null); void load(); }} />;
  }
  if (err) return <Empty>{err}</Empty>;
  if (!rows) return <Spinner label="Loading projects…" />;

  return (
    <div className="space-y-5">
      {canStart ? <NewProjectCard viewer={viewer} people={people} onCreated={(id) => { void load(); onOpen(id); }} /> : null}
      <DataTable
        rows={rows}
        columns={[
          {
            head: "Project",
            cell: (p) => (
              <button className="text-left font-semibold text-link hover:underline" onClick={() => onOpen(p.project_id)}>
                {p.name}
              </button>
            ),
          },
          { head: "Lead", cell: (p) => p.lead_name ?? <span className="text-mut">nobody</span> },
          { head: "Status", cell: (p) => <Pill tone={p.status === "active" ? "ok" : "mut"}>{p.status.replace("_", " ")}</Pill>, tight: true },
          { head: "Health", cell: (p) => <Pill tone={HEALTH_TONE[p.health]}>{p.health}</Pill>, tight: true },
          {
            head: "Progress",
            cell: (p) => <Computed pct={p.progress_pct} source={p.progress_source} elapsed={p.schedule_elapsed_pct} behind={p.behind} />,
          },
          { head: "Due", cell: (p) => (p.target_date ? dmon(p.target_date) : <span className="text-mut">—</span>), tight: true },
          {
            head: "Risks",
            cell: (p) =>
              p.issues_open === 0 ? (
                <span className="text-mut">none</span>
              ) : (
                <Pill tone={p.issues_serious > 0 ? "crit" : "warn"}>{p.issues_open} open</Pill>
              ),
            tight: true,
          },
          {
            head: "Last said",
            cell: (p) => (p.last_update_at ? <span className="text-mut">{dmon(p.last_update_at)}</span> : <Pill tone="warn">never</Pill>),
            tight: true,
          },
        ]}
        rowKey={(p) => p.project_id}
        empty={canStart ? "No projects yet. Start one above." : "No projects you can see."}
      />
    </div>
  );
}

function NewProjectCard({ viewer, people, onCreated }: { viewer: string; people: Employee[]; onCreated: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [purpose, setPurpose] = useState("");
  const [lead, setLead] = useState("");
  const [start, setStart] = useState("");
  const [target, setTarget] = useState("");
  const act = useAction();

  if (!open) {
    return (
      <div>
        <Button tone="primary" onClick={() => setOpen(true)}>➕ Start a project</Button>
      </div>
    );
  }
  return (
    <Card>
      <h3 className="mb-1 text-sm font-semibold">➕ Start a project</h3>
      <p className="mb-3 text-xs text-mut">A project needs a reason before it needs a plan. The purpose is what you will judge it against.</p>
      <Toast message={act.message} tone={act.tone} onDone={act.clear} />
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          void act.run(async () => {
            const r = await api.createProject(viewer, {
              name: name.trim(),
              purpose: purpose.trim() || null,
              leadEmployeeId: lead || null,
              startDate: start || null,
              targetDate: target || null,
            });
            setOpen(false);
            setName("");
            setPurpose("");
            onCreated(r.projectId);
            return "Project started.";
          });
        }}
      >
        <TextField label="Name" value={name} onChange={setName} placeholder="e.g. Second bottling line" maxLength={160} />
        <TextArea label="Purpose — the need it serves" value={purpose} onChange={setPurpose} rows={2} maxLength={4000} placeholder="What will be true when this is done that is not true now?" />
        <div className="grid gap-3 sm:grid-cols-3">
          <PersonPicker label="Lead" value={lead} onChange={setLead} people={people} />
          <DateField label="Start" value={start} onChange={setStart} />
          <DateField label="Target" value={target} onChange={setTarget} />
        </div>
        <div className="flex gap-2">
          <Button type="submit" tone="primary" busy={act.busy} disabled={name.trim().length < 3}>Start</Button>
          <Button onClick={() => setOpen(false)}>Cancel</Button>
        </div>
      </form>
    </Card>
  );
}

/** A plain date input; the form kit has no date control and one input does not earn a new one. */
function DateField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="block text-sm">
      <span className="text-mut">{label}</span>
      <input
        type="date"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full rounded-lg border border-edge bg-sunken px-3 py-2 text-sm text-ink focus:border-link focus:outline-none"
      />
    </label>
  );
}

// ── One project ───────────────────────────────────────────────────────────────

type Section = "plan" | "work" | "log" | "risks" | "flow";

function ProjectPage({ viewer, people, id, onBack }: { viewer: string; people: Employee[]; id: string; onBack: () => void }) {
  const [d, setD] = useState<ProjectDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [section, setSection] = useState<Section>("plan");
  const act = useAction();

  const load = useCallback(async () => {
    try {
      setD(await api.project(viewer, id));
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not load the project");
    }
  }, [viewer, id]);

  useEffect(() => {
    void load();
  }, [load]);

  const change = (fn: () => Promise<string>) =>
    act.run(async () => {
      const msg = await fn();
      await load();
      return msg;
    });

  if (err) {
    return (
      <div className="space-y-3">
        <Button onClick={onBack}>← All projects</Button>
        <Empty>{err}</Empty>
      </div>
    );
  }
  if (!d) return <Spinner label="Loading…" />;

  const p = d.project;
  const pr = d.progress;
  const latest = d.updates[0];

  return (
    <div className="space-y-5">
      <Toast message={act.message} tone={act.tone} onDone={act.clear} />
      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={onBack}>← All projects</Button>
        <h2 className="flex-1 text-lg font-semibold">{p.name}</h2>
        <Pill tone={p.status === "active" ? "ok" : "mut"}>{p.status.replace("_", " ")}</Pill>
        <Pill tone={HEALTH_TONE[p.health]}>{p.health}</Pill>
      </div>

      {p.purpose ? (
        <Card className="p-4">
          <h3 className="mb-1 text-xs font-bold uppercase tracking-widest text-mut">Purpose</h3>
          <Words text={p.purpose} />
        </Card>
      ) : null}

      {/* Computed against claimed — the comparison the whole portal exists to make. */}
      <div className="grid gap-4 md:grid-cols-2">
        <Card className="p-4">
          <h3 className="mb-2 text-xs font-bold uppercase tracking-widest text-mut">Where it actually is</h3>
          {pr ? (
            <>
              <Computed pct={pr.progress_pct} source={pr.progress_source} elapsed={pr.schedule_elapsed_pct} behind={pr.behind} />
              <p className="mt-2 text-xs text-mut">
                {pr.tasks_done} of {pr.tasks_total} task(s) done
                {pr.milestones_total > 0 ? ` · ${pr.milestones_done} of ${pr.milestones_total} milestone(s)` : ""}
                {pr.schedule_elapsed_pct != null ? ` · ${pr.schedule_elapsed_pct}% of the planned time used` : " · no dates set, so no schedule opinion"}
              </p>
              {latest?.pct_reported != null ? (
                <p className="mt-2 text-xs">
                  <span className="text-warn">Last reported: {latest.pct_reported}%</span>
                  <span className="text-mut">
                    {" "}by {latest.author_name ?? "someone"} on {dmon(latest.created_at)}
                    {latest.pct_reported !== pr.progress_pct
                      ? ` — ${Math.abs(latest.pct_reported - pr.progress_pct)} points ${latest.pct_reported > pr.progress_pct ? "above" : "below"} what the work shows`
                      : " — matching the work"}
                  </span>
                </p>
              ) : null}
            </>
          ) : (
            <Empty>No progress yet.</Empty>
          )}
        </Card>
        <Card className="p-4">
          <h3 className="mb-2 text-xs font-bold uppercase tracking-widest text-mut">Health</h3>
          <p className="text-sm">
            <Pill tone={HEALTH_TONE[p.health]}>{p.health}</Pill>{" "}
            {p.health_note ? <span className="text-mut">{p.health_note}</span> : <span className="text-mut">no reason recorded</span>}
          </p>
          {p.health_updated_at ? <p className="mt-1 text-xs text-mut">Judged {dmon(p.health_updated_at)} {hhmm(p.health_updated_at)}</p> : null}
          {d.may.manage ? <HealthForm viewer={viewer} id={id} current={p.health} onDone={change} busy={act.busy} /> : null}
          <p className="mt-2 text-xs text-mut">
            Lead: {p.lead_name ?? "nobody"}{p.sponsor_name ? ` · Sponsor: ${p.sponsor_name}` : ""}
            {p.target_date ? ` · Target ${dmon(p.target_date)}` : ""}
          </p>
        </Card>
      </div>

      <nav className="flex flex-wrap gap-1.5">
        {([
          ["plan", `📐 Plan (${d.requirements.length + d.milestones.length})`],
          ["work", `🧰 Work (${d.tasks.length})`],
          ["log", `📝 Status log (${d.updates.length})`],
          ["risks", `⚠️ Risks (${d.issues.filter((i) => i.status === "open" || i.status === "mitigating").length})`],
          ["flow", "📈 Flow"],
        ] as [Section, string][]).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setSection(key)}
            className={`rounded-lg border px-3 py-1.5 text-sm ${section === key ? "border-ok bg-ok/10 font-semibold text-ok" : "border-edge bg-panel hover:border-link"}`}
          >
            {label}
          </button>
        ))}
      </nav>

      {section === "plan" && <PlanSection d={d} viewer={viewer} id={id} change={change} busy={act.busy} />}
      {section === "work" && <WorkSection d={d} />}
      {section === "log" && <LogSection d={d} viewer={viewer} id={id} change={change} busy={act.busy} />}
      {section === "risks" && <RisksSection d={d} viewer={viewer} id={id} people={people} change={change} busy={act.busy} />}
      {section === "flow" && <FlowSection d={d} />}

      <MembersCard d={d} viewer={viewer} id={id} people={people} change={change} busy={act.busy} />
    </div>
  );
}

function HealthForm({
  viewer, id, current, onDone, busy,
}: { viewer: string; id: string; current: ProjectHealth; onDone: (fn: () => Promise<string>) => void; busy: boolean }) {
  const [health, setHealth] = useState<ProjectHealth>(current);
  const [note, setNote] = useState("");
  return (
    <div className="mt-3 space-y-2 border-t border-edge pt-3">
      <div className="grid gap-2 sm:grid-cols-[130px_1fr]">
        <Select
          label="Set health"
          value={health}
          onChange={(v) => setHealth(v as ProjectHealth)}
          options={[{ value: "green", label: "🟢 Green" }, { value: "amber", label: "🟡 Amber" }, { value: "red", label: "🔴 Red" }]}
        />
        <TextField label="Why" value={note} onChange={setNote} placeholder="What changed your mind?" maxLength={1000} />
      </div>
      <Button
        busy={busy}
        disabled={note.trim().length < 3}
        onClick={() => onDone(async () => { await api.setHealth(viewer, id, health, note.trim()); setNote(""); return "Health recorded."; })}
      >
        Save health
      </Button>
    </div>
  );
}

// ── Plan ──────────────────────────────────────────────────────────────────────

function PlanSection({
  d, viewer, id, change, busy,
}: { d: ProjectDetail; viewer: string; id: string; change: (fn: () => Promise<string>) => void; busy: boolean }) {
  const [text, setText] = useState("");
  const [kind, setKind] = useState<RequirementKind>("requirement");
  const [priority, setPriority] = useState<Moscow>("must");
  const [acceptance, setAcceptance] = useState("");
  const [mName, setMName] = useState("");
  const [mDue, setMDue] = useState("");
  const [mWeight, setMWeight] = useState("1");
  const [confirming, setConfirming] = useState<string | null>(null);

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card className="p-4">
        <h3 className="mb-1 font-semibold">What it must deliver</h3>
        <p className="mb-3 text-xs text-mut">
          MoSCoW. <b>Won&rsquo;t</b> is the half people skip — writing down what is out of scope is what stops it being argued back in.
        </p>
        {d.requirements.length === 0 ? <Empty>Nothing written down yet.</Empty> : null}
        <ul className="space-y-2">
          {d.requirements.map((r) => (
            <li key={r.id} className="rounded-lg border border-edge p-2 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <Pill tone={MOSCOW_TONE[r.priority]}>{MOSCOW_LABEL[r.priority]}</Pill>
                <span className="text-xs text-mut">{r.kind}</span>
                {r.status !== "open" ? <Pill tone={r.status === "met" ? "ok" : "mut"}>{r.status}</Pill> : null}
                <span className="flex-1" />
                {d.may.manage && r.status === "open" ? (
                  <>
                    <Button busy={busy} onClick={() => change(async () => { await api.setRequirement(viewer, r.id, "met"); return "Marked met."; })}>✓ Met</Button>
                    <Button busy={busy} onClick={() => change(async () => { await api.setRequirement(viewer, r.id, "dropped"); return "Dropped."; })}>Drop</Button>
                  </>
                ) : null}
              </div>
              <p className="mt-1">{r.text}</p>
              {r.acceptance ? <p className="mt-0.5 text-xs text-mut">How we will know: {r.acceptance}</p> : null}
            </li>
          ))}
        </ul>
        {d.may.manage ? (
          <div className="mt-3 space-y-2 border-t border-edge pt-3">
            <TextField label="Add a requirement" value={text} onChange={setText} maxLength={2000} placeholder="Fill 500 bottles an hour" />
            <div className="grid gap-2 sm:grid-cols-2">
              <Select label="Kind" value={kind} onChange={(v) => setKind(v as RequirementKind)} options={[
                { value: "requirement", label: "Requirement" }, { value: "need", label: "Need" },
                { value: "constraint", label: "Constraint" }, { value: "assumption", label: "Assumption" },
              ]} />
              <Select label="Priority" value={priority} onChange={(v) => setPriority(v as Moscow)} options={[
                { value: "must", label: "Must" }, { value: "should", label: "Should" },
                { value: "could", label: "Could" }, { value: "wont", label: "Won't" },
              ]} />
            </div>
            <TextField label="How we will know it is met" value={acceptance} onChange={setAcceptance} maxLength={2000} placeholder="Measured over one full shift" />
            <Button
              busy={busy}
              disabled={text.trim().length < 3}
              onClick={() => change(async () => {
                await api.addRequirement(viewer, id, { text: text.trim(), kind, priority, acceptance: acceptance.trim() || null });
                setText(""); setAcceptance("");
                return "Requirement added.";
              })}
            >
              Add
            </Button>
          </div>
        ) : null}
      </Card>

      <Card className="p-4">
        <h3 className="mb-1 font-semibold">When</h3>
        <p className="mb-3 text-xs text-mut">
          Weight is a milestone&rsquo;s share of the project&rsquo;s progress — so a two-month milestone need not count the same as a two-day one.
        </p>
        {d.milestones.length === 0 ? <Empty>No milestones yet.</Empty> : null}
        <ul className="space-y-2">
          {d.milestones.map((m) => (
            <li key={m.id} className="rounded-lg border border-edge p-2 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <b className="flex-1">{m.name}</b>
                <span className="text-xs text-mut">weight {m.weight}</span>
                {m.due_date ? <span className={`text-xs ${m.overdue ? "text-crit" : "text-mut"}`}>{dmon(m.due_date)}</span> : null}
                {m.overdue ? <Pill tone="crit">overdue</Pill> : null}
                <Pill tone={m.status === "done" ? "ok" : "mut"}>{m.status}</Pill>
              </div>
              <p className="mt-0.5 text-xs text-mut">{m.tasks_done} of {m.tasks_total} task(s) done</p>
              {d.may.manage && m.status === "open" ? (
                confirming === m.id ? (
                  <div className="mt-2 space-y-1.5 rounded-lg border border-warn/60 bg-warn/5 p-2">
                    <p className="text-xs text-warn">
                      {m.tasks_total - m.tasks_done} task(s) under this milestone are not finished. Marking it done anyway is recorded as forced.
                    </p>
                    <div className="flex gap-2">
                      <Button tone="danger" busy={busy} onClick={() => change(async () => { await api.setMilestone(viewer, m.id, "done", true); setConfirming(null); return "Marked done — recorded as forced."; })}>Mark done anyway</Button>
                      <Button onClick={() => setConfirming(null)}>Cancel</Button>
                    </div>
                  </div>
                ) : (
                  <div className="mt-2">
                    <Button
                      busy={busy}
                      onClick={() =>
                        change(async () => {
                          try {
                            await api.setMilestone(viewer, m.id, "done");
                            return "Milestone reached.";
                          } catch (e) {
                            // The API refuses over open work; ask rather than silently forcing.
                            if (e instanceof Error && /not finished/.test(e.message)) {
                              setConfirming(m.id);
                              return "";
                            }
                            throw e;
                          }
                        })
                      }
                    >
                      ✓ Reached
                    </Button>
                  </div>
                )
              ) : null}
            </li>
          ))}
        </ul>
        {d.may.manage ? (
          <div className="mt-3 space-y-2 border-t border-edge pt-3">
            <TextField label="Add a milestone" value={mName} onChange={setMName} maxLength={160} placeholder="Line installed" />
            <div className="grid gap-2 sm:grid-cols-2">
              <DateField label="Due" value={mDue} onChange={setMDue} />
              <TextField label="Weight" value={mWeight} onChange={setMWeight} type="number" hint="1–100" />
            </div>
            <Button
              busy={busy}
              disabled={mName.trim().length < 2}
              onClick={() => change(async () => {
                await api.addMilestone(viewer, id, { name: mName.trim(), dueDate: mDue || null, weight: Math.max(1, Math.min(100, Number(mWeight) || 1)) });
                setMName(""); setMDue(""); setMWeight("1");
                return "Milestone added.";
              })}
            >
              Add
            </Button>
          </div>
        ) : null}
      </Card>
    </div>
  );
}

// ── Work ──────────────────────────────────────────────────────────────────────

function WorkSection({ d }: { d: ProjectDetail }) {
  const byMilestone = useMemo(() => {
    const groups = new Map<string | null, ProjectDetail["tasks"]>();
    for (const t of d.tasks) {
      const key = t.milestone_id;
      groups.set(key, [...(groups.get(key) ?? []), t]);
    }
    return groups;
  }, [d.tasks]);

  if (d.tasks.length === 0) {
    return <Empty>No work filed under this project yet. Open a task and file it here from the task portal.</Empty>;
  }
  return (
    <div className="space-y-4">
      {[...d.milestones.map((m) => [m.id, m.name] as const), [null, "Not under a milestone"] as const].map(([mid, label]) => {
        const rows = byMilestone.get(mid) ?? [];
        if (rows.length === 0) return null;
        return (
          <div key={mid ?? "none"}>
            <h4 className="mb-1 text-sm font-semibold">{label} <span className="text-xs font-normal text-mut">{rows.length} task(s)</span></h4>
            <DataTable
              rows={rows}
              columns={[
                { head: "Task", cell: (t) => t.title },
                { head: "Who", cell: (t) => t.employee_name },
                { head: "Status", cell: (t) => <Pill tone={t.status_category === "done" ? "ok" : t.status_category === "in_progress" ? "warn" : "mut"}>{t.status}</Pill>, tight: true },
                {
                  head: "Progress",
                  cell: (t) => (
                    <span className="whitespace-nowrap text-xs" title={`${t.progress_pct}% — ${t.progress_source}`}>
                      <b>{t.progress_pct}%</b> <span className="text-mut">{t.progress_source === "self_reported" ? "self-reported" : t.progress_source}</span>
                    </span>
                  ),
                  tight: true,
                },
                { head: "Due", cell: (t) => (t.due_at ? dmon(t.due_at) : <span className="text-mut">—</span>), tight: true },
              ]}
              rowKey={(t) => t.id}
              empty="None."
            />
          </div>
        );
      })}
    </div>
  );
}

// ── Status log ────────────────────────────────────────────────────────────────

function LogSection({
  d, viewer, id, change, busy,
}: { d: ProjectDetail; viewer: string; id: string; change: (fn: () => Promise<string>) => void; busy: boolean }) {
  const [narrative, setNarrative] = useState("");
  const [pct, setPct] = useState("");
  const computed = d.progress?.progress_pct ?? 0;

  return (
    <div className="space-y-4">
      {d.may.contribute ? (
        <Card className="p-4">
          <h3 className="mb-1 font-semibold">Post a status update</h3>
          <p className="mb-3 text-xs text-mut">
            The work currently shows <b>{computed}%</b>. If you say something different, both numbers are kept — nobody
            is overruled, and the difference stays visible.
          </p>
          <div className="space-y-2">
            <TextArea label="What happened" value={narrative} onChange={setNarrative} rows={3} maxLength={4000} />
            <div className="grid gap-2 sm:grid-cols-[140px_1fr]">
              <TextField label="Where you think it is (%)" value={pct} onChange={setPct} type="number" hint="optional" />
            </div>
            <Button
              tone="primary"
              busy={busy}
              disabled={narrative.trim().length < 3}
              onClick={() => change(async () => {
                const n = pct.trim() === "" ? null : Math.max(0, Math.min(100, Number(pct)));
                const r = await api.addProjectUpdate(viewer, id, { narrative: narrative.trim(), pctReported: n });
                setNarrative(""); setPct("");
                return n != null && r.computedPct != null && n !== r.computedPct
                  ? `Recorded. You said ${n}%; the work shows ${r.computedPct}%. Both are kept.`
                  : "Update recorded.";
              })}
            >
              Post update
            </Button>
          </div>
        </Card>
      ) : null}

      {d.updates.length === 0 ? <Empty>Nothing has been reported on this project yet.</Empty> : null}
      <ul className="space-y-2">
        {d.updates.map((u) => (
          <li key={u.id} className="rounded-lg border border-edge p-3 text-sm">
            <div className="flex flex-wrap items-center gap-2 text-xs text-mut">
              <b className="text-ink">{u.author_name ?? "someone"}</b>
              <span>{dmon(u.created_at)} {hhmm(u.created_at)}</span>
              {u.pct_reported != null ? <Pill tone="warn">said {u.pct_reported}%</Pill> : null}
              {u.health ? <Pill tone={HEALTH_TONE[u.health]}>{u.health}</Pill> : null}
            </div>
            <Words text={u.narrative} />
          </li>
        ))}
      </ul>
    </div>
  );
}

// ── Risks ─────────────────────────────────────────────────────────────────────

function RisksSection({
  d, viewer, id, people, change, busy,
}: { d: ProjectDetail; viewer: string; id: string; people: Employee[]; change: (fn: () => Promise<string>) => void; busy: boolean }) {
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState<IssueKind>("risk");
  const [severity, setSeverity] = useState("medium");
  const [description, setDescription] = useState("");
  const [owner, setOwner] = useState("");
  const [handling, setHandling] = useState<string | null>(null);
  const [note, setNote] = useState("");

  return (
    <div className="space-y-4">
      <p className="text-xs text-mut">
        These are risks to the <b>plan</b>, reviewed as often as you review the project. A broken chiller on the floor is a
        blocker in the task portal, with a response window measured in minutes — deliberately a different thing.
      </p>
      {d.may.contribute ? (
        <Card className="p-4">
          <h3 className="mb-2 font-semibold">Raise something</h3>
          <div className="space-y-2">
            <TextField label="What is the problem?" value={title} onChange={setTitle} maxLength={300} />
            <div className="grid gap-2 sm:grid-cols-3">
              <Select label="Kind" value={kind} onChange={(v) => setKind(v as IssueKind)} options={[
                { value: "risk", label: "Risk — might happen" }, { value: "issue", label: "Issue — has happened" },
                { value: "dependency", label: "Dependency" }, { value: "decision", label: "Decision needed" },
              ]} />
              <Select label="Severity" value={severity} onChange={setSeverity} options={[
                { value: "low", label: "Low" }, { value: "medium", label: "Medium" },
                { value: "high", label: "High" }, { value: "critical", label: "Critical" },
              ]} />
              <PersonPicker label="Owner" value={owner} onChange={setOwner} people={people} />
            </div>
            <TextArea label="Detail (optional)" value={description} onChange={setDescription} rows={2} maxLength={4000} />
            <p className="text-xs text-mut">High and critical tell everyone on the project straight away.</p>
            <Button
              busy={busy}
              disabled={title.trim().length < 3}
              onClick={() => change(async () => {
                await api.raiseIssue(viewer, id, { title: title.trim(), kind, severity, description: description.trim() || null, ownerId: owner || null });
                setTitle(""); setDescription(""); setOwner("");
                return "Raised.";
              })}
            >
              Raise
            </Button>
          </div>
        </Card>
      ) : null}

      {d.issues.length === 0 ? <Empty>Nothing raised. 🎉</Empty> : null}
      <ul className="space-y-2">
        {d.issues.map((i) => {
          const live = i.status === "open" || i.status === "mitigating";
          return (
            <li key={i.id} className={`rounded-lg border p-3 text-sm ${live ? "border-edge" : "border-edge opacity-70"}`}>
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <Severity value={i.severity} />
                <span className="text-mut">{i.kind}</span>
                <Pill tone={i.status === "resolved" ? "ok" : i.status === "accepted" ? "mut" : i.status === "mitigating" ? "warn" : "crit"}>{i.status}</Pill>
                {i.owner_name ? <span className="text-mut">owner: {i.owner_name}</span> : null}
                <span className="flex-1" />
                <span className="text-mut">{dmon(i.created_at)}</span>
              </div>
              <p className="mt-1 font-semibold">{i.title}</p>
              {i.description ? <Words text={i.description} /> : null}
              {i.mitigation ? <p className="mt-1 text-xs text-warn">Being handled: {i.mitigation}</p> : null}
              {i.resolution_note ? <p className="mt-1 text-xs text-ok">{i.status === "accepted" ? "Accepted" : "Resolved"}: {i.resolution_note}</p> : null}
              {d.may.contribute && live ? (
                handling === i.id ? (
                  <div className="mt-2 space-y-2">
                    <TextArea label="What is being done / what was decided" value={note} onChange={setNote} rows={2} maxLength={2000} />
                    <div className="flex flex-wrap gap-2">
                      {(["mitigating", "resolved", "accepted"] as const).map((st) => (
                        <Button
                          key={st}
                          tone={st === "resolved" ? "primary" : "quiet"}
                          busy={busy}
                          disabled={note.trim().length < 3}
                          onClick={() => change(async () => {
                            await api.setIssue(viewer, i.id, st, note.trim());
                            setHandling(null); setNote("");
                            return st === "accepted" ? "Accepted — we live with it." : st === "resolved" ? "Resolved." : "Marked as being handled.";
                          })}
                        >
                          {st === "mitigating" ? "Handling it" : st === "resolved" ? "Resolved" : "Accept the risk"}
                        </Button>
                      ))}
                      <Button onClick={() => setHandling(null)}>Cancel</Button>
                    </div>
                  </div>
                ) : (
                  <div className="mt-2"><Button onClick={() => setHandling(i.id)}>Update it</Button></div>
                )
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ── Flow ──────────────────────────────────────────────────────────────────────

function FlowSection({ d }: { d: ProjectDetail }) {
  const f = d.flow;
  // Two different nothings, said accurately: no work filed at all, versus work filed but
  // none finished. "No finished work" would be wrong for the first and misleading for both.
  if (!f) {
    return (
      <Empty>
        {d.tasks.length === 0
          ? "No work is filed under this project yet, so there is nothing to measure."
          : "Its work has not produced a finished item yet, so there is nothing to measure."}
      </Empty>
    );
  }
  const cell = (label: string, value: string | number | null, hint: string) => (
    <Card className="p-3">
      <div className="text-xs text-mut">{label}</div>
      <div className="text-xl font-bold">{value ?? "—"}</div>
      <div className="mt-0.5 text-[11px] text-mut">{hint}</div>
    </Card>
  );
  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {cell("Work in progress", f.wip, "started and not finished — the number to keep small")}
        {cell("Oldest open item", f.oldest_open_days != null ? `${f.oldest_open_days} d` : null, "Work Item Age — the only one that warns you early")}
        {cell("Finished last 7 days", f.throughput_7d, `${f.throughput_28d} in the last 28`)}
        {cell("Cycle time (median)", f.cycle_p50_days != null ? `${f.cycle_p50_days} d` : null, `85th percentile ${f.cycle_p85_days ?? "—"} d · 95th ${f.cycle_p95_days ?? "—"} d`)}
      </div>
      <p className="text-xs text-mut">
        Percentiles, never an average: half of finished work took {f.cycle_p50_days ?? "—"} days or less, and 85% took{" "}
        {f.cycle_p85_days ?? "—"} days or less. Quote the 85th when someone asks how long one thing will take.
        There is deliberately no schedule index or earned-value figure here — they need a cost baseline this company
        does not keep, and a made-up one would be worse than none.
      </p>
    </div>
  );
}

// ── Members ───────────────────────────────────────────────────────────────────

function MembersCard({
  d, viewer, id, people, change, busy,
}: { d: ProjectDetail; viewer: string; id: string; people: Employee[]; change: (fn: () => Promise<string>) => void; busy: boolean }) {
  const [who, setWho] = useState("");
  return (
    <Card className="p-4">
      <h3 className="mb-1 font-semibold">Who is on it</h3>
      <p className="mb-2 text-xs text-mut">Members can see the project and are told when it turns red or hits a serious problem.</p>
      <div className="flex flex-wrap items-center gap-2">
        {d.members.map((m) => (
          <Pill key={m.employee_id} tone={m.role === "lead" || m.role === "sponsor" ? "ok" : "mut"}>
            {m.name} · {m.role}
          </Pill>
        ))}
        {d.members.length === 0 ? <span className="text-xs text-mut">Nobody yet.</span> : null}
      </div>
      {d.may.manage ? (
        <div className="mt-3 grid items-end gap-2 border-t border-edge pt-3 sm:grid-cols-[1fr_auto]">
          <PersonPicker label="Add someone" value={who} onChange={setWho} people={people} />
          <Button
            busy={busy}
            disabled={!who}
            onClick={() => change(async () => { await api.addProjectMember(viewer, id, who); setWho(""); return "Added."; })}
          >
            Add
          </Button>
        </div>
      ) : null}
    </Card>
  );
}
