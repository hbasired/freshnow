import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  api,
  dmon,
  hhmm,
  type AlertEventType,
  type AlertRow,
  type Inbox,
  type LadderLevel,
  type Notification,
  type ChannelState,
  type ConsentState,
  type DeliveryMode,
  type Pref,
  type SlaRow,
} from "../lib/api";
import { Card, DataTable, Empty, Pill, Severity, Spinner } from "./ui";
import { disablePush, enablePush, pushState, type PushState } from "../lib/push";
import { installState, onInstallChange, promptInstall, type InstallState } from "../lib/install";
import { loadAppConfig } from "../lib/auth";
import { Button, Select, TextField, Toast, useAction } from "./form";

/**
 * Who was told, what, and why — as the person sees it.
 *
 * The inbox is the in-app channel: every row is something this person was told, with
 * the rule that chose them. It is the channel that needs no phone, no token and no third
 * party, and it is filled by the same outbox row the Telegram message came from.
 */

const EVENT_LABEL: Record<AlertEventType, string> = {
  "blocker.raised": "A problem is raised that I must resolve",
  "blocker.escalated": "A problem has escalated to me",
  "blocker.resolved": "A problem I raised is resolved",
  "task.assigned": "Work is assigned to me",
  "task.done": "Work I gave out is finished",
};

const TARGET_LABEL: Record<string, string> = {
  resolver: "the person it was routed to",
  manager_of_raiser: "the manager of whoever raised it",
  department_lead: "the department lead",
  ceo: "the CEO",
  employee: "a named person",
};

/** The bell in the header: unread count, and the inbox as a dropdown. */
export function InboxBell({ viewer, tick, onOpenTask }: { viewer: string; tick: number; onOpenTask?: ((taskId: string) => void) | undefined }) {
  const [inbox, setInbox] = useState<Inbox | null>(null);
  const [open, setOpen] = useState(false);
  const act = useAction();

  const load = useCallback(async () => {
    try {
      setInbox(await api.notifications(viewer));
    } catch {
      setInbox(null);
    }
  }, [viewer]);

  useEffect(() => {
    void load();
  }, [load, tick]);

  // Where the panel goes: under the bell, right edges lined up, but never past either edge of
  // the window. It used to be `absolute right-0` on the bell, which is only right while the
  // bell sits at the right of the screen: on a phone, or a zoomed window where the header
  // wraps, the 420 px panel opened leftwards off the screen. It is rendered into <body>
  // because the sticky header's backdrop blur makes the header — not the window — the box a
  // `position: fixed` child is placed in.
  const bell = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);
  const place = useCallback(() => {
    const r = bell.current?.getBoundingClientRect();
    if (!r) return;
    const margin = 8;
    const width = Math.min(420, window.innerWidth - 2 * margin);
    const left = Math.max(margin, Math.min(r.right - width, window.innerWidth - width - margin));
    setPos({ top: r.bottom + margin, left, width });
  }, []);
  useEffect(() => {
    if (!open) return;
    place();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, place]);

  const unread = inbox?.unread ?? 0;
  return (
    <span className="relative">
      <Toast message={act.message} tone={act.tone} onDone={act.clear} />
      <button
        ref={bell}
        onClick={() => setOpen((o) => !o)}
        aria-label="Notifications"
        title="What you have been told, and why"
        className={`rounded-lg border px-2 py-1.5 text-sm ${unread > 0 ? "border-warn bg-warn/10" : "border-edge bg-sunken"} hover:border-ok`}
      >
        🔔{unread > 0 ? <span className="ml-1 rounded-full bg-warn px-1.5 text-[11px] font-bold text-on-accent">{unread}</span> : null}
      </button>
      {open && pos ? createPortal(
        <div
          role="dialog"
          aria-label="Inbox"
          style={{ position: "fixed", top: pos.top, left: pos.left, width: pos.width, maxHeight: `calc(100dvh - ${pos.top + 8}px)` }}
          className="z-50 flex flex-col rounded-xl border border-edge bg-panel p-3 shadow-xl"
        >
          <div className="mb-2 flex items-center gap-2">
            <b className="flex-1 text-sm">Inbox</b>
            {unread > 0 ? (
              <Button
                busy={act.busy}
                onClick={() =>
                  void act.run(async () => {
                    await api.markRead(viewer);
                    await load();
                    return "All read.";
                  })
                }
              >
                Mark all read
              </Button>
            ) : null}
            <button onClick={() => setOpen(false)} aria-label="Close" className="rounded-lg border border-edge px-2 py-1 text-xs hover:border-crit">✕</button>
          </div>
          {!inbox ? (
            <Spinner label="Loading…" />
          ) : inbox.items.length === 0 ? (
            <p className="text-xs text-mut">Nothing yet. You are told here about work given to you, problems routed to you, and anything you watch.</p>
          ) : (
            <ul className="max-h-[60vh] min-h-0 space-y-2 overflow-y-auto">
              {inbox.items.map((n) => (
                <NotificationRow
                  key={n.id}
                  n={n}
                  onRead={() => void act.run(async () => { await api.markRead(viewer, [n.id]); await load(); return ""; })}
                  onOpenTask={onOpenTask}
                />
              ))}
            </ul>
          )}
        </div>,
        document.body,
      ) : null}
    </span>
  );
}

