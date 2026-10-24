import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { Card, Empty, Pill, Spinner } from "../components/ui";
import { ApiError } from "../lib/api";
import { COUNT_KIND_WORDS, amount, inv, type DocCard, type InventoryHome } from "../lib/inventory-api";
import { wh, type OrderCard } from "../lib/warehouse-api";
import { INVENTORY_VIEWS, type InventoryView } from "../portals";
import { DecideSheet, CountSheet, RecountSheet } from "./inv-count";
import { AnswerSheet, GiveSheet, ReceiveSheet, ReverseSheet, SettleSheet, UseSheet, type GiveMode } from "./inv-sheets";
import { errorText, hhmm, linesText, when } from "./inv-ui";
import { ExpectedSection, ReceiveSheet as ReceiveOrderSheet, orderLinesText } from "./wh-sheets";

const MovesView = lazy(() => import("./inv-moves"));
const DayView = lazy(() => import("./inv-day"));
const ItemsView = lazy(() => import("./inv-items"));
const DeliveriesView = lazy(() => import("./wh-docs"));
const ReorderView = lazy(() => import("./wh-reorder"));
const ReportsView = lazy(() => import("./wh-reports"));

/**
 * The Inventory portal (TASK-060): every carton, box and phone — where it is, who holds it, and what
 * moved — from one append-only ledger (migration 0032). Made for the warehouse's phone first: what waits
 * for you at the top, then today's counts, then big buttons for each thing you do, then the stock.
 *
 * Open to everyone whose role holds or sees stock (portals.ts). A driver sees their own stock and the
 * handovers that concern them; the warehouse, the Ops Head, a Supervisor, the CEO and Admins see it all.
 * The server decides what each may see and do; this page only leaves out buttons that would be refused.
 */

const VIEW_LABEL: Record<InventoryView, string> = {
  stock: "Stock",
  deliveries: "Deliveries",
  moves: "Movements",
  day: "Day sheet",
  reorder: "Reorder",
  reports: "Reports",
  items: "Items",
};

type Open =
  | { kind: "receive" }
  | { kind: "receiveOrder"; order: OrderCard }
  | { kind: "give"; mode: GiveMode }
  | { kind: "use"; use: "use" | "damage"; from: "warehouse" | "mine" }
  | { kind: "answer"; doc: DocCard }
  | { kind: "settle"; doc: DocCard }
  | { kind: "reverse"; doc: DocCard }
  | { kind: "count"; countKind?: "opening" | "after_handout" | "closing" | "spot" }
  | { kind: "recount"; id: string }
  | { kind: "decide"; id: string };

