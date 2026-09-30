import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  companyToday,
  dmon,
  hhmm,
  onConsentRequired,
  progressLabel,
  type ActivityRow,
  type Assignment,
  type Blocker,
  type DayUpdate,
  type DocumentPlan,
  type Employee,
  type EodReport,
  type Health,
  type Me,
  type NeedsReview,
  type OpenTask,
  type QueryAnswer,
  type EraseReason,
  type WeekDay,
} from "./lib/api";
import { Age, Card, DataTable, Demo, Empty, Pill, Severity, Spinner, Words, type Column } from "./components/ui";
import { Button, PersonPicker, TextArea, TextField, Toast, useAction } from "./components/form";
import { TaskDetailPanel } from "./components/task-detail";
import { AlertsTab, ConsentGate, InboxBell, InstallApp } from "./components/alerts";
import { ProjectsPortal } from "./components/projects";
import { useLiveUpdates } from "./lib/live";
import { ThemeToggle } from "./components/theme-toggle";
import { Icon, type IconName } from "./components/icons";
import { WeekChart } from "./components/week-chart";
import { SearchBox, type SearchHit } from "./components/search";
import { Hero } from "./components/hero";
import { Chips, ProgressReport, StatusReport } from "./components/quick";
import { useMedia, WIDE } from "./lib/media";

type TabId = "today" | "mine" | "carry" | "assign" | "alerts" | "eod" | "people" | "activity" | "ask" | "more";

/** Present only when sign-in is real; the viewer is then fixed by who you are. */
export interface Identity {
  name: string;
  isCeo: boolean;
  onSignOut: () => void;
}

const TABS: { id: TabId; icon: IconName; label: string; group: string; blurb: string }[] = [
  { id: "today", icon: "grid", label: "Overview", group: "Today", blurb: "what everyone reported on this date" },
  { id: "mine", icon: "user", label: "My work", group: "Today", blurb: "your open tasks — report on them here or in the bot" },
  { id: "carry", icon: "clock", label: "Carry-over", group: "Today", blurb: "still open, grouped by the day it was raised" },
  { id: "assign", icon: "pin", label: "Assignments", group: "Work", blurb: "who was given what, and whether it arrived" },
  { id: "alerts", icon: "bell", label: "Alerts", group: "Work", blurb: "who is told what, when — and what happens if nobody answers" },
  { id: "eod", icon: "barChart", label: "End of day", group: "Work", blurb: "one stored report per person per day" },
  { id: "people", icon: "users", label: "People", group: "Records", blurb: "everyone this viewer is allowed to see" },
  { id: "activity", icon: "scroll", label: "Activity", group: "Records", blurb: "the audit trail, newest first" },
  { id: "ask", icon: "search", label: "Ask", group: "Tools", blurb: "answered by SQL, with the SQL shown" },
  // The phone's menu page. Not in the sidebar (the sidebar IS the menu on a wide screen).
  { id: "more", icon: "menu", label: "More", group: "Phone", blurb: "every other page, search, and this device" },
];

