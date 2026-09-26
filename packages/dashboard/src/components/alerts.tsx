import { useCallback, useEffect, useState } from "react";
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
  type Pref,
  type SlaRow,
} from "../lib/api";
import { Card, DataTable, Empty, Pill, Severity, Spinner } from "./ui";
import { disablePush, enablePush, pushState, type PushState } from "../lib/push";
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

  const unread = inbox?.unread ?? 0;
  return (
    <span className="relative">
      <Toast message={act.message} tone={act.tone} onDone={act.clear} />
      <button
        onClick={() => setOpen((o) => !o)}
        aria-label="Notifications"
        title="What you have been told, and why"
        className={`rounded-lg border px-2 py-1.5 text-sm ${unread > 0 ? "border-warn bg-warn/10" : "border-edge bg-sunken"} hover:border-ok`}
      >
        🔔{unread > 0 ? <span className="ml-1 rounded-full bg-warn px-1.5 text-[11px] font-bold text-on-accent">{unread}</span> : null}
      </button>
      {open ? (
        <div className="absolute right-0 z-30 mt-2 w-[min(92vw,420px)] rounded-xl border border-edge bg-panel p-3 shadow-xl">
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
            <ul className="max-h-[60vh] space-y-2 overflow-y-auto">
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
        </div>
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
      <PrefsCard viewer={viewer} />
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
      <h3 className="mb-1 font-semibold">Notifications on this device</h3>
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
        </div>
      ) : null}
      <p className="mt-3 text-[11px] text-mut">
        No app store and nothing to install: add this page to your Home Screen and it behaves like an app. Your words are encrypted
        to this device — Google, Apple and Mozilla pass the message along but cannot read it.
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
function ChannelsCard({ viewer, canEdit }: { viewer: string; canEdit: boolean }) {
  const [rows, setRows] = useState<ChannelState[] | null>(null);
  const act = useAction();

  const load = useCallback(async () => {
    try {
      setRows((await api.channels(viewer)).channels);
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

  return (
    <Card className="p-4">
      <Toast message={act.message} tone={act.tone} onDone={act.clear} />
      <h3 className="mb-1 font-semibold">Channels</h3>
      <p className="mb-3 text-xs text-mut">
        How this company sends messages. {canEdit ? "Only you can change these." : "Only the CEO can change these."} A channel also
        needs to be set up on the server, and each person chooses their own below — all three, or nothing is sent.
      </p>
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

/** How this person wants to be told. Their own rules and nobody else's. */
function PrefsCard({ viewer }: { viewer: string }) {
  const [prefs, setPrefs] = useState<Pref[] | null>(null);
  const [events, setEvents] = useState<AlertEventType[]>([]);
  const [delays, setDelays] = useState<Record<string, string>>({});
  const act = useAction();

  const load = useCallback(async () => {
    try {
      const r = await api.prefs(viewer);
      setPrefs(r.prefs);
      setEvents(r.events);
      const d: Record<string, string> = {};
      for (const p of r.prefs) if (p.channel === "telegram") d[p.eventType] = String(p.delayMinutes ?? 0);
      setDelays(d);
    } catch {
      setPrefs([]);
    }
  }, [viewer]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!prefs) return null;
  const modeOf = (e: AlertEventType) => prefs.find((p) => p.eventType === e && p.channel === "telegram")?.mode ?? "immediate";

  const save = (eventType: AlertEventType, mode: Pref["mode"], delay: number) =>
    act.run(async () => {
      await api.setPref(viewer, { eventType, channel: "telegram", mode, delayMinutes: delay });
      await load();
      return "Saved.";
    });

  return (
    <Card className="p-4">
      <Toast message={act.message} tone={act.tone} onDone={act.clear} />
      <h3 className="mb-1 font-semibold">How you are told</h3>
      <p className="mb-3 text-xs text-mut">
        Your inbox here always gets everything. Telegram is on unless you turn it off, and can be held for a few minutes. Email and web push
        will appear here when they are switched on.
      </p>
      <div className="space-y-2">
        {events.map((e) => {
          const mode = modeOf(e);
          return (
            <div key={e} className="grid items-end gap-2 sm:grid-cols-[1fr_150px_120px_auto]">
              <span className="text-sm">{EVENT_LABEL[e] ?? e}</span>
              <Select
                label="Telegram"
                value={mode}
                onChange={(v) => void save(e, v as Pref["mode"], Number(delays[e] ?? 0))}
                options={[
                  { value: "immediate", label: "Immediately" },
                  { value: "off", label: "Off" },
                  // `digest` is storable and the API accepts it, but no digest is ever
                  // assembled — core treats it as "not now", i.e. silence. Offering it
                  // without saying so would promise a summary that never arrives; hiding
                  // it entirely made an existing digest row render as "Immediately",
                  // which was a lie in the other direction.
                  ...(mode === "digest" ? [{ value: "digest", label: "Digest — not built yet (silent)" }] : []),
                ]}
              />
              <TextField label="Hold (min)" value={delays[e] ?? "0"} onChange={(v) => setDelays((d) => ({ ...d, [e]: v }))} type="number" />
              <Button busy={act.busy} disabled={mode === "off"} onClick={() => void save(e, mode as Pref["mode"], Number(delays[e] ?? 0))}>Save</Button>
            </div>
          );
        })}
      </div>
    </Card>
  );
}