export default function InventoryPortal({ viewer, me, view, onView, liveTick }: { viewer: string; me: string; view: InventoryView; onView: (v: InventoryView) => void; liveTick: number }) {
  const [home, setHome] = useState<InventoryHome | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<Open | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  // Deliveries marked expected and returns ready to go (TASK-086) — for whoever sees all stock.
  const [expected, setExpected] = useState<OrderCard[]>([]);

  const load = useCallback(async () => {
    try {
      const h = await inv.home(viewer);
      setHome(h);
      setErr(null);
      if (h.can.read) {
        try {
          setExpected((await wh.orders(viewer, { state: "ready", limit: 50 })).orders);
        } catch {
          // The stock page stands without them.
        }
      }
    } catch (e) {
      setErr(e instanceof ApiError && e.status === 403 ? e.message : errorText(e));
    }
  }, [viewer]);
  // Postgres rings the doorbell when stock moves (0032's live scope): a handover meant for you appears
  // without a refresh. The minute's poll is the fallback.
  useEffect(() => {
    void load();
  }, [load, liveTick]);
  useEffect(() => {
    const t = setInterval(() => void load(), 60_000);
    return () => clearInterval(t);
  }, [load]);

  /** A sheet finished: close the portal's own sheet (a view's sheets close themselves), say what happened, reload. */
  const done = (msg: string, closeSheet = true) => {
    if (closeSheet) setOpen(null);
    setFlash(msg);
    void load();
    setTimeout(() => setFlash(null), 6_000);
  };
  const can = home?.can;
  const views = INVENTORY_VIEWS.filter((v) => v === "stock" || (v === "moves" ? true : can?.read === true));
  const expectedReceipts = expected.filter((o) => o.kind === "receipt" && o.may.validate);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold tracking-tight">Stock</h2>
          <p className="text-sm text-mut">Every carton and box: where it is and who holds it — counted, never copied forward.</p>
        </div>
        {views.length > 1 ? (
          // Seven views do not fit a phone's width: the strip scrolls sideways on its own, the page does not.
          <div className="flex max-w-full overflow-x-auto rounded-xl border border-edge bg-sunken p-0.5" role="tablist" aria-label="Stock views">
            {views.map((v) => (
              <button
                key={v}
                role="tab"
                aria-selected={view === v}
                onClick={() => onView(v)}
                className={`min-h-10 shrink-0 whitespace-nowrap rounded-lg px-3 py-1.5 text-sm ${view === v ? "bg-panel font-semibold text-ink shadow-sm" : "text-mut hover:text-ink"}`}
              >
                {VIEW_LABEL[v]}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      {flash ? (
        <p role="status" className="rounded-xl border border-ok/40 bg-ok/10 p-3 font-semibold text-ok">
          {flash}
        </p>
      ) : null}
      {err && !home ? <Empty>{err}</Empty> : null}
      {!home && !err ? <Spinner label="Opening stock…" /> : null}

      {home && view === "stock" ? (
        <StockHome viewer={viewer} home={home} expected={expected} onOpen={setOpen} onChanged={(msg) => done(msg)} onDeliveries={() => onView("deliveries")} />
      ) : null}
      {home && view !== "stock" ? (
        <Suspense fallback={<Spinner label="Opening…" />}>
          {view === "moves" ? <MovesView viewer={viewer} liveTick={liveTick} onReverse={(doc) => setOpen({ kind: "reverse", doc })} /> : null}
          {view === "day" ? <DayView viewer={viewer} /> : null}
          {view === "items" ? <ItemsView viewer={viewer} can={home.can} /> : null}
          {view === "deliveries" ? <DeliveriesView viewer={viewer} can={home.can} items={home.items} figuresHidden={home.figuresHidden} liveTick={liveTick} onChanged={(msg) => done(msg, false)} /> : null}
          {view === "reorder" ? <ReorderView viewer={viewer} can={home.can} items={home.items} onChanged={(msg) => done(msg, false)} onDeliveries={() => onView("deliveries")} /> : null}
          {view === "reports" ? <ReportsView viewer={viewer} items={home.items} /> : null}
        </Suspense>
      ) : null}

      {home && open?.kind === "receive" ? (
        <ReceiveSheet
          viewer={viewer}
          items={home.items}
          expected={expectedReceipts.map((o) => ({ id: o.id, label: `${o.number} from ${o.supplier.name}: ${orderLinesText(o)}` }))}
          onPickExpected={(id) => {
            const order = expectedReceipts.find((o) => o.id === id);
            if (order) setOpen({ kind: "receiveOrder", order });
          }}
          onDone={done}
          onClose={() => setOpen(null)}
        />
      ) : null}
      {open?.kind === "receiveOrder" ? <ReceiveOrderSheet viewer={viewer} order={open.order} onDone={done} onClose={() => setOpen(null)} /> : null}
      {home && open?.kind === "give" ? <GiveSheet viewer={viewer} me={me} mode={open.mode} items={home.items} mine={home.mine} onDone={done} onClose={() => setOpen(null)} /> : null}
      {home && open?.kind === "use" ? <UseSheet viewer={viewer} kind={open.use} from={open.from} items={home.items} mine={home.mine} onDone={done} onClose={() => setOpen(null)} /> : null}
      {home && open?.kind === "answer" ? <AnswerSheet viewer={viewer} doc={open.doc} onDone={done} onClose={() => setOpen(null)} /> : null}
      {open?.kind === "settle" ? <SettleSheet viewer={viewer} doc={open.doc} onDone={done} onClose={() => setOpen(null)} /> : null}
      {open?.kind === "reverse" ? <ReverseSheet viewer={viewer} doc={open.doc} onDone={done} onClose={() => setOpen(null)} /> : null}
      {open?.kind === "count" ? <CountSheet viewer={viewer} {...(open.countKind ? { kind: open.countKind } : {})} onDone={done} onClose={() => setOpen(null)} /> : null}
      {open?.kind === "recount" ? <RecountSheet viewer={viewer} sessionId={open.id} onDone={done} onClose={() => setOpen(null)} /> : null}
      {open?.kind === "decide" ? <DecideSheet viewer={viewer} sessionId={open.id} onDone={done} onClose={() => setOpen(null)} /> : null}
    </div>
  );
}

function StockHome({
  viewer,
  home,
  expected,
  onOpen,
  onChanged,
  onDeliveries,
}: {
  viewer: string;
  home: InventoryHome;
  expected: OrderCard[];
  onOpen: (o: Open) => void;
  onChanged: (msg: string) => void;
  onDeliveries: () => void;
}) {
  const can = home.can;
  const myCounts = home.counts.filter((c) => c.may.recount || c.may.decide || c.may.waive || c.may.submit);
  return (
    <div className="space-y-4">
      {home.waitingForMe.length > 0 ? (
        <section aria-label="Waiting for you" className="space-y-2">
          <h3 className="text-base font-bold">Waiting for you</h3>
          {home.waitingForMe.map((d) => (
            <WaitingCard key={d.id} viewer={viewer} doc={d} onOpen={onOpen} onChanged={onChanged} />
          ))}
        </section>
      ) : null}

      {home.can.read ? <ExpectedSection orders={expected} canMove={can.move} onReceive={(order) => onOpen({ kind: "receiveOrder", order })} onAll={onDeliveries} /> : null}

      {home.today ? <Today today={home.today} onOpen={onOpen} /> : null}

      <Actions can={can} hasMine={home.mine.length > 0} onOpen={onOpen} />

      {myCounts.length > 0 || home.disputes.some((d) => d.may.settle) ? (
        <section aria-label="Needs you" className="space-y-2">
          <h3 className="text-base font-bold">Needs you</h3>
          {myCounts.map((c) => (
            <Card key={c.id} className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <div className="font-semibold">
                  🔢 {COUNT_KIND_WORDS[c.kind]} by {c.startedBy.name}
                  {c.submittedAt ? ` · ${hhmm(c.submittedAt)}` : ""}
                </div>
                <div className="text-sm text-mut">
                  {c.state === "counting" ? "Still being counted" : c.state === "recount" ? `${c.differing ?? 0} item(s) to count again` : "Waiting for a decision"}
                </div>
              </div>
              {c.may.submit ? (
                <ActionButton onClick={() => onOpen({ kind: "count", countKind: c.kind })}>Carry on counting</ActionButton>
              ) : c.may.recount ? (
                <ActionButton onClick={() => onOpen({ kind: "recount", id: c.id })}>Count again</ActionButton>
              ) : (
                <ActionButton onClick={() => onOpen({ kind: "decide", id: c.id })}>{c.state === "approval" ? "Decide" : "Look"}</ActionButton>
              )}
            </Card>
          ))}
          {home.disputes
            .filter((d) => d.may.settle)
            .map((d) => (
              <Card key={d.id} className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <div className="font-semibold">⚠️ Less arrived: {d.from.name} → {d.to.name}</div>
                  <div className="text-sm text-mut">{linesText(d.lines.filter((l) => (l.pending ?? 0) > 0).map((l) => ({ ...l, qty: l.pending ?? 0 })))} still in transit</div>
                </div>
                <ActionButton onClick={() => onOpen({ kind: "settle", doc: d })}>Settle</ActionButton>
              </Card>
            ))}
        </section>
      ) : null}

      {can.hold && home.mine.length > 0 ? (
        <section aria-label="You hold" className="space-y-2">
          <h3 className="text-base font-bold">You hold</h3>
          <Card>
            <ul className="divide-y divide-edge">
              {home.mine.map((m) => (
                <li key={m.itemId} className="flex items-center justify-between gap-2 py-2">
                  <span className="font-semibold">
                    <span aria-hidden className="mr-1 text-xl">{m.icon ?? "📦"}</span>
                    {m.name}
                  </span>
                  <span className="text-lg font-bold tabular-nums">{amount(m.qty, m.unit)}</span>
                </li>
              ))}
            </ul>
          </Card>
        </section>
      ) : null}

      {home.sentByMe.length > 0 ? (
        <section aria-label="Sent by you" className="space-y-2">
          <h3 className="text-base font-bold">Sent by you — not confirmed yet</h3>
          {home.sentByMe.map((d) => (
            <SentCard key={d.id} viewer={viewer} doc={d} onChanged={onChanged} />
          ))}
        </section>
      ) : null}

      {can.read ? <StockTiles home={home} /> : null}

      {can.read && home.pending.length > 0 ? (
        <section aria-label="Other handovers waiting" className="space-y-2">
          <h3 className="text-base font-bold">Other handovers waiting</h3>
          {home.pending.map((d) => (
            <Card key={d.id}>
              <div className="font-semibold">
                {d.from.name} → {d.to.name}
              </div>
              <div className="text-sm text-mut">
                {linesText(d.lines)} · since {hhmm(d.recordedAt)}
              </div>
            </Card>
          ))}
        </section>
      ) : null}

      {!can.read && home.mine.length === 0 && home.waitingForMe.length === 0 ? <Empty>You hold no company stock right now.</Empty> : null}
      <p className="pb-20 text-xs text-mut sm:pb-0">Every movement is recorded with who did it and when, and is never changed afterwards.</p>
    </div>
  );
}

function ActionButton({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button onClick={onClick} className="min-h-12 rounded-xl border border-ok bg-ok/10 px-4 py-2 font-semibold text-ok hover:bg-ok/20">
      {children}
    </button>
  );
}

function WaitingCard({ viewer, doc, onOpen, onChanged }: { viewer: string; doc: DocCard; onOpen: (o: Open) => void; onChanged: (msg: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const accept = async () => {
    setBusy(true);
    setErr(null);
    try {
      // The other side's one tap: everything arrived as sent.
      await inv.answer(viewer, doc.id, { answer: "accept" });
      onChanged("Accepted — it is recorded as yours now.");
    } catch (e) {
      setErr(errorText(e));
      setBusy(false);
    }
  };
  const title =
    doc.to.kind !== "warehouse"
      ? `📦 From ${doc.createdBy.name}`
      : doc.confirm?.side === "person"
        ? `⬅️ ${doc.createdBy.name} at the warehouse took back from you`
        : doc.from.employeeId && doc.from.employeeId !== doc.createdBy.id
          ? `⬅️ ${doc.createdBy.name} took back ${doc.from.name}'s stock`
          : `↩️ ${doc.from.name} is giving back`;
  return (
    <Card className="space-y-3 border-ok/50">
      <div>
        <div className="text-lg font-bold">{title}</div>
        <div className="mt-1 text-base">{linesText(doc.lines.map((l) => ({ ...l, qty: l.pending ?? l.qty })))}</div>
        <div className="text-sm text-mut">
          Sent {when(doc.recordedAt)}
          {doc.note ? ` · “${doc.note}”` : ""}
        </div>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <button onClick={accept} disabled={busy} className="min-h-14 rounded-2xl border border-ok bg-ok text-lg font-bold text-on-accent disabled:opacity-50">
          {busy ? "…" : "✓ All here"}
        </button>
        <button onClick={() => onOpen({ kind: "answer", doc })} disabled={busy} className="min-h-14 rounded-2xl border border-edge bg-sunken text-lg font-bold">
          Something is different
        </button>
      </div>
      {err ? <p className="text-sm text-crit">{err}</p> : null}
    </Card>
  );
}

function SentCard({ viewer, doc, onChanged }: { viewer: string; doc: DocCard; onChanged: (msg: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const who = doc.confirm?.side === "warehouse" ? "the warehouse confirms" : `${doc.confirm?.person?.name ?? "they"} confirm${doc.confirm?.person ? "s" : ""}`;
  return (
    <Card className="flex flex-wrap items-center justify-between gap-2">
      <div>
        <div className="font-semibold">
          {doc.from.name} → {doc.to.name}
        </div>
        <div className="text-sm text-mut">
          {linesText(doc.lines)} · {who} · since {hhmm(doc.recordedAt)}
        </div>
        {err ? <p className="text-sm text-crit">{err}</p> : null}
      </div>
      {doc.may.cancel ? (
        <button
          onClick={async () => {
            setBusy(true);
            setErr(null);
            try {
              await inv.cancel(viewer, doc.id);
              onChanged("Cancelled — it is back where it was.");
            } catch (e) {
              setErr(errorText(e));
              setBusy(false);
            }
          }}
          disabled={busy}
          className="min-h-12 rounded-xl border border-edge bg-sunken px-3 font-semibold"
        >
          Cancel
        </button>
      ) : null}
    </Card>
  );
}

function Today({ today, onOpen }: { today: NonNullable<InventoryHome["today"]>; onOpen: (o: Open) => void }) {
  const handed = today.handedOutSinceLastCount;
  return (
    <section aria-label="Today's counts" className="space-y-2">
      <h3 className="text-base font-bold">Today's counts</h3>
      <div className="grid gap-2 sm:grid-cols-3">
        <CountStep
          title="🌅 Opening"
          done={today.opening ? `${hhmm(today.opening.at)} · ${today.opening.by}` : null}
          todo="Count before giving anything out"
          onCount={() => onOpen({ kind: "count", countKind: "opening" })}
        />
        <CountStep
          title="🚐 After the team left"
          done={handed.length === 0 && today.lastCount ? `${hhmm(today.lastCount.at)} · ${today.lastCount.by}` : null}
          todo={handed.length > 0 ? `Given out since the last count: ${handed.map((h) => `${amount(h.qty, h.unit)} ${h.name}`).join(", ")}` : "After stock goes out"}
          urgent={handed.length > 0}
          onCount={() => onOpen({ kind: "count", countKind: "after_handout" })}
        />
        <CountStep
          title="🌙 Closing"
          done={today.closing ? `${hhmm(today.closing.at)} · ${today.closing.by}` : null}
          todo="At the end of the day"
          onCount={() => onOpen({ kind: "count", countKind: "closing" })}
        />
      </div>
    </section>
  );
}

function CountStep({ title, done, todo, urgent, onCount }: { title: string; done: string | null; todo: string; urgent?: boolean; onCount: () => void }) {
  return (
    <div className={`rounded-xl border p-3 ${done ? "border-ok/40 bg-ok/5" : urgent ? "border-warn/50 bg-warn/10" : "border-edge bg-panel"}`}>
      <div className="font-semibold">{title}</div>
      {done ? <div className="text-sm text-ok">✓ {done}</div> : <div className="text-sm text-mut">{todo}</div>}
      {!done || urgent ? (
        <button onClick={onCount} className="mt-2 min-h-11 w-full rounded-lg border border-edge bg-sunken text-sm font-semibold hover:border-link">
          Count now
        </button>
      ) : null}
    </div>
  );
}

function Actions({ can, hasMine, onOpen }: { can: InventoryHome["can"]; hasMine: boolean; onOpen: (o: Open) => void }) {
  const tiles: { label: string; icon: string; open: Open; show: boolean }[] = [
    { label: "Delivery in", icon: "📦", open: { kind: "receive" }, show: can.move },
    { label: "Give out", icon: "➡️", open: { kind: "give", mode: "out" }, show: can.move },
    { label: "Take back", icon: "⬅️", open: { kind: "give", mode: "takeback" }, show: can.move },
    { label: "Count", icon: "🔢", open: { kind: "count" }, show: can.move },
    { label: "Used", icon: "🧴", open: { kind: "use", use: "use", from: "warehouse" }, show: can.move },
    { label: "Damaged", icon: "🗑️", open: { kind: "use", use: "damage", from: "warehouse" }, show: can.move },
    { label: "Give back", icon: "↩️", open: { kind: "give", mode: "back" }, show: can.hold && hasMine },
    { label: "Hand to someone", icon: "🤝", open: { kind: "give", mode: "person" }, show: can.hold && hasMine },
    // Whoever holds stock writes off their own — a mover too, beside the warehouse's buttons (review, 20 Oct).
    { label: can.move ? "Used, from what I hold" : "I used some", icon: "🥤", open: { kind: "use", use: "use", from: "mine" }, show: can.hold && hasMine },
    { label: can.move ? "Damaged, from what I hold" : "Some is damaged", icon: "💥", open: { kind: "use", use: "damage", from: "mine" }, show: can.hold && hasMine },
  ];
  const shown = tiles.filter((t) => t.show);
  if (shown.length === 0) return null;
  return (
    <section aria-label="What do you want to do?" className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      {shown.map((t) => (
        <button
          key={t.label}
          onClick={() => onOpen(t.open)}
          className="flex min-h-20 flex-col items-center justify-center gap-1 rounded-2xl border border-edge bg-panel p-2 text-center font-semibold hover:border-link"
        >
          <span aria-hidden className="text-3xl">
            {t.icon}
          </span>
          {t.label}
        </button>
      ))}
    </section>
  );
}

function StockTiles({ home }: { home: InventoryHome }) {
  const low = home.items.filter((i) => i.low);
  // While this person counts the warehouse, its figures stay off the screen until they hand the count in.
  if (home.figuresHidden) {
    return (
      <section aria-label="Stock now" className="rounded-xl border border-edge bg-panel p-3">
        <h3 className="text-base font-bold">In the warehouse now</h3>
        <p className="mt-1 text-sm text-mut">🔢 Hidden while you count — you will see them again once you hand your count in.</p>
      </section>
    );
  }
  return (
    <section aria-label="Stock now" className="space-y-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-base font-bold">In the warehouse now</h3>
        {low.length > 0 ? <Pill tone="crit">🚨 {low.length} low</Pill> : null}
      </div>
      <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
        {home.items.map((i) => (
          <li
            key={i.id}
            className={`rounded-xl border p-3 ${i.low ? "border-crit/60 bg-crit/10" : "border-edge bg-panel"} ${!i.low && i.warehouse === 0 && i.withPeople === 0 && i.inTransit === 0 ? "opacity-60" : ""}`}
          >
            <div className="flex items-center gap-1 text-sm font-semibold">
              <span aria-hidden className="text-xl">{i.low ? "🚨" : (i.icon ?? "📦")}</span>
              <span className="truncate">{i.name}</span>
            </div>
            <div className="mt-1 text-2xl font-extrabold tabular-nums">{i.warehouse === null ? "—" : amount(i.warehouse, i.unit)}</div>
            <div className="text-xs text-mut">
              {i.withPeople > 0 ? `${amount(i.withPeople, i.unit)} with people` : "none with people"}
              {i.inTransit > 0 ? ` · ${amount(i.inTransit, i.unit)} handing over` : ""}
              {i.minLevel !== null ? ` · min ${i.minLevel}` : ""}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