/** Company day `n` days from `day` (both `YYYY-MM-DD`). Dubai has no daylight saving. */
function shiftDay(day: string, n: number): string {
  const d = new Date(new Date(`${day}T12:00:00+04:00`).getTime() + n * 86_400_000);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Dubai", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

interface Data {
  day: DayUpdate[];
  open: OpenTask[];
  assignments: Assignment[];
  eod: EodReport[];
  people: Employee[];
  activity: ActivityRow[];
  review: NeedsReview[];
  blockers: Blocker[];
  /** The last seven company days, counted by Postgres. */
  week: WeekDay[];
  /** Who the API thinks is asking — the uuid the browser needs to tell "mine" from "theirs". */
  me: Me | null;
}

/** The board's refresh, as a number children can depend on — no second timer. */
function tickOf(loadedAt: Date | null): number {
  return loadedAt ? loadedAt.getTime() : 0;
}

export type Portal = "tasks" | "projects";

/**
 * One hash, two portals: `#tasks/<tab>` and `#projects[/<project id>]`. A bare `#<tab>` is
 * still understood, so links shared before the project portal existed keep working.
 */
function readHash(): { portal: Portal; tab: TabId; projectId: string | null } {
  const [head = "", rest = ""] = location.hash.slice(1).split("/", 2);
  if (head === "projects") return { portal: "projects", tab: "today", projectId: rest || null };
  const tab = (head === "tasks" ? rest : head) as TabId;
  return { portal: "tasks", tab: TABS.some((t) => t.id === tab) ? tab : "today", projectId: null };
}

export default function App({
  identity,
  isDemo = false,
  initialPortal,
  onPortalChange,
}: {
  identity?: Identity;
  /** Whether this build serves synthetic data, from the API. Drives the DEMO badge. */
  isDemo?: boolean;
  /** Which portal the picker sent us to; the hash still wins if it names one. */
  initialPortal?: Portal;
  /** Told whenever the portal changes, so the shell can remember it for next time. */
  onPortalChange?: (p: Portal) => void;
}) {
  const [viewer, setViewer] = useState(identity && !identity.isCeo ? "me" : "ceo");
  // Wide: sidebar + header, as before. Narrow: the phone app — a title bar, one page at a
  // time, and a tab bar at the bottom. Only one of the two is ever mounted.
  const wide = useMedia(WIDE);
  // The Ask box and report generation are the CEO's under real sign-in (the API refuses
  // them otherwise); hide them rather than show buttons that can only fail.
  const ceoTools = !identity || identity.isCeo;
  const [date, setDate] = useState(companyToday());
  // The hash wins (a shared link is explicit); otherwise the portal the picker chose.
  const [portal, setPortalState] = useState<Portal>(() => {
    const fromHash = location.hash.slice(1).split("/", 1)[0];
    if (fromHash === "projects" || fromHash === "tasks") return readHash().portal;
    return initialPortal ?? readHash().portal;
  });
  const setPortal = useCallback(
    (p: Portal) => {
      setPortalState(p);
      onPortalChange?.(p);
    },
    [onPortalChange],
  );
  const [tab, setTabState] = useState<TabId>(() => readHash().tab);
  const [projectId, setProjectId] = useState<string | null>(() => readHash().projectId);
  const [data, setData] = useState<Data | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loadedAt, setLoadedAt] = useState<Date | null>(null);
  const [busy, setBusy] = useState(false);
  /** The task open in the side panel, with its owner so the panel knows what it may change. */
  const [openTask, setOpenTask] = useState<{ id: string; ownerId: string } | null>(null);
  /**
   * Whether the signed-in person has consent on record. Only asked under real sign-in: in
   * demo mode the viewer is a label you can switch, and consent is a person's own act.
   */
  const [consented, setConsented] = useState<boolean | null>(identity ? null : true);
  useEffect(() => {
    if (!identity) return;
    let cancelled = false;
    void api
      .consent(viewer)
      // Consent to an OLDER notice is not consent to this one: the gate shows the new words.
      .then((c) => { if (!cancelled) setConsented(c.current); })
      // If the check itself fails, do not lock the person out of the board over it; the
      // Alerts tab's consent card will show the state once the API answers.
      .catch(() => { if (!cancelled) setConsented(true); });
    return () => { cancelled = true; };
  }, [identity, viewer]);
  // If the notice changes while the app is open, the API starts refusing data; show the new
  // notice rather than a board of errors.
  useEffect(() => {
    if (identity) onConsentRequired(() => setConsented(false));
  }, [identity]);

  const load = useCallback(async () => {
    // Nothing is fetched for a signed-in person until they have consented (or the check is
    // still running) — their board is data about them and their colleagues.
    if (consented !== true) return;
    setBusy(true);
    try {
      const [day, open, assignments, eod, people, activity, review, blockers, h, me, week] = await Promise.all([
        api.day(viewer, date),
        api.openTasks(viewer),
        api.assignments(viewer),
        api.eod(viewer, date).catch(() => [] as EodReport[]),
        api.employees(viewer),
        api.activity(viewer).catch(() => [] as ActivityRow[]),
        api.needsReview(viewer).catch(() => [] as NeedsReview[]),
        api.blockers(viewer).catch(() => [] as Blocker[]),
        api.health().catch(() => null),
        api.me(viewer).catch(() => null),
        api.week(viewer, date).catch(() => [] as WeekDay[]),
      ]);
      setData({ day, open, assignments, eod, people, activity, review, blockers, week, me });
      setHealth(h);
      setLoadedAt(new Date());
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not reach the API");
    } finally {
      setBusy(false);
    }
  }, [viewer, date, consented]);

  useEffect(() => {
    void load();
  }, [load]);

  // A notification tap lands on `/app/?task=<id>#tasks/<tab>` (see presentationOf in
  // core/alerts.ts). Open that task's panel once the board has loaded, then drop the
  // parameter so a refresh does not re-open it and a shared link carries no stale id.
  useEffect(() => {
    if (!data) return;
    const params = new URLSearchParams(location.search);
    const id = params.get("task");
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) return;
    params.delete("task");
    const qs = params.toString();
    history.replaceState(null, "", `${location.pathname}${qs ? `?${qs}` : ""}${location.hash}`);
    setOpenTask({ id, ownerId: data.open.find((t) => t.id === id)?.employee_id ?? data.me?.employeeId ?? "" });
  }, [data]);

  // Postgres says when something changed; the poll inside this hook stays as the fallback,
  // so losing the stream degrades to the old 20-second refresh rather than to a dead board.
  const live = useLiveUpdates(() => void load());

  // A shared `#tasks/ask` link opened by a non-CEO used to render the "Ask" heading over an
  // empty pane with no nav item highlighted: the tab is real but its content is CEO-only.
  // Resolve it once, here, to something the viewer can actually see — the nav highlight,
  // the rendered pane and the URL all follow this rather than the raw hash.
  const visibleTab: TabId = tab === "ask" && !ceoTools ? "today" : tab;
  const setTab = setTabState;

  // Keep the place in the URL so a refresh or a shared link lands where you were — and make each
  // page a step in the browser's history, so a phone's back gesture goes back a page instead of
  // closing the app. The first sync replaces rather than pushes: opening a link adds no entry.
  const synced = useRef(false);
  useEffect(() => {
    const want = portal === "projects" ? `#projects${projectId ? `/${projectId}` : ""}` : `#tasks/${visibleTab}`;
    if (location.hash !== want) {
      if (synced.current) history.pushState(null, "", want);
      else history.replaceState(null, "", want);
    }
    synced.current = true;
  }, [portal, visibleTab, projectId]);

  // An open task is a step in history too (the phone shows it as its own page): Back closes it.
  const taskEntry = () => (history.state as { task?: boolean } | null)?.task === true;
  useEffect(() => {
    if (openTask && !taskEntry()) history.pushState({ task: true }, "", location.href);
  }, [openTask]);
  const closeTask = useCallback(() => {
    // Closed from the page itself: consume its history entry, and let popstate do the closing.
    if (taskEntry()) history.back();
    else setOpenTask(null);
  }, []);

  // Back and forward: the URL is the truth. An open task closes; the page follows the hash.
  useEffect(() => {
    const onPop = () => {
      setOpenTask(null);
      const h = readHash();
      setPortal(h.portal);
      setTabState(h.tab);
      setProjectId(h.projectId);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [setPortal]);

  const derived = useMemo(() => {
    if (!data) return null;
    const done = data.day.filter((u) => u.status === "done");
    const pending = data.day.filter((u) => u.status === "pending" || u.status === "in_progress");
    const blocked = data.day.filter((u) => u.status === "blocker");
    const openBlockers = data.blockers.filter((b) => b.status === "open");
    const urgent = openBlockers.filter((b) => b.severity === "critical" || b.severity === "high");
    const overdue = data.open.filter((t) => t.age_days > 0);
    const mine = data.me ? data.open.filter((t) => t.employee_id === data.me!.employeeId) : [];
    return { done, pending, blocked, openBlockers, urgent, overdue, mine };
  }, [data]);

  // A manager or lead gets the assign tools; the API refuses everyone else anyway.
  const canGiveWork = data?.me ? data.me.accessRole !== "employee" : ceoTools;

  const counts: Record<TabId, number | null> = {
    today: data?.day.length ?? null,
    mine: derived?.mine.length ?? null,
    carry: derived?.overdue.length ?? null,
    assign: data?.assignments.length ?? null,
    alerts: null,
    eod: data?.eod.length ?? null,
    people: data?.people.length ?? null,
    activity: data?.activity.length ?? null,
    ask: null,
    more: null,
  };

  // The phone's tab bar: the four places a person goes every day, and More for the rest.
  // Whoever can give work out gets Assign in the middle; everyone else gets Projects there.
  const thirdTab: TabId | "projects" = canGiveWork ? "assign" : "projects";
  const phoneTabs: { id: TabId | "projects"; icon: IconName; label: string; badge?: number; urgent?: boolean }[] = [
    { id: "today", icon: "home", label: "Home" },
    { id: "mine", icon: "clipboardCheck", label: "My work", badge: derived?.mine.length ?? 0 },
    thirdTab === "assign" ? { id: "assign", icon: "pin", label: "Assign" } : { id: "projects", icon: "folder", label: "Projects" },
    { id: "alerts", icon: "bell", label: "Alerts", badge: derived?.urgent.length ?? 0, urgent: true },
    { id: "more", icon: "menu", label: "More" },
  ];
  const onPhoneTab = portal === "tasks" && phoneTabs.some((p) => p.id === visibleTab);
  // A page reached from More gets a Back arrow to More; a project gets one to the list.
  const phoneBack: (() => void) | null =
    portal === "projects" ? (projectId ? () => setProjectId(null) : null) : onPhoneTab ? null : () => setTab("more");
  const phoneTitle = portal === "projects" ? "Projects" : visibleTab === "today" ? "FreshNow" : (TABS.find((t) => t.id === visibleTab)?.label ?? "");
  const goPhoneTab = (id: TabId | "projects") => {
    if (id === "projects") setPortal("projects");
    else { setPortal("tasks"); setTab(id); }
    window.scrollTo({ top: 0 });
  };

  const active = TABS.find((t) => t.id === visibleTab)!;

  // The search jumps to whatever shows the thing: a person → People, a task → its drawer,
  // a problem → the overview, an assignment → Assignments.
  const onSearchPick = (h: SearchHit) => {
    setPortal("tasks");
    if (h.kind === "person") setTab("people");
    else if (h.kind === "assignment") setTab("assign");
    else if (h.kind === "blocker") setTab("today");
    else if (h.kind === "task") {
      const t = data?.open.find((x) => x.id === h.id);
      if (t) setOpenTask({ id: t.id, ownerId: t.employee_id });
    }
  };

  const displayName = identity?.name ?? data?.me?.displayName ?? "there";
  const roleLabel = data?.me?.isCeo ? "CEO" : data?.me?.accessRole === "manager" ? "Manager" : data?.me?.accessRole === "lead" ? "Dept lead" : identity ? "Employee" : "Viewer";
  const attention = (derived?.urgent.length ?? 0) + (data?.review.length ?? 0);
  const hour = Number(new Intl.DateTimeFormat("en-GB", { hour: "numeric", hour12: false, timeZone: "Asia/Dubai" }).format(new Date()));
  const greeting = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
  // "Saturday, 19 September" in company time — the hero says the day in words, because a
  // person reading "2026-09-19" has to decode it.
  const dateLabel = new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "Asia/Dubai" })
    .format(new Date(`${date}T12:00:00+04:00`));

  const navItem = (t: (typeof TABS)[number]) => {
    const I = Icon[t.icon];
    const on = visibleTab === t.id && portal === "tasks";
    return (
      <button
        key={t.id}
        onClick={() => { setPortal("tasks"); setTab(t.id); }}
        aria-current={on ? "page" : undefined}
        title={t.blurb}
        className={`group relative flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-sm transition-colors ${
          on ? "bg-ok/12 font-semibold text-ok" : "text-ink hover:bg-sunken"
        }`}
      >
        {on ? <span className="absolute left-0 top-1/2 h-6 w-1 -translate-y-1/2 rounded-r" style={{ background: "linear-gradient(180deg, var(--color-brand-a), var(--color-brand-b))" }} /> : null}
        <span className={on ? "text-ok" : "text-mut group-hover:text-ink"}><I size={18} /></span>
        <span className="flex-1">{t.label}</span>
        {counts[t.id] !== null ? (
          <span className={`rounded-full px-2 py-0.5 text-[11px] tabular-nums ${on ? "bg-ok/15 text-ok" : "bg-sunken text-mut"}`}>{counts[t.id]}</span>
        ) : null}
      </button>
    );
  };

  // After every hook, so the hook order never depends on consent. While the answer is still
  // coming, show nothing of the board: rendering it first and swapping in the notice a moment
  // later meant a person saw (and the browser fetched) their data before agreeing.
  if (consented === null) return <div className="grid min-h-screen place-items-center"><Spinner label="Checking your consent…" /></div>;
  if (consented === false) return <ConsentGate viewer={viewer} onAgreed={() => setConsented(true)} />;

  return (
    <div className="min-h-full lg:grid lg:grid-cols-[248px_1fr]">
      {/* ── Sidebar (wide screens only) ──────────────────────────────────────── */}
      {wide ? (
      <aside className="sticky top-0 flex h-screen flex-col border-r border-edge bg-panel">
        <div className="flex items-center gap-3 px-5 pb-4 pt-5">
          <span className="grid h-10 w-10 place-items-center rounded-xl text-on-brand shadow" style={{ background: "linear-gradient(135deg, var(--color-brand), var(--color-brand-b))" }}>
            <Icon.sparkle size={20} />
          </span>
          <span className="leading-tight">
            <span className="block text-base font-bold">FreshNow</span>
            <span className="block text-xs text-mut">Operations</span>
          </span>
          {isDemo ? <span className="ml-auto rounded bg-warn px-1.5 py-0.5 text-[10px] font-bold text-on-accent">DEMO</span> : null}
        </div>

        {/* Two portals, one shell: day-to-day work, and work that has a plan and an end. */}
        <div className="mx-4 mb-4 grid grid-cols-2 rounded-xl border border-edge bg-sunken p-1 text-xs">
          {([["tasks", "clipboardCheck", "Tasks"], ["projects", "folder", "Projects"]] as [Portal, IconName, string][]).map(([id, ic, label]) => {
            const I = Icon[ic];
            return (
              <button
                key={id}
                onClick={() => setPortal(id)}
                aria-pressed={portal === id}
                className={`flex items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 ${portal === id ? "bg-panel font-semibold text-ink shadow-sm" : "text-mut hover:text-ink"}`}
              >
                <I size={14} /> {label}
              </button>
            );
          })}
        </div>

        <nav className="flex-1 overflow-y-auto px-3" aria-label="Sections">
          {["Today", "Work", "Records", "Tools"].map((group) => {
            const items = TABS.filter((t) => t.group === group && (ceoTools || t.id !== "ask"));
            if (items.length === 0) return null;
            return (
              <div key={group} className="mb-4">
                <h3 className="mb-1 px-3 text-[10px] font-bold uppercase tracking-widest text-mut">{group}</h3>
                <div className="space-y-0.5">{items.map(navItem)}</div>
              </div>
            );
          })}
        </nav>

        <div className="m-3 rounded-2xl border border-edge bg-canvas p-3">
          <div className="flex items-center gap-3">
            <span className="grid h-10 w-10 place-items-center rounded-full bg-ok/15 text-base font-bold text-ok">{displayName.trim().charAt(0).toUpperCase() || "?"}</span>
            <span className="min-w-0 leading-tight">
              <span className="block truncate text-sm font-semibold">{displayName}</span>
              <span className="block text-xs text-mut">{roleLabel}</span>
            </span>
          </div>
          {identity ? (
            <button
              onClick={identity.onSignOut}
              className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl border border-crit/40 bg-crit/10 px-3 py-2 text-sm font-semibold text-crit hover:bg-crit/20"
            >
              <Icon.logout size={16} /> Sign out
            </button>
          ) : null}
        </div>
      </aside>
      ) : null}

      <div className="min-w-0">
        {/* ── Header: the full toolbar on a wide screen, a title bar on a phone ── */}
        {!wide ? (
          <header className="sticky top-0 z-20 border-b border-edge bg-canvas/95 backdrop-blur">
            <div className="flex min-h-14 items-center gap-2 px-3 pb-2 pt-[max(0.5rem,env(safe-area-inset-top))]">
              {phoneBack ? (
                <button onClick={phoneBack} aria-label="Back" className="grid h-10 w-10 shrink-0 place-items-center rounded-xl text-link hover:bg-sunken">
                  <Icon.chevronLeft size={22} />
                </button>
              ) : (
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl text-on-brand" style={{ background: "linear-gradient(135deg, var(--color-brand), var(--color-brand-b))" }}>
                  <Icon.sparkle size={18} />
                </span>
              )}
              <div className="min-w-0 flex-1 leading-tight">
                <div className="flex items-center gap-1.5">
                  <h1 className="truncate text-lg font-bold">{phoneTitle}</h1>
                  {isDemo ? <span className="rounded bg-warn px-1.5 py-0.5 text-[10px] font-bold text-on-accent">DEMO</span> : null}
                </div>
                {err ? (
                  <div className="truncate text-[11px] text-crit">● {err}</div>
                ) : (
                  <div className="truncate text-[11px] text-mut">
                    <span className={live === "live" ? "text-ok" : "text-warn"}>● {live === "live" ? "live" : "refreshing every 20 s"}</span>
                    {" "}· updated {loadedAt ? hhmm(loadedAt.toISOString()) : "…"}
                  </div>
                )}
              </div>
              {attention ? (
                <button
                  onClick={() => goPhoneTab("today")}
                  aria-label={`${attention} need a human`}
                  className="relative grid h-10 w-10 place-items-center rounded-xl border border-crit/50 bg-crit/10 text-crit"
                >
                  <Icon.alert size={18} />
                  <span className="absolute -right-1 -top-1 rounded-full bg-crit px-1.5 text-[10px] font-bold text-on-accent">{attention}</span>
                </button>
              ) : null}
              <InboxBell
                viewer={viewer}
                tick={tickOf(loadedAt)}
                onOpenTask={(id) =>
                  setOpenTask({ id, ownerId: data?.open.find((t) => t.id === id)?.employee_id ?? data?.me?.employeeId ?? "" })
                }
              />
            </div>
          </header>
        ) : (
        <header className="sticky top-0 z-20 border-b border-edge bg-canvas/95 px-4 py-3 backdrop-blur">
          <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-2">
            <SearchBox
              people={data?.people ?? []}
              tasks={data?.open ?? []}
              blockers={data?.blockers ?? []}
              assignments={data?.assignments ?? []}
              onPick={onSearchPick}
            />
            {/* One right-aligned group. As loose siblings, these wrapped onto a new line at the
                LEFT when the window was narrow or zoomed — which put the bell on the left and
                opened its panel off the screen. `ml-auto` keeps the group, wrapped or not, at the
                right edge. */}
            <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
              {portal === "tasks" ? (
                <input
                  type="date"
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                  aria-label="Day shown"
                  className="rounded-xl border border-edge bg-sunken px-2 py-1.5 text-sm"
                />
              ) : null}
              {!identity ? (
                <select
                  value={viewer}
                  onChange={(e) => setViewer(e.target.value)}
                  title="See the data exactly as this person sees it"
                  className="rounded-xl border border-edge bg-sunken px-2 py-1.5 text-sm"
                >
                  <option value="ceo">CEO (sees everything)</option>
                  {(data?.people ?? []).map((p) => (
                    <option key={p.id} value={p.id}>{p.display_name}</option>
                  ))}
                </select>
              ) : null}
              <ThemeToggle compact />
              <button
                onClick={() => { setPortal("tasks"); setTab("today"); }}
                title={attention ? `${attention} thing${attention === 1 ? "" : "s"} need a human: urgent problems and updates nobody could read` : "Nothing needs a human right now"}
                aria-label="Needs attention"
                className={`relative grid h-9 w-9 place-items-center rounded-xl border ${attention ? "border-crit/50 bg-crit/10 text-crit" : "border-edge bg-sunken text-mut"} hover:border-link`}
              >
                <Icon.alert size={18} />
                {attention ? <span className="absolute -right-1 -top-1 rounded-full bg-crit px-1.5 text-[10px] font-bold text-on-accent">{attention}</span> : null}
              </button>
              <InboxBell
                viewer={viewer}
                tick={tickOf(loadedAt)}
                // The owner comes from the board so the panel knows what this viewer may
                // change; a task that is not on the board falls back to the viewer, and the
                // API refuses anything they may not do anyway.
                onOpenTask={(id) =>
                  setOpenTask({ id, ownerId: data?.open.find((t) => t.id === id)?.employee_id ?? data?.me?.employeeId ?? "" })
                }
              />
              <button
                onClick={() => void load()}
                aria-label="Refresh"
                title="Refresh now"
                className={`grid h-9 w-9 place-items-center rounded-xl border border-edge bg-sunken text-mut hover:border-ok hover:text-ok ${busy ? "animate-pulse" : ""}`}
              >
                <Icon.refresh size={18} />
              </button>
            </div>
          </div>
          <div className="mx-auto max-w-7xl pt-1.5 text-xs">
            {err ? (
              <span className="text-crit">● {err}</span>
            ) : (
              <span className="text-mut">
                <span className={live === "live" ? "text-ok" : "text-warn"} title={live === "live" ? "Updating the moment anything changes" : "Live stream unavailable — refreshing every 20 seconds instead"}>
                  ● {live === "live" ? "live" : "refreshing every 20 s"}
                </span>{" "}
                · {date} · updated {loadedAt ? hhmm(loadedAt.toISOString()) : "…"}
                {health && Object.values(health.load).some((l) => l.waiting > 0) ? (
                  <span className="text-warn"> · busy, requests queuing</span>
                ) : null}
                <span> · showing exactly what this viewer may see</span>
              </span>
            )}
          </div>
        </header>
        )}

        {/* On a phone the bottom padding clears the tab bar and the home indicator. */}
        <main className={`mx-auto max-w-7xl px-4 pt-4 ${wide ? "pb-20" : "pb-[calc(6rem+env(safe-area-inset-bottom))]"}`}>
          {portal === "projects" ? (
            <ProjectsPortal
              viewer={viewer}
              people={data?.people ?? []}
              canStart={canGiveWork}
              projectId={projectId}
              onOpen={setProjectId}
            />
          ) : (
            <>
              {/* The header's date picker, for a phone: the day, a step either way, and a way back to today. */}
              {!wide && (visibleTab === "today" || visibleTab === "eod") ? <DaySwitcher date={date} onDate={setDate} /> : null}
              {/* The install offer (TASK-048) — it renders only while the browser is offering it. */}
              {!wide && visibleTab === "today" ? <div className="mb-3 flex justify-end empty:hidden"><InstallApp compact /></div> : null}
              {visibleTab === "today" ? (
                <Hero
                  greeting={greeting}
                  name={displayName.split(" ")[0]!}
                  dateLabel={dateLabel}
                  done={derived?.done.length ?? 0}
                  pending={derived?.pending.length ?? 0}
                  problems={derived?.openBlockers.length ?? 0}
                  isToday={date === companyToday()}
                  actions={[
                    ...(canGiveWork ? [{ label: "Assign work", icon: "pin" as const, onClick: () => setTab("assign"), primary: true }] : []),
                    ...(ceoTools ? [{ label: "Ask the data", icon: "search" as const, onClick: () => setTab("ask") }] : []),
                    { label: "My work", icon: "user" as const, onClick: () => setTab("mine") },
                  ]}
                />
              ) : null}

              {/* On a phone the counts live on Home only: every page repeating them is what made
                  the app read as a squeezed dashboard. */}
              {wide || visibleTab === "today" ? <Kpis d={derived} review={data?.review.length ?? 0} onJump={setTab} /> : null}

              <div className={wide || visibleTab === "today" ? "mt-5" : ""}>
                {visibleTab !== "today" ? (
                  wide ? (
                    <div className="mb-3 flex items-baseline gap-2">
                      <h2 className="text-lg font-semibold">{active.label}</h2>
                      <span className="text-xs text-mut">{active.blurb}</span>
                    </div>
                  ) : (
                    // The title is in the bar above; here only what the page is for.
                    <p className="mb-3 text-xs text-mut">{active.blurb}</p>
                  )
                ) : null}

                {!data ? (
                  <Spinner label="Loading…" />
                ) : (
                  <>
                    {visibleTab === "today" && (
                      <>
                        <HomeOverview
                          week={data.week}
                          d={derived!}
                          review={data.review}
                          onDay={(day) => setDate(day)}
                          onJump={setTab}
                        />
                        <div className="mb-3 mt-6 flex items-baseline gap-2">
                          <h2 className="text-lg font-semibold">Reported {date === companyToday() ? "today" : `on ${date}`}</h2>
                          <span className="text-xs text-mut">{active.blurb}</span>
                        </div>
                        <TodayTab d={derived!} review={data.review} viewer={viewer} canAck={ceoTools} onChanged={() => void load()} />
                      </>
                    )}
                    {visibleTab === "mine" && (
                      <MyWorkTab tasks={derived!.mine} viewer={viewer} me={data.me} onChanged={() => void load()} onOpen={(t) => setOpenTask({ id: t.id, ownerId: t.employee_id })} />
                    )}
                    {visibleTab === "more" && (
                      <MorePage
                        tabs={TABS.filter((t) => t.id !== "more" && (ceoTools || t.id !== "ask") && !phoneTabs.some((p) => p.id === t.id))}
                        counts={counts}
                        showProjects={thirdTab !== "projects"}
                        onGo={(id) => goPhoneTab(id)}
                        name={displayName}
                        role={roleLabel}
                        onSignOut={identity?.onSignOut}
                        search={
                          <SearchBox
                            people={data.people}
                            tasks={data.open}
                            blockers={data.blockers}
                            assignments={data.assignments}
                            onPick={onSearchPick}
                          />
                        }
                        viewerPicker={
                          !identity ? (
                            <select
                              value={viewer}
                              onChange={(e) => setViewer(e.target.value)}
                              aria-label="See the data as"
                              className="w-full rounded-xl border border-edge bg-sunken px-3 py-2.5 text-sm"
                            >
                              <option value="ceo">CEO (sees everything)</option>
                              {data.people.map((p) => (
                                <option key={p.id} value={p.id}>{p.display_name}</option>
                              ))}
                            </select>
                          ) : null
                        }
                        onRefresh={() => void load()}
                        busy={busy}
                      />
                    )}
                    {visibleTab === "carry" && <CarryTab open={data.open} onOpen={(t) => setOpenTask({ id: t.id, ownerId: t.employee_id })} />}
                    {visibleTab === "assign" && (
                      <AssignTab
                        rows={data.assignments}
                        people={data.people}
                        viewer={viewer}
                        canAssign={canGiveWork}
                        onChanged={() => void load()}
                      />
                    )}
                    {visibleTab === "alerts" && (
                      <AlertsTab viewer={viewer} canAck={canGiveWork} isCeo={!!data.me?.isCeo} onChanged={() => void load()} tick={tickOf(loadedAt)} />
                    )}
                    {visibleTab === "eod" && <EodTab canGenerate={ceoTools} rows={data.eod} onGenerated={() => void load()} busy={busy} />}
                    {visibleTab === "people" && (
                      <PeopleTab rows={data.people} viewer={viewer} canEditOrg={!!data.me?.isCeo} onChanged={() => void load()} />
                    )}
                    {visibleTab === "activity" && <ActivityTab rows={data.activity} />}
                    {visibleTab === "ask" && ceoTools && <AskTab />}
                  </>
                )}
              </div>
            </>
          )}
        </main>
      </div>
      {/* ── Phone tab bar ─────────────────────────────────────────────────── */}
      {!wide ? (
        <nav
          aria-label="Main"
          className="fixed inset-x-0 bottom-0 z-30 border-t border-edge bg-panel/95 pb-[env(safe-area-inset-bottom)] backdrop-blur"
        >
          <div className="mx-auto grid max-w-xl grid-cols-5">
            {phoneTabs.map((p) => {
              const I = Icon[p.icon];
              const on = p.id === "projects" ? portal === "projects" : portal === "tasks" && visibleTab === p.id;
              return (
                <button
                  key={p.id}
                  onClick={() => goPhoneTab(p.id)}
                  aria-current={on ? "page" : undefined}
                  className={`relative flex min-h-16 flex-col items-center justify-center gap-0.5 text-[11px] ${on ? "font-semibold text-ok" : "text-mut"}`}
                >
                  <span className={`grid h-8 w-14 place-items-center rounded-full transition-colors ${on ? "bg-ok/15" : ""}`}>
                    <I size={22} />
                  </span>
                  {p.label}
                  {p.badge ? (
                    <span className={`absolute right-[calc(50%-1.75rem)] top-1.5 min-w-5 rounded-full px-1 text-center text-[10px] font-bold leading-5 ${p.urgent ? "bg-crit text-on-accent" : "bg-sunken text-ink ring-1 ring-edge"}`}>
                      {p.badge}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
        </nav>
      ) : null}
      {openTask && data ? (
        <TaskDetailPanel
          taskId={openTask.id}
          viewer={viewer}
          mine={openTask.ownerId === data.me?.employeeId}
          canManage={canGiveWork || openTask.ownerId === data.me?.employeeId}
          candidates={data.open}
          onClose={closeTask}
          onChanged={() => void load()}
        />
      ) : null}
    </div>
  );
}

/**
 * The home view above the day's board: the week as a chart (counted by Postgres) and the
 * short list of what needs a human — urgent open problems and updates nobody could read.
 */
function HomeOverview({
  week,
  d,
  review,
  onDay,
  onJump,
}: {
  week: WeekDay[];
  d: Derived;
  review: NeedsReview[];
  onDay: (day: string) => void;
  onJump: (t: TabId) => void;
}) {
  const items: { key: string; tone: "crit" | "warn"; icon: IconName; title: string; detail: string; tab: TabId }[] = [
    ...d.urgent.map((b) => ({
      key: `b:${b.id}`,
      tone: (b.severity === "critical" ? "crit" : "warn") as "crit" | "warn",
      icon: "alertCircle" as IconName,
      title: `${b.severity} ${b.category ?? "problem"}${b.affected_asset ? ` — ${b.affected_asset}` : ""}`,
      detail: `raised by ${b.raised_by_name}${b.raised_at ? ` · ${hhmm(b.raised_at)}` : ""}`,
      tab: "alerts" as TabId,
    })),
    ...review.map((r) => ({
      key: `r:${r.id}`,
      tone: "warn" as const,
      icon: "hand" as IconName,
      title: `Could not read: “${(r.note_raw ?? "").slice(0, 60)}${(r.note_raw ?? "").length > 60 ? "…" : ""}”`,
      detail: `${r.employee_name} · needs a human`,
      tab: "today" as TabId,
    })),
  ];
  return (
    <div className="grid gap-4 lg:grid-cols-[3fr_2fr]">
      <section className="rounded-2xl border border-edge bg-panel p-4">
        <div className="mb-2 flex items-center gap-2">
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-med-bg text-med-fg"><Icon.barChart size={16} /></span>
          <div className="leading-tight">
            <h3 className="font-semibold">Last seven days</h3>
            <p className="text-xs text-mut">Reports per day — click a day to open it</p>
          </div>
        </div>
        {week.length ? <WeekChart days={week} onDay={onDay} /> : <p className="text-sm text-mut">No week data.</p>}
      </section>
      {/* First on a phone: what needs a person comes before the week's shape. */}
      <section className="order-first rounded-2xl border border-edge bg-panel p-4 lg:order-none">
        <div className="mb-2 flex items-center gap-2">
          <span className={`grid h-8 w-8 place-items-center rounded-lg ${items.length ? "bg-crit-bg text-crit-fg" : "bg-ok/15 text-ok"}`}>
            {items.length ? <Icon.alert size={16} /> : <Icon.checkCircle size={16} />}
          </span>
          <div className="leading-tight">
            <h3 className="font-semibold">Needs a human</h3>
            <p className="text-xs text-mut">{items.length ? `${items.length} item${items.length === 1 ? "" : "s"} — urgent problems and unread updates` : "Nothing is waiting on a person right now"}</p>
          </div>
        </div>
        {items.length ? (
          <ul className="divide-y divide-edge">
            {items.slice(0, 6).map((it) => {
              const I = Icon[it.icon];
              return (
                <li key={it.key}>
                  <button
                    onClick={() => onJump(it.tab)}
                    className="group flex w-full items-center gap-3 py-2 text-left hover:bg-sunken/60"
                  >
                    <span className={`grid h-7 w-7 shrink-0 place-items-center rounded-lg ${it.tone === "crit" ? "bg-crit-bg text-crit-fg" : "bg-high-bg text-high-fg"}`}><I size={15} /></span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm text-ink">{it.title}</span>
                      <span className="block truncate text-xs text-mut">{it.detail}</span>
                    </span>
                    <span className="text-mut group-hover:text-ink"><Icon.chevronRight size={16} /></span>
                  </button>
                </li>
              );
            })}
            {items.length > 6 ? <li className="pt-2 text-xs text-mut">and {items.length - 6} more — see Alerts</li> : null}
          </ul>
        ) : (
          <p className="text-sm text-mut">Every open problem is either acknowledged or below urgent, and every update was understood.</p>
        )}
      </section>
    </div>
  );
}

/**
 * A percentage with its evidence, never alone: green when counted, amber when self-reported.
 * A picked range is drawn as a range — solid up to its low end, a lighter band to its high
 * end — and labelled "10–20%", so an estimate never looks like a measurement.
 */
function Progress({ t }: { t: OpenTask }) {
  const label = t.progress_source === "counted" ? "counted" : t.progress_source === "status" ? "by status" : "self-reported";
  const band = t.progress_band_low != null && t.progress_band_high != null ? { low: t.progress_band_low, high: t.progress_band_high } : null;
  const fill = t.progress_source === "self_reported" ? "bg-warn" : "bg-ok";
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs" title={`${progressLabel(t)} — ${label}${t.elapsed_pct != null ? ` · ${t.elapsed_pct}% of the time used` : ""}`}>
      <span className="relative inline-block h-1.5 w-14 overflow-hidden rounded bg-sunken align-middle">
        {band ? (
          <>
            <span className={`absolute left-0 top-0 h-full ${fill}`} style={{ width: `${band.low}%` }} />
            <span className={`absolute top-0 h-full ${fill} opacity-40`} style={{ left: `${band.low}%`, width: `${band.high - band.low}%` }} />
          </>
        ) : (
          <span className={`absolute left-0 top-0 h-full ${fill}`} style={{ width: `${t.progress_pct}%` }} />
        )}
      </span>
      <b>{progressLabel(t)}</b>
      {t.behind ? <Pill tone="crit">behind</Pill> : null}
      {t.priority === "urgent" || t.priority === "high" ? <Pill tone={t.priority === "urgent" ? "crit" : "warn"}>{t.priority}</Pill> : null}
    </span>
  );
}

// ── KPI strip ───────────────────────────────────────────────────────────────
interface Derived {
  done: DayUpdate[];
  pending: DayUpdate[];
  blocked: DayUpdate[];
  openBlockers: Blocker[];
  urgent: Blocker[];
  overdue: OpenTask[];
  /** The viewer's own open tasks — what the My work tab shows. */
  mine: OpenTask[];
}

function Kpis({ d, review, onJump }: { d: Derived | null; review: number; onJump: (t: TabId) => void }) {
  if (!d) return null;
  // Decision-critical first: what changes what the CEO does today. Colour is a status,
  // never decoration: red = act now, amber = watch, green = done, blue = information.
  const tiles: { n: number; label: string; hint: string; tone: "crit" | "warn" | "ok" | "info"; icon: IconName; tab: TabId }[] = [
    { n: d.urgent.length, label: "Urgent open", hint: "critical or high problems nobody has resolved", tone: d.urgent.length ? "crit" : "info", icon: "alertCircle", tab: "alerts" },
    { n: d.openBlockers.length, label: "Open problems", hint: "blockers still open, any severity", tone: d.openBlockers.length ? "warn" : "info", icon: "ban", tab: "alerts" },
    { n: d.overdue.length, label: "Carried over", hint: "open tasks from earlier days", tone: d.overdue.length ? "warn" : "info", icon: "clock", tab: "carry" },
    { n: d.pending.length, label: "Pending today", hint: "reported as pending or in progress", tone: "info", icon: "hourglass", tab: "today" },
    { n: d.done.length, label: "Completed today", hint: "reported as done", tone: "ok", icon: "checkCircle", tab: "today" },
    { n: review, label: "Need a human", hint: "updates the system could not read", tone: review ? "crit" : "info", icon: "hand", tab: "today" },
  ];
  const tone = {
    crit: { border: "border-l-crit", badge: "bg-crit-bg text-crit-fg", n: "text-crit" },
    warn: { border: "border-l-warn", badge: "bg-high-bg text-high-fg", n: "text-warn" },
    ok: { border: "border-l-ok", badge: "bg-ok/15 text-ok", n: "text-ok" },
    info: { border: "border-l-link", badge: "bg-med-bg text-med-fg", n: "text-ink" },
  } as const;
  return (
    // Three across on a phone, so all six fit in two short rows above the fold.
    <div className="grid grid-cols-3 gap-2 sm:gap-3 xl:grid-cols-6">
      {tiles.map((t) => {
        const I = Icon[t.icon];
        const c = tone[t.tone];
        return (
          <button
            key={t.label}
            onClick={() => onJump(t.tab)}
            title={t.hint}
            className={`group rounded-2xl border border-edge border-l-4 bg-panel p-2.5 text-left transition-[border-color,transform] hover:-translate-y-0.5 hover:border-link sm:p-3.5 ${c.border}`}
          >
            <div className="flex items-start justify-between gap-2">
              <span className="text-[11px] font-medium leading-tight text-mut sm:text-xs">{t.label}</span>
              <span className={`hidden h-8 w-8 shrink-0 place-items-center rounded-full sm:grid ${c.badge}`}><I size={16} /></span>
            </div>
            <div className={`mt-1 text-2xl font-bold leading-none sm:text-3xl ${c.n}`}>{t.n}</div>
            <div className="mt-2 hidden items-end justify-between gap-2 text-[11px] leading-snug text-mut sm:flex">
              <span>{t.hint}</span>
              <span className="inline-flex shrink-0 items-center gap-0.5 text-link opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">View <Icon.arrowRight size={12} /></span>
            </div>
          </button>
        );
      })}
    </div>
  );
}

// ── Tabs ────────────────────────────────────────────────────────────────────
function person(u: { employee_name: string; department: string | null }) {
  return (
    <span>
      {u.employee_name}
      {u.department ? <span className="ml-1 text-xs text-mut">{u.department}</span> : null}
    </span>
  );
}

function updateCols(withSeverity = false): Column<DayUpdate>[] {
  const base: Column<DayUpdate>[] = [
    { head: "Who", cell: person },
    {
      head: "Task",
      cell: (u) => (
        <span>
          {u.task_title ?? "—"}
          {u.note_raw ? " 💬" : ""}
          {u.files > 0 ? <Pill>📎 {u.files}</Pill> : null}
        </span>
      ),
    },
    { head: "At", cell: (u) => hhmm(u.submitted_at), tight: true },
    { head: "", cell: (u) => <Demo on={u.is_synthetic} />, tight: true },
  ];
  if (!withSeverity) return base;
  return [
    { head: "Severity", cell: (u) => <Severity value={u.severity} />, tight: true },
    ...base.slice(0, 2),
    { head: "Category", cell: (u) => u.category ?? "—", tight: true },
    { head: "State", cell: (u) => <Pill>{u.blocker_status ?? "—"}</Pill>, tight: true },
    { head: "At", cell: (u) => hhmm(u.submitted_at), tight: true },
  ];
}

function detailOf(u: DayUpdate) {
  return u.note_raw ? <Words text={u.note_raw} read={u.summary} /> : null;
}

function TodayTab({
  d,
  review,
  viewer,
  canAck,
  onChanged,
}: {
  d: Derived;
  review: NeedsReview[];
  viewer: string;
  canAck: boolean;
  onChanged: () => void;
}) {
  const act = useAction();

  // "Somebody is on it" — stops the escalation ladder without claiming it is fixed.
  const ackCol: Column<DayUpdate> = {
    head: "",
    tight: true,
    cell: (u) => {
      if (!u.blocker_id) return null;
      if (u.blocker_status === "open" && canAck) {
        return (
          <Button
            tone="primary"
            busy={act.busy}
            onClick={() =>
              void act.run(async () => {
                await api.ackBlocker(viewer, u.blocker_id!);
                onChanged();
                return "Acknowledged — it will no longer escalate.";
              })
            }
          >
            ✅ Acknowledge
          </Button>
        );
      }
      return <Pill tone={u.blocker_status === "acknowledged" ? "ok" : "mut"}>{u.blocker_status ?? "—"}</Pill>;
    },
  };

  return (
    <div className="space-y-6">
      <Toast message={act.message} tone={act.tone} onDone={act.clear} />
      <Section title="✅ Completed" n={d.done.length}>
        <DataTable
          rows={d.done}
          columns={updateCols()}
          rowKey={(r) => r.id}
          detail={detailOf}
          empty="Nobody has completed anything on this date."
        />
      </Section>
      <Section title="⏳ Pending / in progress" n={d.pending.length}>
        <DataTable
          rows={d.pending}
          columns={updateCols()}
          rowKey={(r) => r.id}
          detail={detailOf}
          empty="Nothing pending reported on this date."
        />
      </Section>
      <Section title="🚫 Blockers" n={d.blocked.length}>
        <DataTable
          rows={d.blocked}
          columns={[...updateCols(true), ackCol]}
          rowKey={(r) => r.id}
          detail={detailOf}
          empty="No blockers on this date. 🎉"
        />
      </Section>
      <Section title="❓ Could not be read — needs a human" n={review.length}>
        <DataTable
          rows={review}
          columns={[
            { head: "Who", cell: (r) => r.employee_name },
            { head: "At", cell: (r) => hhmm(r.submitted_at), tight: true },
            { head: "Their message", cell: (r) => (r.note_raw ?? "").slice(0, 90) },
          ]}
          rowKey={(r) => r.id}
          empty="Nothing waiting on a human. 👍"
        />
      </Section>
    </div>
  );
}

function Section({ title, n, children }: { title: string; n: number; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold">
        {title}
        <span className="rounded-full border border-edge bg-sunken px-2 text-xs text-mut">{n}</span>
      </h3>
      {children}
    </div>
  );
}

function CarryTab({ open, onOpen }: { open: OpenTask[]; onOpen: (t: OpenTask) => void }) {
  // Grouped by the day the work was RAISED — "what is still hanging over from Tuesday".
  const groups = useMemo(() => {
    const m = new Map<string, OpenTask[]>();
    for (const t of open) {
      const arr = m.get(t.opened_on) ?? [];
      arr.push(t);
      m.set(t.opened_on, arr);
    }
    return [...m.entries()].sort((a, b) => b[0].localeCompare(a[0]));
  }, [open]);

  if (groups.length === 0) return <Empty>Nothing outstanding. 🎉</Empty>;

  return (
    <div className="space-y-5">
      <p className="text-sm text-mut">
        Everything still open, grouped by the day it was raised. Anything above today is carried over — the age
        column is how long it has been waiting.
      </p>
      {groups.map(([day, rows]) => (
        <div key={day}>
          <div className="mb-1.5 border-b border-edge pb-1 text-sm font-bold text-link">
            {dmon(day)} — {rows.length} open{rows[0]!.age_days > 0 ? ` · ${rows[0]!.age_days} day(s) ago` : " · today"}
          </div>
          <DataTable
            rows={rows}
            columns={[
              { head: "Who", cell: person },
              {
                head: "Task",
                cell: (t) => (
                  <button onClick={() => onOpen(t)} className="text-left hover:text-link hover:underline" title="Open the task">
                    {t.title}{t.last_note ? " 💬" : ""}
                  </button>
                ),
              },
              { head: "Progress", cell: (t) => <Progress t={t} />, tight: true },
              { head: "State", cell: (t) => <Pill>{t.status}</Pill>, tight: true },
              { head: "Age", cell: (t) => <Age days={t.age_days} />, tight: true },
              {
                head: "Last reported",
                cell: (t) => (t.last_reported_at ? `${dmon(t.last_reported_at)} ${hhmm(t.last_reported_at)}` : "never"),
                tight: true,
              },
            ]}
            rowKey={(t) => t.id}
            detail={(t) => (t.last_note ? <Words text={t.last_note} /> : null)}
            empty="none"
          />
        </div>
      ))}
    </div>
  );
}

/**
 * The browser half of the bot's status board. Same three buttons, same rule: a tap is the
 * record, and a blocker asks for the person's own words before anything is sent — exactly
 * as the bot does with its force-reply — because those words are what the CEO reads.
 *
 * Each task is one card: tap the title for everything about it, tap a button to report,
 * open "Update progress" to pick a range. Only one progress form is open at a time, so a
 * phone never shows a wall of forms.
 */
const MINE_FILTERS = ["All", "Behind", "High priority", "Not started"] as const;
type MineFilter = (typeof MINE_FILTERS)[number];

function MyWorkTab({
  tasks,
  viewer,
  me,
  onChanged,
  onOpen,
}: {
  tasks: OpenTask[];
  viewer: string;
  me: Me | null;
  onChanged: () => void;
  onOpen: (t: OpenTask) => void;
}) {
  const act = useAction();
  const [title, setTitle] = useState("");
  const [progressFor, setProgressFor] = useState<string | null>(null); // task id with the progress form open
  const [filter, setFilter] = useState<MineFilter>("All");

  if (!me) return <Empty>Could not work out who you are — refresh, or sign in again.</Empty>;

  const shown = tasks.filter((t) =>
    filter === "Behind" ? t.behind
      : filter === "High priority" ? t.priority === "high" || t.priority === "urgent"
        : filter === "Not started" ? t.status === "open"
          : true,
  );
  const n: Record<MineFilter, number> = {
    All: tasks.length,
    Behind: tasks.filter((t) => t.behind).length,
    "High priority": tasks.filter((t) => t.priority === "high" || t.priority === "urgent").length,
    "Not started": tasks.filter((t) => t.status === "open").length,
  };

  return (
    <div className="space-y-4">
      <Toast message={act.message} tone={act.tone} onDone={act.clear} />

      {tasks.length > 0 ? (
        <Chips
          options={MINE_FILTERS.map((f) => `${f} · ${n[f]}`)}
          selected={`${filter} · ${n[filter]}`}
          onPick={(v) => setFilter((MINE_FILTERS.find((f) => v.startsWith(`${f} ·`)) ?? "All"))}
        />
      ) : null}

      {tasks.length === 0 ? (
        <Empty>Nothing open on your list. 🎉</Empty>
      ) : shown.length === 0 ? (
        <Empty>Nothing matches “{filter}”.</Empty>
      ) : (
        <ul className="space-y-3">
          {shown.map((t) => (
            <li key={t.id}>
              <Card className="space-y-3">
                {/* The whole heading opens the task — steps, history, problems, due date. */}
                <button onClick={() => onOpen(t)} className="group flex w-full items-start gap-2 text-left" title="Steps, progress, problems, related tasks">
                  <span className="min-w-0 flex-1">
                    <span className="block font-semibold text-ink group-hover:text-link">
                      {t.title}
                      <Demo on={t.is_synthetic} />
                    </span>
                    <span className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-mut">
                      <Progress t={t} />
                      <Pill>{t.status.replace("_", " ")}</Pill>
                      <span>open <Age days={t.age_days} /></span>
                      {t.due_at ? <span>due {dmon(t.due_at)}</span> : null}
                    </span>
                  </span>
                  <span className="mt-0.5 flex shrink-0 items-center gap-0.5 text-xs text-link">
                    Open <Icon.chevronRight size={16} />
                  </span>
                </button>
                {t.last_note ? <Words text={t.last_note} /> : null}
                <StatusReport viewer={viewer} task={t} onChanged={onChanged} />
                <button
                  onClick={() => setProgressFor(progressFor === t.id ? null : t.id)}
                  aria-expanded={progressFor === t.id}
                  className="flex w-full items-center justify-between rounded-lg border border-dashed border-edge px-3 py-2.5 text-left text-sm font-semibold text-link hover:border-link"
                >
                  <span>
                    <span className="block">📊 Update progress</span>
                    <span className="block text-xs font-normal text-mut">pick a range: 0–10%, 10–20% …</span>
                  </span>
                  <span aria-hidden="true">{progressFor === t.id ? "▴" : "▾"}</span>
                </button>
                {progressFor === t.id ? (
                  <ProgressReport viewer={viewer} task={t} onSaved={() => { setProgressFor(null); onChanged(); }} />
                ) : null}
              </Card>
            </li>
          ))}
        </ul>
      )}

      <Card>
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (title.trim().length < 3) return;
            void act.run(async () => {
              await api.createTask(viewer, { title: title.trim() });
              setTitle("");
              onChanged();
              return "Task added to your list.";
            });
          }}
        >
          <div className="min-w-0 flex-1 basis-56">
            <TextField label="Something not on the list? Add it" value={title} onChange={setTitle} placeholder="e.g. Clean the chiller in van 2" maxLength={200} />
          </div>
          <Button type="submit" tone="primary" busy={act.busy} disabled={title.trim().length < 3} className="min-h-10">
            ➕ Add
          </Button>
        </form>
      </Card>
    </div>
  );
}

/** The day being looked at, on a phone: a step back, the date, a step forward, and Today. */
function DaySwitcher({ date, onDate }: { date: string; onDate: (d: string) => void }) {
  const today = companyToday();
  const label = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "Asia/Dubai" }).format(
    new Date(`${date}T12:00:00+04:00`),
  );
  const btn = "grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-edge bg-panel text-ink disabled:opacity-40";
  return (
    <div className="mb-3 flex items-center gap-2">
      <button onClick={() => onDate(shiftDay(date, -1))} aria-label="Previous day" className={btn}><Icon.chevronLeft size={18} /></button>
      <label className="relative flex min-h-10 flex-1 items-center justify-center rounded-xl border border-edge bg-panel px-3 text-sm font-semibold">
        {date === today ? `Today · ${label}` : label}
        {/* The native picker, invisible over the label: a tap opens the phone's own calendar. */}
        <input type="date" value={date} max={today} onChange={(e) => e.target.value && onDate(e.target.value)} aria-label="Day shown" className="absolute inset-0 opacity-0" />
      </label>
      <button onClick={() => onDate(shiftDay(date, 1))} disabled={date >= today} aria-label="Next day" className={btn}><Icon.chevronRight size={18} /></button>
      {date !== today ? (
        <button onClick={() => onDate(today)} className="min-h-10 rounded-xl border border-ok bg-ok/10 px-3 text-sm font-semibold text-ok">Today</button>
      ) : null}
    </div>
  );
}