function NotificationRow({ n, onRead, onOpenTask }: { n: Notification; onRead: () => void; onOpenTask?: ((taskId: string) => void) | undefined }) {
  const first = n.text.split("\n")[0] ?? "";
  const rest = n.text.slice(first.length).trim();
  return (
    <li className={`rounded-lg border p-2 text-xs ${n.readAt ? "border-edge opacity-70" : "border-warn/60 bg-warn/5"}`}>
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-mut">
        <span>{dmon(n.at)} {hhmm(n.at)}</span>
        {n.reason ? <Pill tone="mut">why: {n.reason}</Pill> : null}
        {n.level ? <Pill tone="crit">L{n.level}</Pill> : null}
        <span className="flex-1" />
        {n.taskId && onOpenTask ? <button className="text-link hover:underline" onClick={() => onOpenTask(n.taskId!)}>open task</button> : null}
        {!n.readAt ? <button className="text-link hover:underline" onClick={onRead}>mark read</button> : null}
      </div>
      <p className="mt-1 whitespace-pre-wrap text-ink">{first}</p>
      {rest ? <p className="mt-1 whitespace-pre-wrap text-mut">{rest}</p> : null}
    </li>
  );
}

/** The Alerts tab: open problems (counted), the ladder, the SLA table, and this person's rules. */
export function AlertsTab({ viewer, canAck, isCeo = false, onChanged, tick }: { viewer: string; canAck: boolean; isCeo?: boolean; onChanged: () => void; tick: number }) {
  const [alerts, setAlerts] = useState<AlertRow[] | null>(null);
  const [ladder, setLadder] = useState<LadderLevel[]>([]);
  const [sla, setSla] = useState<SlaRow[]>([]);
  const act = useAction();

  const load = useCallback(async () => {
    const [a, l, s] = await Promise.all([
      api.alerts(viewer).catch(() => [] as AlertRow[]),
      api.ladder(viewer).catch(() => [] as LadderLevel[]),
      api.sla(viewer).catch(() => [] as SlaRow[]),
    ]);
    setAlerts(a);
    setLadder(l);
    setSla(s);
  }, [viewer]);

  useEffect(() => {
    void load();
  }, [load, tick]);

  if (!alerts) return <Spinner label="Loading…" />;

  return (
    <div className="space-y-6">
      <Toast message={act.message} tone={act.tone} onDone={act.clear} />

      <section>
        <h3 className="mb-1 font-semibold">Open problems <span className="text-xs font-normal text-mut">one row per problem, however many times it was reported</span></h3>
        <DataTable
          rows={alerts}
          columns={[
            { head: "Severity", cell: (a) => <Severity value={a.severity} />, tight: true },
            { head: "What", cell: (a) => <span>{a.category ?? "—"}{a.asset ? <span className="text-mut"> — {a.asset}</span> : null}</span> },
            { head: "Raised by", cell: (a) => a.about ?? "—" },
            { head: "Reported", cell: (a) => (a.count > 1 ? <Pill tone="warn">{a.count}× · last {hhmm(a.lastSeen)}</Pill> : <span className="text-mut">{dmon(a.firstSeen)} {hhmm(a.firstSeen)}</span>) },
            { head: "Escalation", cell: (a) => (a.escalationLevel ? <Pill tone="crit">level {a.escalationLevel}</Pill> : <span className="text-mut">not yet</span>), tight: true },
            {
              head: "State",
              cell: (a) =>
                a.state === "acknowledged" ? (
                  <Pill tone="ok">on it · {a.ackedBy ?? "?"}{a.ackedAt ? ` ${hhmm(a.ackedAt)}` : ""}</Pill>
                ) : canAck && a.blockerId ? (
                  <Button
                    tone="primary"
                    busy={act.busy}
                    onClick={() =>
                      void act.run(async () => {
                        await api.ackBlocker(viewer, a.blockerId!);
                        await load();
                        onChanged();
                        return "Acknowledged — every report of this problem, and it will no longer escalate.";
                      })
                    }
                  >
                    ✅ Acknowledge
                  </Button>
                ) : (
                  <Pill tone="crit">{a.state}</Pill>
                ),
            },
          ]}
          rowKey={(a) => a.id}
          empty="No open problems. 🎉"
        />
      </section>

      <div className="grid gap-4 md:grid-cols-2">
        <Card className="p-4">
          <h3 className="mb-1 font-semibold">If nobody answers</h3>
          <p className="mb-2 text-xs text-mut">The ladder every unacknowledged problem climbs once its response window runs out. Each rung names roles, not people, so it survives staff changes.</p>
          {ladder.length === 0 ? <Empty>No ladder configured.</Empty> : (
            <ol className="space-y-1.5 text-sm">
              {ladder.map((l) => (
                <li key={l.level} className="flex gap-2">
                  <Pill tone="crit">L{l.level}</Pill>
                  <span>
                    {l.level === 1 ? (l.afterMinutes === 0 ? "as soon as the window runs out" : `${l.afterMinutes} min after the window runs out`) : `${l.afterMinutes} min later`}
                    {" → "}
                    {l.targets.map((t) => TARGET_LABEL[t] ?? t).join(" and ")}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </Card>
        <Card className="p-4">
          <h3 className="mb-1 font-semibold">Response windows</h3>
          <p className="mb-2 text-xs text-mut">How long a problem may wait for an acknowledgement before it escalates. <span className="text-warn">Placeholders until FreshNow confirms its own.</span></p>
          <table className="text-sm">
            <tbody>
              {sla.map((s) => (
                <tr key={s.severity}>
                  <td className="pr-4 py-0.5"><Severity value={s.severity} /></td>
                  <td className="py-0.5">{s.minutes >= 60 ? `${s.minutes / 60} h` : `${s.minutes} min`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      </div>

      <ChannelsCard viewer={viewer} canEdit={isCeo} />
      <DeviceCard viewer={viewer} />
      <PrefsCard viewer={viewer} tick={tick} />
      <ConsentCard viewer={viewer} isCeo={isCeo} />
    </div>
  );
}

/**
 * Notifications on this device. Everything here is the person's own, so there is no
 * permission to check — and the permission prompt is only ever raised by a tap, never on
 * load, because a prompt nobody asked for is the fastest way to be blocked forever.
 *
 * Each way this can be unavailable gets its own sentence. "Notifications unavailable" tells
 * somebody nothing they can act on; "this page is not on HTTPS" and "add it to your Home
 * Screen first" tell them exactly what to do next.
 */
/**
 * Installing FreshNow as an app on this device (lib/install.ts). The full row sits in the
 * device card, above notifications, because installing comes first on a phone — on iPhone
 * notifications do not exist until it is done. `compact` is the header button, shown only on
 * small screens and only when the browser has offered an install that one tap can accept.
 */
export function InstallApp({ compact = false }: { compact?: boolean }) {
  const [st, setSt] = useState<InstallState>(() => installState());
  const act = useAction();
  useEffect(() => onInstallChange(() => setSt(installState())), []);

  const install = () =>
    void act.run(async () => {
      const accepted = await promptInstall();
      setSt(installState());
      return accepted ? "Installed — open FreshNow from your home screen." : "Not installed. You can do it later from here.";
    });

  if (compact) {
    if (st !== "available") return null;
    return (
      <button
        onClick={install}
        title="Install FreshNow on this device"
        className="rounded-xl border border-ok/50 bg-ok/10 px-2.5 py-1.5 text-sm font-semibold text-ok hover:border-ok lg:hidden"
      >
        📲 Install app
      </button>
    );
  }
  const TEXT: Record<InstallState, string> = {
    installed: "FreshNow is installed on this device. Open it from the home screen for the full-screen app.",
    available: "Put FreshNow on this device as an app, with its own icon and window.",
    ios: "On iPhone: open this page in Safari, tap Share ⬆ → Add to Home Screen, then open FreshNow from the Home Screen. Notifications only work from there.",
    menu:
      "This browser has not offered to install the app by itself. Use its menu: ⋮ → Install app (or Add to Home screen). In Brave the ⋮ is at the bottom right. On Android, Chrome is the most dependable browser for this.",
    insecure: "Installing needs a secure (https) address. On a phone, open the tunnel address from pnpm urls.",
  };
  return (
    <div className="mb-3 rounded-lg border border-edge bg-sunken p-2.5">
      <Toast message={act.message} tone={act.tone} onDone={act.clear} />
      <div className="flex flex-wrap items-center gap-2">
        <b className="text-sm">📲 The app</b>
        <span className={`text-xs ${st === "installed" ? "text-ok" : "text-mut"}`}>{st === "installed" ? "● installed" : "○ not installed"}</span>
        {st === "available" ? (
          <Button tone="primary" busy={act.busy} onClick={install}>
            Install FreshNow
          </Button>
        ) : null}
      </div>
      <p className="mt-1 text-xs text-mut">{TEXT[st]}</p>
    </div>
  );
}

function DeviceCard({ viewer }: { viewer: string }) {
  const [state, setState] = useState<PushState | null>(null);
  const [vapid, setVapid] = useState<string | null>(null);
  const act = useAction();

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const cfg = await loadAppConfig().catch(() => null);
      const key = cfg?.vapidPublicKey ?? null;
      const st = await pushState(key).catch((): PushState => ({ kind: "unsupported" }));
      if (!cancelled) {
        setVapid(key);
        setState(st);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!state) return null;

  const MESSAGE: Record<PushState["kind"], string> = {
    on: "This device will buzz when something needs you, even with the app closed.",
    off: "Turn this on to get a notification on this device when something needs you.",
    denied: "Notifications are blocked for this site in your browser settings. Allow them there, then come back.",
    "not-configured": "Web push is not set up on this server yet — the CEO's Channels card above says so too.",
    insecure: "Notifications need a secure (https) address. On the office Wi-Fi address they cannot work — this is a browser rule, not a setting.",
    "ios-needs-install": "On iPhone, tap Share → Add to Home Screen first, then open FreshNow from the Home Screen and come back here.",
    unsupported: "This browser does not support notifications.",
  };
  const canAct = state.kind === "on" || state.kind === "off";

  return (
    <Card className="p-4">
      <Toast message={act.message} tone={act.tone} onDone={act.clear} />
      <h3 className="mb-2 font-semibold">This device</h3>
      <InstallApp />
      <b className="text-sm">🔔 Notifications</b>
      <p className="mb-3 text-xs text-mut">{MESSAGE[state.kind]}</p>
      {canAct ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            tone={state.kind === "on" ? "quiet" : "primary"}
            busy={act.busy}
            onClick={() =>
              void act.run(async () => {
                if (state.kind === "on") {
                  setState(await disablePush(viewer));
                  return "Notifications off on this device.";
                }
                if (!vapid) throw new Error("Web push is not configured on this server.");
                setState(await enablePush(viewer, vapid));
                return "Notifications on. This device will buzz when something needs you.";
              })
            }
          >
            {state.kind === "on" ? "Turn off on this device" : "Turn on for this device"}
          </Button>
          <span className={`text-xs ${state.kind === "on" ? "text-ok" : "text-mut"}`}>
            {state.kind === "on" ? "● on" : "○ off"}
          </span>
          {state.kind === "on" ? (
            <Button
              busy={act.busy}
              title="Queues a real notification through the outbox and the worker — the same path an alert takes"
              onClick={() =>
                void act.run(async () => {
                  await api.pushTest(viewer);
                  return "Test queued. It should arrive within a few seconds — try it with the app closed.";
                })
              }
            >
              🔔 Send a test notification
            </Button>
          ) : null}
        </div>
      ) : null}
      <p className="mt-3 text-[11px] text-mut">
        No app store: installed from this page, it behaves like an app and notifications arrive like any other app's. Your words are
        encrypted to this device — Google, Apple and Mozilla pass the message along but cannot read it.
      </p>
    </Card>
  );
}

const CHANNEL_LABEL: Record<ChannelState["channel"], { name: string; blurb: string }> = {
  telegram: { name: "Telegram", blurb: "The bot. What everyone uses today." },
  inapp: { name: "This dashboard", blurb: "The bell, top right. Always on — the row is the notification." },
  webpush: { name: "Phone & desktop notifications", blurb: "A banner on the device, with the app closed. No app store; the web page becomes the app." },
  email: { name: "Email", blurb: "Reaches people who are not on Telegram at all." },
  chat: { name: "Company chat", blurb: "Posts to a Mattermost or Slack-compatible webhook." },
};

/**
 * The company's switches. A channel needs three things to carry a message — keys on the
 * server, this switch, and the person's own preference below — so a switch that is on can
 * still be dark, and the card says which of the three is missing rather than pretending.
 */
const MODE_LABEL: Record<DeliveryMode, { name: string; blurb: string }> = {
  telegram: { name: "Telegram", blurb: "Today's setup. Alerts go to Telegram and the inbox here." },
  both: { name: "Telegram + App", blurb: "Adds phone and desktop notifications from this app. Nobody loses Telegram." },
  app: { name: "App only", blurb: "The app replaces Telegram: the inbox here plus notifications on each person's devices." },
};

/**
 * The one toggle a CEO needs: where do people hear from us? Three presets over the Telegram
 * and web push switches below. "App only" is refused by the server while web push is not
 * set up, because switching Telegram off would then leave nobody reachable outside this page.
 */
function DeliveryModeSwitch({
  mode,
  pushAvailable,
  canEdit,
  busy,
  onPick,
}: {
  mode: DeliveryMode | "custom";
  pushAvailable: boolean;
  canEdit: boolean;
  busy: boolean;
  onPick: (m: DeliveryMode) => void;
}) {
  return (
    <div className="mb-4 rounded-xl border border-edge bg-sunken p-3">
      <div className="mb-2 flex flex-wrap items-baseline gap-2">
        <b className="text-sm">How people hear from us</b>
        <span className="text-xs text-mut">
          {mode === "custom" ? "Custom — the switches below match none of the three presets." : MODE_LABEL[mode].blurb}
        </span>
      </div>
      <div role="radiogroup" aria-label="Delivery mode" className="grid gap-2 sm:grid-cols-3">
        {(Object.keys(MODE_LABEL) as DeliveryMode[]).map((m) => {
          const on = mode === m;
          const blocked = m === "app" && !pushAvailable;
          return (
            <button
              key={m}
              role="radio"
              aria-checked={on}
              data-mode={m}
              disabled={!canEdit || busy || on || blocked}
              onClick={() => onPick(m)}
              title={blocked ? "Needs web push set up on the server first (VAPID keys)" : canEdit ? `Switch to ${MODE_LABEL[m].name}` : "Only the CEO can change this"}
              className={`rounded-lg border px-3 py-2 text-left text-sm transition-colors disabled:cursor-not-allowed ${
                on ? "border-ok bg-ok/12 font-semibold text-ok" : "border-edge bg-panel hover:border-ok disabled:opacity-60"
              }`}
            >
              {on ? "● " : "○ "}
              {MODE_LABEL[m].name}
              {m === "telegram" ? <span className="ml-1 text-[11px] font-normal text-mut">(default)</span> : null}
              {blocked ? <span className="block text-[11px] font-normal text-warn">needs web push set up</span> : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function ChannelsCard({ viewer, canEdit }: { viewer: string; canEdit: boolean }) {
  const [rows, setRows] = useState<ChannelState[] | null>(null);
  const [mode, setMode] = useState<DeliveryMode | "custom">("telegram");
  const act = useAction();

  const load = useCallback(async () => {
    try {
      const r = await api.channels(viewer);
      setRows(r.channels);
      setMode(r.mode);
    } catch {
      setRows([]);
    }
  }, [viewer]);
  useEffect(() => {
    void load();
  }, [load]);

  if (!rows || rows.length === 0) return null;

  const flip = (c: ChannelState) =>
    act.run(async () => {
      const next = await api.setChannel(viewer, c.channel, !c.enabled);
      await load();
      return next.live
        ? `${CHANNEL_LABEL[c.channel].name} is on.`
        : next.enabled
          ? `${CHANNEL_LABEL[c.channel].name} is switched on but not configured yet — nothing will be sent.`
          : `${CHANNEL_LABEL[c.channel].name} is off.`;
    });

  const pick = (m: DeliveryMode) =>
    act.run(async () => {
      const r = await api.setDeliveryMode(viewer, m);
      await load();
      return r.mode === "app"
        ? "App only. Telegram is off; people are told in the inbox and on the devices they have turned on."
        : r.mode === "both"
          ? "Telegram + App. Everyone keeps Telegram; anyone who turns on notifications also gets them on their device."
          : "Telegram only. Web push is off.";
    });

  const pushAvailable = rows.find((c) => c.channel === "webpush")?.available ?? false;

  return (
    <Card className="p-4">
      <Toast message={act.message} tone={act.tone} onDone={act.clear} />
      <h3 className="mb-1 font-semibold">Channels</h3>
      <p className="mb-3 text-xs text-mut">
        How this company sends messages. {canEdit ? "Only you can change these." : "Only the CEO can change these."} A channel also
        needs to be set up on the server, and each person chooses their own below — all three, or nothing is sent.
      </p>
      <DeliveryModeSwitch mode={mode} pushAvailable={pushAvailable} canEdit={canEdit} busy={act.busy} onPick={(m) => void pick(m)} />
      <div className="space-y-2">
        {rows.map((c) => {
          const label = CHANNEL_LABEL[c.channel];
          const locked = c.channel === "inapp";
          return (
            <div key={c.channel} className="flex flex-wrap items-center gap-3 rounded-xl border border-edge bg-sunken px-3 py-2.5">
              <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${c.live ? "bg-ok" : c.enabled ? "bg-warn" : "bg-mut"}`} aria-hidden="true" />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-semibold">
                  {label.name}{" "}
                  <span className={`ml-1 rounded-full px-2 py-0.5 text-[10px] font-bold ${c.live ? "bg-ok/15 text-ok" : c.enabled ? "bg-high-bg text-high-fg" : "bg-panel text-mut"}`}>
                    {c.live ? "LIVE" : c.enabled ? "NOT SET UP" : "OFF"}
                  </span>
                </span>
                <span className="block text-xs text-mut">{c.why || label.blurb}</span>
              </span>
              {locked ? (
                <span className="text-xs text-mut">always on</span>
              ) : (
                <button
                  onClick={() => void flip(c)}
                  disabled={!canEdit || act.busy}
                  aria-pressed={c.enabled}
                  aria-label={`Switch ${label.name} ${c.enabled ? "off" : "on"}`}
                  data-channel={c.channel}
                  title={canEdit ? `Switch ${label.name} ${c.enabled ? "off" : "on"}` : "Only the CEO can change this"}
                  className={`relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${c.enabled ? "bg-ok" : "bg-edge"}`}
                >
                  <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-canvas transition-[left] ${c.enabled ? "left-[22px]" : "left-0.5"}`} />
                </button>
              )}
            </div>
          );
        })}
      </div>
    </Card>
  );
}

/** Which channels a person can hold a rule for, in the order they are shown. */
type PrefChannel = Pref["channel"];
const PREF_COLUMN: Record<PrefChannel, string> = { telegram: "Telegram", webpush: "This app's notifications", email: "Email" };

/**
 * How this person wants to be told. Their own rules and nobody else's.
 *
 * One column per channel that can actually reach them: Telegram only if they have linked it,
 * web push and email only while the company has them live. Web push defaults to on for a
 * person with a device turned on (see alerts.ts); email defaults to off. A column that could
 * not deliver anything is not offered, rather than offered and silently ignored.
 */
function PrefsCard({ viewer, tick }: { viewer: string; tick: number }) {
  const [prefs, setPrefs] = useState<Pref[] | null>(null);
  const [events, setEvents] = useState<AlertEventType[]>([]);
  const [columns, setColumns] = useState<PrefChannel[]>([]);
  const [delays, setDelays] = useState<Record<string, string>>({});
  const act = useAction();

  const load = useCallback(async () => {
    try {
      const [r, ch, me] = await Promise.all([
        api.prefs(viewer),
        api.channels(viewer).catch(() => ({ channels: [] as ChannelState[] })),
        api.me(viewer).catch(() => null),
      ]);
      setPrefs(r.prefs);
      setEvents(r.events);
      const live = new Set(ch.channels.filter((c) => c.live).map((c) => c.channel));
      const cols: PrefChannel[] = [];
      // A demo viewer has no `telegramLinked` (older API): keep showing Telegram, as before.
      if (live.has("telegram") && me?.telegramLinked !== false) cols.push("telegram");
      if (live.has("webpush")) cols.push("webpush");
      if (live.has("email")) cols.push("email");
      setColumns(cols);
      const d: Record<string, string> = {};
      for (const p of r.prefs) if (p.channel === "telegram") d[p.eventType] = String(p.delayMinutes ?? 0);
      setDelays(d);
    } catch {
      setPrefs([]);
    }
  }, [viewer]);

  useEffect(() => {
    void load();
  }, [load, tick]);

  if (!prefs) return null;
  // Defaults mirror alerts.ts: Telegram and web push on unless a rule says otherwise; email off.
  const modeOf = (e: AlertEventType, c: PrefChannel) =>
    prefs.find((p) => p.eventType === e && p.channel === c)?.mode ?? (c === "email" ? "off" : "immediate");

  const save = (eventType: AlertEventType, channel: PrefChannel, mode: Pref["mode"], delay = 0) =>
    act.run(async () => {
      await api.setPref(viewer, { eventType, channel, mode, delayMinutes: delay });
      await load();
      return "Saved.";
    });

  const optionsFor = (current: string) => [
    { value: "immediate", label: "Immediately" },
    { value: "off", label: "Off" },
    // `digest` is storable and the API accepts it, but no digest is ever assembled — core
    // treats it as "not now", i.e. silence. Offering it without saying so would promise a
    // summary that never arrives; hiding it made an existing digest row render as
    // "Immediately", which was a lie in the other direction.
    ...(current === "digest" ? [{ value: "digest", label: "Digest — not built yet (silent)" }] : []),
  ];

  return (
    <Card className="p-4">
      <Toast message={act.message} tone={act.tone} onDone={act.clear} />
      <h3 className="mb-1 font-semibold">How you are told</h3>
      <p className="mb-3 text-xs text-mut">
        Your inbox here always gets everything. {columns.includes("telegram") ? "Telegram is on unless you turn it off, and can be held for a few minutes. " : ""}
        {columns.includes("webpush") ? "This app's notifications are on for every device you have turned on above. " : ""}
        {columns.length === 0 ? "No other channel is live for you right now — the Channels card says why." : ""}
      </p>
      {columns.length === 0 ? null : (
        <div className="space-y-3">
          {events.map((e) => (
            <div key={e} className="grid items-end gap-2 sm:grid-cols-[1fr_repeat(3,minmax(0,150px))_auto]">
              <span className="text-sm">{EVENT_LABEL[e] ?? e}</span>
              {columns.map((c) => (
                <Select
                  key={c}
                  label={PREF_COLUMN[c]}
                  value={modeOf(e, c)}
                  onChange={(v) => void save(e, c, v as Pref["mode"], c === "telegram" ? Number(delays[e] ?? 0) : 0)}
                  options={optionsFor(modeOf(e, c))}
                />
              ))}
              {columns.includes("telegram") ? (
                <span className="flex items-end gap-2">
                  <TextField label="Telegram hold (min)" value={delays[e] ?? "0"} onChange={(v) => setDelays((d) => ({ ...d, [e]: v }))} type="number" />
                  <Button busy={act.busy} disabled={modeOf(e, "telegram") === "off"} onClick={() => void save(e, "telegram", modeOf(e, "telegram") as Pref["mode"], Number(delays[e] ?? 0))}>Save</Button>
                </span>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

/**
 * The person's own consent record, and the way out. Withdrawing is the app's /withdraw:
 * the account is disabled and nothing more is collected. It asks twice because it signs the
 * person out for good — getting back in is a conversation with the company, not a button.
 */
function ConsentCard({ viewer, isCeo }: { viewer: string; isCeo: boolean }) {
  const [c, setC] = useState<ConsentState | null>(null);
  const [confirming, setConfirming] = useState(false);
  const act = useAction();

  useEffect(() => {
    let cancelled = false;
    void api.consent(viewer).then((r) => { if (!cancelled) setC(r); }).catch(() => {});
    return () => { cancelled = true; };
  }, [viewer]);

  if (!c) return null;
  return (
    <Card className="p-4">
      <Toast message={act.message} tone={act.tone} onDone={act.clear} />
      <h3 className="mb-1 font-semibold">Your consent</h3>
      <p className="mb-2 text-xs text-mut">
        {c.current
          ? `You agreed on ${dmon(c.consentedAt!)} ${hhmm(c.consentedAt!)} (notice ${c.policyVersion}).`
          : c.consented
            ? `You agreed to an earlier notice (${c.policyVersion}); the current one is ${c.currentPolicyVersion}.`
            : "No consent is recorded for you yet."}{" "}
        What this system records about you, and where it goes, is set out in the notice below.
      </p>
      <details className="mb-3 text-xs">
        <summary className="cursor-pointer text-link">Read the notice</summary>
        <p className="mt-2 whitespace-pre-wrap text-ink">{c.notice}</p>
      </details>
      {isCeo ? (
        <p className="text-[11px] text-mut">The CEO account cannot withdraw here — hand the CEO role to someone else first.</p>
      ) : !confirming ? (
        <Button onClick={() => setConfirming(true)}>Withdraw consent…</Button>
      ) : (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-crit/50 bg-crit/5 p-2">
          <span className="text-xs">This turns your account off. Your past updates are kept; nothing new is collected. You will be signed out.</span>
          <Button
            tone="danger"
            busy={act.busy}
            onClick={() =>
              void act.run(async () => {
                await api.withdrawConsent(viewer);
                setTimeout(() => location.reload(), 1500);
                return "Consent withdrawn. Your account is now off.";
              })
            }
          >
            Yes, withdraw
          </Button>
          <Button onClick={() => setConfirming(false)}>Cancel</Button>
        </div>
      )}
    </Card>
  );
}

/**
 * Shown instead of the app to a signed-in person who has not agreed to the notice as it
 * reads today — nobody on record yet, or consent to an older version. The same words the bot
 * shows (core/src/consent.ts). Somebody who never uses Telegram would otherwise be processed
 * without ever having been told what is recorded or where it goes.
 */
export function ConsentGate({ viewer, onAgreed }: { viewer: string; onAgreed: () => void }) {
  const [c, setC] = useState<ConsentState | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const act = useAction();

  useEffect(() => {
    void api.consent(viewer).then(setC).catch((e: unknown) => setErr(e instanceof Error ? e.message : "Could not load the notice"));
  }, [viewer]);

  return (
    <div className="grid min-h-screen place-items-center bg-canvas p-4">
      <Toast message={act.message} tone={act.tone} onDone={act.clear} />
      <Card className="w-full max-w-lg space-y-3 p-5">
        <h2 className="text-lg font-bold">{c?.consented ? "The privacy notice has changed" : "Before you start"}</h2>
        {err ? <p className="text-sm text-crit">{err}</p> : !c ? <Spinner label="Loading…" /> : (
          <>
            {c.consented && (
              <p className="rounded-lg border border-warn/50 bg-warn/5 p-2 text-xs">
                You agreed to an earlier version ({c.policyVersion}). Until you agree to this one, the app can't show your work and
                nothing about you is sent to Telegram, notifications or email.
              </p>
            )}
            <p className="max-h-[60vh] overflow-y-auto whitespace-pre-wrap text-sm text-ink">{c.notice}</p>
            <p className="text-[11px] text-mut">
              Notice {c.currentPolicyVersion} — a draft until the company signs it off · recorded with a fingerprint of exactly these words.
            </p>
            <Button
              tone="primary"
              busy={act.busy}
              onClick={() =>
                void act.run(async () => {
                  await api.giveConsent(viewer, c.noticeHash);
                  onAgreed();
                  return "Thank you — recorded.";
                })
              }
            >
              I have read this and agree
            </Button>
          </>
        )}
      </Card>
    </div>
  );
}