/**
 * The phone's menu: who you are, a search over everything on the board, every page that is
 * not in the tab bar (as big rows with what each is for), and this device's settings. On a
 * wide screen the sidebar and header already are all of this.
 */
function MorePage({
  tabs,
  counts,
  showProjects,
  onGo,
  name,
  role,
  onSignOut,
  search,
  viewerPicker,
  onRefresh,
  busy,
}: {
  tabs: (typeof TABS)[number][];
  counts: Record<TabId, number | null>;
  showProjects: boolean;
  onGo: (id: TabId | "projects") => void;
  name: string;
  role: string;
  onSignOut: (() => void) | undefined;
  search: React.ReactNode;
  viewerPicker: React.ReactNode;
  onRefresh: () => void;
  busy: boolean;
}) {
  const row = (id: TabId | "projects", icon: IconName, label: string, blurb: string, count: number | null) => {
    const I = Icon[icon];
    return (
      <li key={id}>
        <button onClick={() => onGo(id)} className="flex min-h-14 w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-sunken">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-sunken text-ink"><I size={18} /></span>
          <span className="min-w-0 flex-1">
            <span className="block font-semibold">{label}</span>
            <span className="block truncate text-xs text-mut">{blurb}</span>
          </span>
          {count !== null ? <span className="rounded-full bg-sunken px-2 py-0.5 text-[11px] tabular-nums text-mut">{count}</span> : null}
          <span className="text-mut"><Icon.chevronRight size={18} /></span>
        </button>
      </li>
    );
  };
  const groups = ["Today", "Work", "Records", "Tools"]
    .map((g) => ({ g, items: tabs.filter((t) => t.group === g) }))
    .filter((x) => x.items.length > 0 || (x.g === "Work" && showProjects));

  return (
    <div className="space-y-4">
      <Card className="flex items-center gap-3">
        <span className="grid h-12 w-12 shrink-0 place-items-center rounded-full bg-ok/15 text-lg font-bold text-ok">{name.trim().charAt(0).toUpperCase() || "?"}</span>
        <span className="min-w-0 flex-1 leading-tight">
          <span className="block truncate font-semibold">{name}</span>
          <span className="block text-xs text-mut">{role}</span>
        </span>
        {onSignOut ? (
          <button onClick={onSignOut} className="flex items-center gap-1.5 rounded-xl border border-crit/40 bg-crit/10 px-3 py-2 text-sm font-semibold text-crit">
            <Icon.logout size={16} /> Sign out
          </button>
        ) : null}
      </Card>

      <div>
        <h3 className="mb-1.5 px-1 text-[11px] font-bold uppercase tracking-widest text-mut">Find anything</h3>
        {search}
      </div>

      {groups.map(({ g, items }) => (
        <div key={g}>
          <h3 className="mb-1.5 px-1 text-[11px] font-bold uppercase tracking-widest text-mut">{g}</h3>
          <ul className="divide-y divide-edge overflow-hidden rounded-2xl border border-edge bg-panel">
            {items.map((t) => row(t.id, t.icon, t.label, t.blurb, counts[t.id]))}
            {g === "Work" && showProjects ? row("projects", "folder", "Projects", "work with a plan and an end — milestones, risks, progress", null) : null}
          </ul>
        </div>
      ))}

      <div>
        <h3 className="mb-1.5 px-1 text-[11px] font-bold uppercase tracking-widest text-mut">This device</h3>
        <Card className="space-y-3">
          {viewerPicker ? (
            <label className="block text-sm">
              <span className="mb-1 block text-mut">Demo: see the board as</span>
              {viewerPicker}
            </label>
          ) : null}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-sm text-mut">Theme</span>
            <ThemeToggle />
          </div>
          <InstallApp />
          <Button onClick={onRefresh} busy={busy} className="w-full">↻ Refresh now</Button>
          <p className="text-xs text-mut">Everything here shows exactly what this account may see.</p>
        </Card>
      </div>
    </div>
  );
}

/**
 * Giving work out, and letting people in. Both are the browser half of something the bot
 * already does — the assignment goes through the same outbox row the bot would write, so
 * it reaches the phone by the same path; the invite code is the same single-use code the
 * `/invite` command mints.
 */
function AssignTab({
  rows,
  people,
  viewer,
  canAssign,
  onChanged,
}: {
  rows: Assignment[];
  people: Employee[];
  viewer: string;
  canAssign: boolean;
  onChanged: () => void;
}) {
  const act = useAction();
  const invite = useAction();
  const [to, setTo] = useState("");
  const [title, setTitle] = useState("");
  const [note, setNote] = useState("");
  const [name, setName] = useState("");
  const [code, setCode] = useState<{ code: string; expiresAt: string } | null>(null);

  const candidates = people.filter((p) => p.status === "active");

  return (
    <div className="space-y-5">
      {canAssign ? (
        <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
          <Card>
            <h3 className="mb-3 text-sm font-semibold">📌 Assign work</h3>
            <Toast message={act.message} tone={act.tone} onDone={act.clear} />
            <form
              className="mt-2 space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                void act.run(async () => {
                  const r = await api.assign(viewer, {
                    assignedTo: to,
                    title: title.trim(),
                    ...(note.trim() ? { note: note.trim() } : {}),
                  });
                  setTitle("");
                  setNote("");
                  onChanged();
                  const who = candidates.find((p) => p.id === to)?.display_name ?? "them";
                  return r.queued
                    ? `Assigned to ${who}. They are told on every channel they use — Telegram, this app, their devices — within a few seconds.`
                    : `Assigned to ${who}. (Nothing new was queued — this looks like a repeat.)`;
                });
              }}
            >
              <PersonPicker label="Who" value={to} onChange={setTo} people={candidates} />
              <TextField label="What" value={title} onChange={setTitle} placeholder="One task, in plain words" maxLength={200} />
              <TextArea label="Note (optional)" value={note} onChange={setNote} rows={2} maxLength={1000} />
              <Button type="submit" tone="primary" busy={act.busy} disabled={!to || title.trim().length < 3}>
                Assign &amp; notify
              </Button>
            </form>
          </Card>

          <Card>
            <h3 className="mb-3 text-sm font-semibold">➕ Add a person</h3>
            <Toast message={invite.message} tone={invite.tone} onDone={invite.clear} />
            <form
              className="mt-2 space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                void invite.run(async () => {
                  const r = await api.invite(name.trim());
                  setCode(r);
                  setName("");
                  return "Invite code created. It works once and expires in 72 hours.";
                });
              }}
            >
              <TextField label="Their name" value={name} onChange={setName} placeholder="As it should appear on the board" maxLength={120} />
              <Button type="submit" tone="primary" busy={invite.busy} disabled={name.trim().length < 1}>
                Create invite code
              </Button>
            </form>
            {code ? (
              <div className="mt-3 rounded-lg border border-ok/40 bg-ok/10 p-3 text-sm">
                <div className="font-mono text-lg font-bold tracking-widest">{code.code}</div>
                <div className="mt-1 text-xs text-mut">
                  Valid until {dmon(code.expiresAt)} {hhmm(code.expiresAt)}. They open the bot, send /start, tap
                  &ldquo;🔑 I have an invite code&rdquo;, and paste it.
                </div>
                <div className="mt-2">
                  <Button onClick={() => void navigator.clipboard?.writeText(code.code)}>Copy code</Button>
                </div>
              </div>
            ) : null}
          </Card>
        </div>
      ) : null}

      {canAssign ? <DocumentCard people={people} viewer={viewer} onChanged={onChanged} /> : null}

      <DataTable
        rows={rows}
        columns={[
          { head: "When", cell: (a) => `${dmon(a.created_at)} ${hhmm(a.created_at)}`, tight: true },
          { head: "From", cell: (a) => a.assigned_by },
          { head: "To", cell: (a) => <b>{a.assigned_to}</b> },
          { head: "Task", cell: (a) => a.task_title ?? a.note ?? "—" },
          { head: "Files", cell: (a) => (a.files > 0 ? <Pill>📎 {a.files}</Pill> : "—"), tight: true },
          { head: "State", cell: (a) => <Pill>{a.status}</Pill>, tight: true },
        ]}
        rowKey={(a) => a.id}
        detail={(a) => (a.file_names ? <div className="text-xs text-mut">Files: {a.file_names}</div> : null)}
        empty="No assignments yet."
      />
    </div>
  );
}

/**
 * A work document becomes tasks for the right people — the browser half of sending the
 * bot a PDF. The proposal is shown for review with an owner picker per task, because the
 * model only ever proposes: a name it did not recognise comes back as "choose somebody",
 * never as an invented person. The file itself is not forwarded from here (attachments
 * are Telegram file ids, and an upload has none), and the card says so.
 */
function DocumentCard({
  people,
  viewer,
  onChanged,
}: {
  people: Employee[];
  viewer: string;
  onChanged: () => void;
}) {
  const read = useAction();
  const apply = useAction();
  const [file, setFile] = useState<File | null>(null);
  const [instruction, setInstruction] = useState("");
  const [plan, setPlan] = useState<DocumentPlan | null>(null);
  const [owners, setOwners] = useState<string[]>([]);

  const allOwned = plan !== null && owners.length === plan.tasks.length && owners.every((o) => o !== "");

  return (
    <Card>
      <h3 className="mb-3 text-sm font-semibold">📄 From a document</h3>
      <Toast message={read.message} tone={read.tone} onDone={read.clear} />
      {/* Outside the branch: after Create the card resets to the upload form, and the
          confirmation must survive that. */}
      <Toast message={apply.message} tone={apply.tone} onDone={apply.clear} />
      {plan === null ? (
        <form
          className="mt-2 space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!file) return;
            void read.run(async () => {
              const p = await api.planDocument(viewer, file, instruction);
              setPlan(p);
              setOwners(p.tasks.map((t) => t.assigneeId ?? ""));
              const unowned = p.tasks.filter((t) => !t.assigneeId).length;
              return unowned
                ? `Read ${p.fileName}: ${p.tasks.length} task(s), ${unowned} without a recognised owner — choose who does them.`
                : `Read ${p.fileName}: ${p.tasks.length} task(s), every owner recognised. Review and confirm.`;
            });
          }}
        >
          <label className="block text-sm">
            <span className="text-mut">PDF or text file</span>
            <input
              type="file"
              accept=".pdf,.txt,.md,.csv,.json,application/pdf,text/plain"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              className="mt-1 block w-full text-sm text-mut file:mr-3 file:rounded-lg file:border file:border-edge file:bg-sunken file:px-3 file:py-1.5 file:text-sm file:text-ink"
            />
          </label>
          <TextField
            label="What is this for? (optional)"
            value={instruction}
            onChange={setInstruction}
            placeholder="e.g. Assign the work in this document to the right people"
            maxLength={500}
          />
          <Button type="submit" tone="primary" busy={read.busy} disabled={!file}>
            Read the document
          </Button>
          <p className="text-xs text-mut">
            The text is read here and turned into a proposal you confirm. The file itself is not sent to anyone from
            the dashboard — only the tasks are.
          </p>
        </form>
      ) : (
        <div className="mt-2 space-y-3">
          <div className="text-xs text-mut">
            <b className="text-ink">{plan.fileName}</b> · {plan.pages} page(s){plan.truncated ? " · truncated" : ""}
            {plan.safety.verdict === "suspicious" ? (
              <span className="ml-2 text-warn">⚠ {plan.safety.reasons.join(", ")} — read, never forwarded</span>
            ) : null}
            {plan.injection.suspicious ? (
              <span className="ml-2 text-warn">⚠ contained instruction-shaped text ({plan.injection.labels.join(", ")}); it was ignored</span>
            ) : null}
          </div>
          {plan.summary ? <p className="text-sm">{plan.summary}</p> : null}
          <div className="space-y-2">
            {plan.tasks.map((t, i) => (
              <div key={i} className="rounded-lg border border-edge p-3">
                <div className="text-sm font-semibold">{t.title}</div>
                {t.detail ? <div className="mt-0.5 text-xs text-mut">{t.detail}</div> : null}
                <div className="mt-2 max-w-sm">
                  <PersonPicker
                    label={t.assigneeId ? "Owner (recognised in the document)" : t.namedAs ? `Owner — the document said "${t.namedAs}", who is not on the list` : "Owner — the document named nobody"}
                    value={owners[i] ?? ""}
                    onChange={(v) => setOwners((prev) => prev.map((o, j) => (j === i ? v : o)))}
                    people={people.filter((p) => p.status === "active")}
                  />
                </div>
              </div>
            ))}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              tone="primary"
              busy={apply.busy}
              disabled={!allOwned}
              onClick={() =>
                void apply.run(async () => {
                  const r = await api.applyDocument(viewer, {
                    fileName: plan.fileName,
                    tasks: plan.tasks.map((t, i) => ({ assignedTo: owners[i]!, title: t.title, detail: t.detail })),
                  });
                  onChanged();
                  setPlan(null);
                  setFile(null);
                  setInstruction("");
                  const queued = r.assigned.filter((a) => a.queued).length;
                  return `Created ${r.assigned.length} task(s); ${queued} message(s) queued. The file was not forwarded.`;
                })
              }
            >
              ✅ Create {plan.tasks.length} task(s)
            </Button>
            <Button onClick={() => { setPlan(null); apply.clear(); }}>❌ Cancel</Button>
          </div>
        </div>
      )}
    </Card>
  );
}

function EodTab({
  rows,
  onGenerated,
  busy,
  canGenerate,
}: {
  rows: EodReport[];
  onGenerated: () => void;
  busy: boolean;
  canGenerate: boolean;
}) {
  const [msg, setMsg] = useState("");
  return (
    <div className="space-y-3">
      {canGenerate ? (
      <div className="flex items-center gap-2">
        <button
          disabled={busy}
          onClick={async () => {
            setMsg("generating…");
            try {
              const r = await api.generateEod();
              setMsg(`generated ${r.generated} report(s)`);
              onGenerated();
            } catch {
              setMsg("failed — check the API log");
            }
          }}
          className="rounded-lg border border-ok bg-ok/10 px-3 py-2 text-sm font-semibold text-ok disabled:opacity-50"
        >
          Generate end-of-day reports
        </button>
        <span className="text-xs text-mut">{msg}</span>
      </div>
      ) : null}
      {rows.length === 0 ? (
        <Empty>{canGenerate ? "No reports for this date yet — press Generate." : "No report for this date yet — send /eod to the bot to file one."}</Empty>
      ) : (
        rows.map((r) => (
          <Card key={r.id} className="border-l-2 border-l-ok">
            <div className="flex flex-wrap justify-between gap-2">
              <b>
                {r.employee_name}
                <Demo on={r.is_synthetic} />
              </b>
              <span className="text-xs text-mut">
                ✅ {r.completed} · ⏳ {r.pending} · 🚫 {r.blockers}
              </span>
            </div>
            <p className="mt-2 text-sm">{r.summary}</p>
            {/* The line a CEO cannot get anywhere else. */}
            {r.detail?.silent?.length ? (
              <div className="mt-2 text-xs text-warn">
                ⚠️ Open but not mentioned today: {r.detail.silent.map((t) => `${t.title} (${t.age_days}d)`).join(" · ")}
              </div>
            ) : null}
            {r.detail?.carriedOver?.length ? (
              <div className="mt-1 text-xs text-mut">
                Carried over: {r.detail.carriedOver.map((t) => `${t.title} (${t.age_days}d)`).join(" · ")}
              </div>
            ) : null}
            {r.detail?.addendum ? (
              <div className="mt-1 text-xs text-mut">They added: “{r.detail.addendum}”</div>
            ) : null}
          </Card>
        ))
      )}
    </div>
  );
}

/**
 * Everyone this viewer may see. For the CEO it is also where the org chart is set: who
 * may do what (access role) and who reports to whom. Those two answers decide what every
 * other screen shows each person, so they have one author and an audit row per change.
 */
function PeopleTab({
  rows,
  viewer,
  canEditOrg,
  onChanged,
}: {
  rows: Employee[];
  viewer: string;
  canEditOrg: boolean;
  onChanged: () => void;
}) {
  const act = useAction();
  const roleLabel: Record<string, string> = { ceo: "CEO", manager: "Manager", lead: "Dept lead", employee: "Employee" };
  const managers = rows.filter((e) => e.status === "active" && e.access_role !== "employee");
  // Erasure is a two-step, per-row confirmation: first "has left", then a reason and the
  // irreversible button. Nothing happens on the first click.
  const [erasing, setErasing] = useState<{ id: string; reason: EraseReason } | null>(null);
  const eraseLabel: Record<EraseReason, string> = { left: "Left the company", consent_withdrawn: "Withdrew consent", request: "Asked to be removed" };

  async function erase(e: Employee): Promise<void> {
    if (!erasing || erasing.id !== e.id) return;
    const reason = erasing.reason;
    await act.run(async () => {
      const r = await api.erasePerson(viewer, e.id, reason);
      setErasing(null);
      onChanged();
      return `${e.display_name} anonymised — ${r.notesRedacted} note${r.notesRedacted === 1 ? "" : "s"} erased. Their tasks and counts are kept.`;
    });
  }

  async function change(e: Employee, body: { accessRole?: string; managerEmployeeId?: string | null }): Promise<void> {
    await act.run(async () => {
      await api.updatePerson(viewer, e.id, body);
      onChanged();
      return `Updated ${e.display_name}.`;
    });
  }

  const cols: Column<Employee>[] = [
    {
      head: "Name",
      cell: (e) => (
        <>
          {e.display_name}
          <Demo on={e.is_synthetic} />
        </>
      ),
    },
    { head: "Job title", cell: (e) => e.role_title ?? "—" },
    { head: "Dept", cell: (e) => e.department ?? "—" },
    {
      head: "Access",
      cell: (e) =>
        canEditOrg && e.access_role !== "ceo" ? (
          <select
            value={e.access_role}
            disabled={act.busy}
            onChange={(ev) => void change(e, { accessRole: ev.target.value })}
            title="What this person may do: employee (own work), manager (their reports), dept lead (their department)"
            className="rounded-lg border border-edge bg-sunken px-2 py-1 text-sm"
          >
            {(["employee", "manager", "lead"] as const).map((r) => (
              <option key={r} value={r}>{roleLabel[r]}</option>
            ))}
          </select>
        ) : (
          <Pill tone={e.access_role === "employee" ? "mut" : "ok"}>{roleLabel[e.access_role] ?? e.access_role}</Pill>
        ),
      tight: true,
    },
    {
      head: "Reports to",
      cell: (e) =>
        canEditOrg && e.access_role !== "ceo" ? (
          <select
            value={e.manager_employee_id ?? ""}
            disabled={act.busy}
            onChange={(ev) => void change(e, { managerEmployeeId: ev.target.value || null })}
            className="rounded-lg border border-edge bg-sunken px-2 py-1 text-sm"
          >
            <option value="">— nobody —</option>
            {managers
              .filter((m) => m.id !== e.id)
              .map((m) => (
                <option key={m.id} value={m.id}>{m.display_name}</option>
              ))}
          </select>
        ) : (
          e.manager_name ?? "—"
        ),
    },
    { head: "Site", cell: (e) => e.site ?? "—" },
    { head: "State", cell: (e) => <Pill>{e.status}</Pill>, tight: true },
  ];
  if (canEditOrg) {
    cols.push({
      head: "Leaving",
      cell: (e) => {
        if (e.access_role === "ceo" || e.status === "disabled") return "—";
        if (erasing?.id !== e.id) {
          return (
            <Button tone="quiet" disabled={act.busy} title="Anonymise this person: name, Telegram, login and every note. Tasks and counts stay." onClick={() => setErasing({ id: e.id, reason: "left" })}>
              Has left…
            </Button>
          );
        }
        return (
          <span className="flex flex-wrap items-center gap-2">
            <select
              value={erasing.reason}
              disabled={act.busy}
              onChange={(ev) => setErasing({ id: e.id, reason: ev.target.value as EraseReason })}
              className="rounded-lg border border-edge bg-sunken px-2 py-1 text-sm"
            >
              {(Object.keys(eraseLabel) as EraseReason[]).map((r) => (
                <option key={r} value={r}>{eraseLabel[r]}</option>
              ))}
            </select>
            <Button tone="danger" busy={act.busy} onClick={() => void erase(e)}>Erase — cannot be undone</Button>
            <Button tone="quiet" disabled={act.busy} onClick={() => setErasing(null)}>Cancel</Button>
          </span>
        );
      },
    });
  }

  return (
    <div className="space-y-3">
      {canEditOrg ? (
        <p className="text-xs text-mut">
          <b className="text-ink">Access</b> is what a person may do; <b className="text-ink">Reports to</b> is who sees
          their work. A manager sees and assigns to their reports; a department lead also sees everyone in their
          department. Every change is recorded with who made it. <b className="text-ink">Has left</b> anonymises a
          person — their name, Telegram link, login and every note are replaced and cannot be recovered; their tasks,
          counts and history stay so nothing else in the system breaks.
        </p>
      ) : null}
      <Toast message={act.message} tone={act.tone} onDone={act.clear} />
      <DataTable rows={rows} columns={cols} rowKey={(e) => e.id} empty="No people visible to you." />
    </div>
  );
}

function ActivityTab({ rows }: { rows: ActivityRow[] }) {
  return (
    <DataTable
      rows={rows}
      columns={[
        { head: "When", cell: (a) => `${dmon(a.created_at)} ${hhmm(a.created_at)}`, tight: true },
        {
          head: "Action",
          cell: (a) => (
            <span className={a.action.startsWith("security.") ? "text-warn" : undefined}>{a.action}</span>
          ),
        },
        { head: "Actor", cell: (a) => a.actor },
        { head: "Entity", cell: (a) => a.entity ?? "—" },
      ]}
      rowKey={(a) => a.id}
      empty="No activity recorded."
    />
  );
}

function AskTab() {
  const [q, setQ] = useState("");
  const [ans, setAns] = useState<QueryAnswer | null>(null);
  const [state, setState] = useState<"idle" | "busy" | "error">("idle");

  return (
    <Card>
      <div className="flex flex-wrap gap-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            // The same guard the button has. Without it, Enter could start a second query
            // while the first was in flight and the slower answer would overwrite the
            // newer one — a stale answer sitting under a newer question.
            if (e.key === "Enter" && state !== "busy") void ask();
          }}
          placeholder="e.g. what did Hemanth say about his task?"
          className="min-w-56 flex-1 rounded-lg border border-edge bg-sunken px-3 py-2 text-sm"
        />
        <button
          onClick={() => void ask()}
          disabled={q.trim().length < 3 || state === "busy"}
          className="rounded-lg border border-ok bg-ok/10 px-3 py-2 text-sm font-semibold text-ok disabled:opacity-50"
        >
          Ask
        </button>
      </div>

      {state === "idle" && !ans ? (
        <p className="mt-3 text-xs text-mut">
          The model writes SQL, Postgres computes the answer, and a gate checks every number against the returned
          rows. The SQL is always shown.
        </p>
      ) : null}
      {state === "busy" ? <Spinner label="Thinking…" /> : null}
      {state === "error" ? <p className="mt-3 text-sm text-crit">Query failed.</p> : null}
      {ans && state === "idle" ? (
        <div className="mt-3">
          <p className="text-base">{ans.answer}</p>
          <p className="mt-1 text-xs text-mut">
            {ans.rowCount} row(s) · numeric-sanity gate:{" "}
            <span className={ans.gate?.numericSanity ? "text-ok" : "text-crit"}>
              {ans.gate?.numericSanity ? "passed" : "FAILED"}
            </span>
            {" "}· grounding gate:{" "}
            <span className={ans.gate?.grounding !== false ? "text-ok" : "text-crit"}>
              {ans.gate?.grounding !== false ? "passed" : "FAILED"}
            </span>
            {ans.abstained ? " · abstained" : ""}
          </p>
          {ans.sql ? (
            <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-words rounded-lg border border-edge bg-well p-3 text-xs">
              {ans.sql}
            </pre>
          ) : null}
        </div>
      ) : null}
    </Card>
  );

  async function ask() {
    if (q.trim().length < 3) return;
    setState("busy");
    try {
      setAns(await api.ask(q.trim()));
      setState("idle");
    } catch {
      setState("error");
    }
  }
}
