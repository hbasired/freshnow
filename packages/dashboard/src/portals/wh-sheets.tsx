import { useEffect, useMemo, useState } from "react";
import { TextArea, TextField } from "../components/form";
import { Pill, Spinner } from "../components/ui";
import { amount, newId, type CatalogueItem } from "../lib/inventory-api";
import {
  RETURN_REASONS,
  RETURN_REASON_WORDS,
  RETURN_STATE_WORDS,
  STATE_WORDS,
  dayWords,
  dubaiDay,
  kg,
  wh,
  type OrderCard,
  type OrderKind,
  type OrderLine,
  type OrderLineIn,
  type ReturnReason,
  type Supplier,
} from "../lib/warehouse-api";
import { BigButton, Chips, PhotoButton, Problem, Sheet, Stepper, errorText, when } from "./inv-ui";

/**
 * The warehouse documents' sheets (TASK-086), made for the phone at the door like the rest of Stock: one thing to do per sheet,
 * big targets, amounts with − and +. Every sheet that creates something makes its id when it opens, so a double tap or a retry
 * on a bad connection creates it once (the server's rule). The server decides and checks everything; these sheets ask.
 */

export const stateWords = (o: Pick<OrderCard, "kind" | "state">): string => (o.kind === "receipt" ? STATE_WORDS : RETURN_STATE_WORDS)[o.state];
const kindIcon = (k: OrderKind) => (k === "receipt" ? "📦" : "↩️");

export function StateBadge({ o }: { o: Pick<OrderCard, "kind" | "state" | "overdue" | "short" | "closedShort" | "stockDocState" | "priority"> }) {
  const tone = o.state === "done" ? "ok" : o.state === "cancelled" ? "mut" : o.state === "ready" ? "warn" : "mut";
  return (
    <span className="flex flex-wrap items-center gap-1">
      <Pill tone={tone}>{stateWords(o)}</Pill>
      {o.priority === "urgent" && (o.state === "draft" || o.state === "ready") ? <Pill tone="crit">Urgent</Pill> : null}
      {o.overdue ? <Pill tone="crit">Late</Pill> : null}
      {o.short ? <Pill tone="warn">{o.closedShort ? "Closed short" : "Came short"}</Pill> : null}
      {o.stockDocState === "reversed" ? <Pill tone="crit">Undone</Pill> : null}
    </span>
  );
}

// ── a supplier ───────────────────────────────────────────────────────────────
export function SupplierSheet({ viewer, supplier, onDone, onClose }: { viewer: string; supplier: Supplier | null; onDone: (id: string, msg: string) => void; onClose: () => void }) {
  const [name, setName] = useState(supplier?.name ?? "");
  const [code, setCode] = useState(supplier?.code ?? "");
  const [lead, setLead] = useState(supplier?.leadDays === null || supplier?.leadDays === undefined ? "" : String(supplier.leadDays));
  const [note, setNote] = useState(supplier?.note ?? "");
  const [active, setActive] = useState(supplier?.active ?? true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await wh.saveSupplier(viewer, {
        ...(supplier ? { id: supplier.id } : {}),
        name: name.trim(),
        code: code.trim() ? code.trim().toUpperCase() : null,
        leadDays: lead.trim() === "" ? null : Number(lead),
        note: note.trim() || null,
        active,
      });
      onDone(r.id, supplier ? `${name.trim()} saved.` : `${name.trim()} added.`);
    } catch (e) {
      setErr(errorText(e));
      setBusy(false);
    }
  };
  return (
    <Sheet title={supplier ? "Supplier" : "New supplier"} onClose={onClose} footer={<BigButton onClick={save} busy={busy} disabled={!name.trim()}>Save</BigButton>}>
      <TextField label="Name" value={name} onChange={setName} maxLength={80} placeholder="e.g. Fresh Fruit Co" />
      <div className="grid grid-cols-2 gap-2">
        <TextField label="Short code (optional)" value={code} onChange={setCode} maxLength={12} placeholder="e.g. FFC" hint="2–12 letters, digits or dashes" />
        <TextField label="Days to deliver (optional)" value={lead} onChange={setLead} type="number" placeholder="e.g. 1" />
      </div>
      <TextArea label="Note (optional)" value={note} onChange={setNote} rows={2} maxLength={300} placeholder="What the warehouse should know about them" />
      {supplier ? (
        <label className="flex min-h-12 items-center gap-2 text-sm">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} className="size-5" /> In use — untick when they no longer supply
        </label>
      ) : null}
      <Problem text={err} />
    </Sheet>
  );
}

// ── a new document, or a draft changed ───────────────────────────────────────
interface DraftLine {
  itemId: string;
  qty: number | null;
  kg: string;
  variety: string;
  bestBefore: string;
}

/** What the editor needs of an item — the Stock home's items and the catalogue both carry it. */
export type EditorItem = Pick<CatalogueItem, "id" | "name" | "category" | "unit" | "step" | "icon" | "active">;
const orangesOf = (items: readonly EditorItem[]) => new Set(items.filter((i) => i.category === "oranges").map((i) => i.id));

/**
 * A new delivery to expect, or a return to the supplier on its own; or a draft changed (its items too), or a ready one's day,
 * paper, truck and note. Kilograms, variety and best-before are asked for oranges — anything can carry kilograms.
 */
export function OrderEditor({
  viewer,
  kind,
  order,
  items,
  suppliers,
  available,
  pickSupplier,
  onNewSupplier,
  onDone,
  onClose,
}: {
  viewer: string;
  kind: OrderKind;
  /** Absent: a new one. */
  order?: OrderCard | null;
  items: readonly EditorItem[];
  suppliers: Supplier[];
  /** What the warehouse holds now, per item (a return) — absent while the person counts it. */
  available?: Record<string, number> | null;
  /** A supplier just added over this sheet: chosen for it. */
  pickSupplier?: string | null;
  onNewSupplier: () => void;
  onDone: (id: string, msg: string) => void;
  onClose: () => void;
}) {
  const [id] = useState(order?.id ?? newId());
  const lineEditable = !order || order.state === "draft";
  const [supplierId, setSupplierId] = useState(order?.supplier.id ?? "");
  const [day, setDay] = useState(order?.scheduledOn ?? (order ? "" : dubaiDay(0)));
  const [urgent, setUrgent] = useState(order?.priority === "urgent");
  const [paper, setPaper] = useState(order?.sourceRef ?? "");
  const [plate, setPlate] = useState(order?.vehicle ?? "");
  const [reason, setReason] = useState<ReturnReason | null>(order?.reason ?? null);
  const [note, setNote] = useState(order?.note ?? "");
  const [lines, setLines] = useState<DraftLine[]>(
    order
      ? order.lines.map((l) => ({ itemId: l.itemId, qty: l.expected, kg: l.expectedKg === null ? "" : String(l.expectedKg), variety: l.variety ?? "", bestBefore: l.bestBefore ?? "" }))
      : [],
  );
  const [adding, setAdding] = useState("");
  const [busy, setBusy] = useState<"draft" | "ready" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (pickSupplier && !order) setSupplierId(pickSupplier);
  }, [pickSupplier, order]);
  const oranges = useMemo(() => orangesOf(items), [items]);
  const byId = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);
  const usable = items.filter((i) => i.active && !lines.some((l) => l.itemId === i.id));
  const activeSuppliers = suppliers.filter((s) => s.active || s.id === supplierId);
  const isReturn = kind === "supplier_return";
  const set = (i: number, patch: Partial<DraftLine>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const ready = lines.length > 0 && lines.every((l) => (l.qty ?? 0) > 0) && supplierId !== "" && (!isReturn || reason !== null);
  const save = async (asReady: boolean) => {
    setBusy(asReady ? "ready" : "draft");
    setErr(null);
    const body: OrderLineIn[] = lines.map((l) => ({
      itemId: l.itemId,
      qty: l.qty ?? 0,
      ...(l.kg.trim() ? { kg: l.kg.trim().replace(",", ".") } : {}),
      ...(l.variety.trim() ? { variety: l.variety.trim() } : {}),
      ...(l.bestBefore ? { bestBefore: l.bestBefore } : {}),
    }));
    try {
      const head = {
        scheduledOn: day || null,
        priority: urgent ? ("urgent" as const) : ("normal" as const),
        sourceRef: paper.trim() || null,
        ...(isReturn ? { reason } : { vehicle: plate.trim() || null }),
        note: note.trim() || null,
      };
      if (!order) {
        const r = await wh.create(viewer, { id, kind, supplierId, ...head, lines: body, ready: asReady });
        onDone(r.id, `${r.number} ${asReady ? (isReturn ? "is ready to go back." : "is expected.") : "saved as a draft."}`);
      } else {
        const r = await wh.update(viewer, order.id, { ...head, ...(lineEditable ? { lines: body } : {}) });
        if (asReady && order.state === "draft") await wh.ready(viewer, order.id);
        onDone(r.id, `${r.number} saved.`);
      }
    } catch (e) {
      setErr(errorText(e));
      setBusy(null);
    }
  };
  const title = order ? `${kindIcon(kind)} ${order.number}` : isReturn ? "↩️ Send back to a supplier" : "📦 Expect a delivery";
  return (
    <Sheet
      title={title}
      onClose={onClose}
      footer={
        <div className="grid gap-2 sm:grid-cols-2">
          <BigButton tone="quiet" onClick={() => save(false)} busy={busy === "draft"} disabled={!ready || busy !== null}>
            {order && order.state !== "draft" ? "Save" : "Save as draft"}
          </BigButton>
          {!order || order.state === "draft" ? (
            <BigButton onClick={() => save(true)} busy={busy === "ready"} disabled={!ready || busy !== null}>
              {isReturn ? "Save — ready to go back" : "Save — expected"}
            </BigButton>
          ) : null}
        </div>
      }
    >
      <p className="text-sm text-mut">
        {isReturn
          ? "What goes back, and why. Nothing leaves the warehouse until you press Send back on it."
          : "What the supplier will bring. Nothing is added to stock until you receive it at the door."}
      </p>
      <div className="flex items-end gap-2">
        <label className="flex min-w-0 flex-1 flex-col gap-1 text-sm">
          <span className="font-semibold">Supplier</span>
          <select
            value={supplierId}
            onChange={(e) => setSupplierId(e.target.value)}
            disabled={!!order}
            className="h-12 rounded-xl border border-edge bg-sunken px-2"
            aria-label="Supplier"
          >
            <option value="">Choose…</option>
            {activeSuppliers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        {!order ? (
          <button onClick={onNewSupplier} className="min-h-12 rounded-xl border border-edge px-3 text-sm font-semibold hover:border-link">
            + New
          </button>
        ) : null}
      </div>
      {isReturn ? (
        <div>
          <p className="mb-1 text-sm font-semibold">Why does it go back?</p>
          <Chips options={RETURN_REASONS.map((r) => ({ value: r, label: RETURN_REASON_WORDS[r] }))} value={reason} onPick={setReason} />
        </div>
      ) : null}
      <div className="grid grid-cols-2 gap-2">
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-semibold">{isReturn ? "Planned for" : "Expected on"}</span>
          <input type="date" value={day} onChange={(e) => setDay(e.target.value)} className="h-12 rounded-xl border border-edge bg-sunken px-2" />
        </label>
        <label className="flex min-h-12 items-center gap-2 self-end text-sm">
          <input type="checkbox" checked={urgent} onChange={(e) => setUrgent(e.target.checked)} className="size-5" /> Urgent
        </label>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <TextField label={isReturn ? "Their paper no. (optional)" : "Delivery note no. (optional)"} value={paper} onChange={setPaper} maxLength={40} />
        {!isReturn ? <TextField label="Truck plate (optional)" value={plate} onChange={setPlate} maxLength={20} placeholder="e.g. HN 897" /> : <span />}
      </div>

      <div>
        <p className="mb-1 text-sm font-semibold">Items</p>
        {!lineEditable ? <p className="mb-2 text-xs text-mut">To change the items, put it back to draft first.</p> : null}
        <ul className="space-y-2">
          {lines.map((l, i) => {
            const it = byId.get(l.itemId);
            if (!it) return null;
            const isOrange = oranges.has(l.itemId);
            return (
              <li key={l.itemId} className="space-y-2 rounded-xl border border-edge bg-panel p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="min-w-0 truncate font-semibold">
                    <span aria-hidden className="mr-1 text-xl">{it.icon ?? "📦"}</span>
                    {it.name}
                  </span>
                  {lineEditable ? (
                    <button onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))} aria-label={`Remove ${it.name}`} className="min-h-10 rounded-lg px-2 text-sm text-mut hover:text-crit">
                      Remove
                    </button>
                  ) : null}
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  {lineEditable ? (
                    <Stepper label={`${it.name}, in ${it.unit}s`} value={l.qty} onChange={(v) => set(i, { qty: v })} step={it.step} {...(isReturn && available?.[it.id] !== undefined ? { max: available[it.id] } : {})} />
                  ) : (
                    <span className="text-lg font-bold">{amount(l.qty ?? 0, it.unit)}</span>
                  )}
                  <span className="text-sm text-mut">
                    {it.unit}
                    {isReturn && available && available[it.id] !== undefined ? ` · ${amount(available[it.id]!, it.unit)} in the warehouse` : ""}
                  </span>
                </div>
                {lineEditable ? (
                  <div className="grid grid-cols-2 gap-2">
                    <TextField label={isReturn ? "Weight going back, kg (optional)" : "Weight on the note, kg (optional)"} value={l.kg} onChange={(v) => set(i, { kg: v })} type="number" placeholder="e.g. 360" />
                    {isOrange && !isReturn ? <TextField label="Variety (optional)" value={l.variety} onChange={(v) => set(i, { variety: v })} maxLength={40} placeholder="e.g. Valencia" /> : <span />}
                    {isOrange && !isReturn ? (
                      <label className="flex flex-col gap-1 text-sm">
                        <span className="font-semibold">Best before (optional)</span>
                        <input type="date" value={l.bestBefore} onChange={(e) => set(i, { bestBefore: e.target.value })} className="h-12 rounded-xl border border-edge bg-sunken px-2" />
                      </label>
                    ) : null}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
        {lineEditable ? (
          <div className="mt-2 flex gap-2">
            <select value={adding} onChange={(e) => setAdding(e.target.value)} aria-label="Add an item" className="h-12 min-w-0 flex-1 rounded-xl border border-edge bg-sunken px-2">
              <option value="">Add an item…</option>
              {usable.map((it) => (
                <option key={it.id} value={it.id}>
                  {it.name} ({it.unit})
                </option>
              ))}
            </select>
            <button
              onClick={() => {
                if (!adding) return;
                setLines((ls) => [...ls, { itemId: adding, qty: null, kg: "", variety: "", bestBefore: "" }]);
                setAdding("");
              }}
              disabled={!adding}
              className="min-h-12 rounded-xl border border-ok bg-ok/10 px-4 font-semibold text-ok disabled:opacity-40"
            >
              Add
            </button>
          </div>
        ) : null}
      </div>
      <TextArea label="Note (optional)" value={note} onChange={setNote} rows={2} maxLength={500} />
      <Problem text={err} />
    </Sheet>
  );
}

// ── one document ─────────────────────────────────────────────────────────────
/**
 * A document as one page: who, when, what was expected against what came, its lots — and the next step as the big button:
 * receive (or send back) when it is open, return some when it is a received delivery.
 */
export function OrderSheet({
  viewer,
  id,
  onEdit,
  onReceive,
  onReturn,
  onOpen,
  onChanged,
  onClose,
}: {
  viewer: string;
  id: string;
  onEdit: (o: OrderCard) => void;
  onReceive: (o: OrderCard) => void;
  onReturn: (o: OrderCard) => void;
  onOpen: (id: string) => void;
  onChanged: (msg: string) => void;
  onClose: () => void;
}) {
  const [o, setO] = useState<OrderCard | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [cancelNote, setCancelNote] = useState("");
  useEffect(() => {
    let live = true;
    setO(null);
    wh.order(viewer, id).then(
      (x) => live && setO(x),
      (e) => live && setErr(errorText(e)),
    );
    return () => {
      live = false;
    };
  }, [viewer, id]);
  const act = async (what: string, run: () => Promise<unknown>, msg: string) => {
    setBusy(what);
    setErr(null);
    try {
      await run();
      onChanged(msg);
    } catch (e) {
      setErr(errorText(e));
      setBusy(null);
    }
  };
  if (!o) {
    return (
      <Sheet title="Document" onClose={onClose}>
        {err ? <Problem text={err} /> : <Spinner label="Opening…" />}
      </Sheet>
    );
  }
  const isReturn = o.kind === "supplier_return";
  const footer =
    o.may.validate || o.may.return ? (
      <div className="space-y-2">
        {o.may.validate ? (
          <BigButton onClick={() => onReceive(o)}>{isReturn ? "↩️ Send back now" : "📦 Receive at the door"}</BigButton>
        ) : null}
        {o.may.return ? (
          <BigButton tone="quiet" onClick={() => onReturn(o)}>
            ↩️ Return some to {o.supplier.name}
          </BigButton>
        ) : null}
      </div>
    ) : undefined;
  return (
    <Sheet title={`${kindIcon(o.kind)} ${o.number}`} onClose={onClose} footer={footer}>
      <div className="space-y-1">
        <StateBadge o={o} />
        <p className="text-lg font-bold">
          {isReturn ? "Back to " : "From "}
          {o.supplier.name}
        </p>
        <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
          {o.scheduledOn ? <Row label={isReturn ? "Planned for" : "Expected on"} value={dayWords(o.scheduledOn)} /> : null}
          {o.sourceRef ? <Row label={isReturn ? "Their paper" : "Delivery note"} value={o.sourceRef} /> : null}
          {o.vehicle ? <Row label="Truck" value={o.vehicle} /> : null}
          {o.reason ? <Row label="Why" value={RETURN_REASON_WORDS[o.reason]} /> : null}
          <Row label="Made by" value={`${o.createdBy.name} · ${when(o.createdAt)}`} />
          {o.doneAt ? <Row label={isReturn ? "Sent back by" : "Received by"} value={`${o.doneBy?.name ?? "—"} · ${when(o.doneAt)}`} /> : null}
          {o.cancelledAt ? <Row label="Cancelled" value={`${when(o.cancelledAt)}${o.cancelNote ? ` — “${o.cancelNote}”` : ""}`} /> : null}
        </dl>
        {o.note ? <p className="text-sm">“{o.note}”</p> : null}
      </div>

      {/* Each line as a few short sentences: a table this narrow broke its figures over several lines on a phone. */}
      <ul className="divide-y divide-edge rounded-xl border border-edge bg-panel">
        {o.lines.map((l) => (
          <LineCard key={l.itemId} l={l} isReturn={isReturn} />
        ))}
      </ul>

      {o.backorderOf || o.returnOf || o.backorders.length > 0 || o.returns.length > 0 ? (
        <div className="space-y-1 text-sm">
          {o.backorderOf ? <Link label={`The rest of ${o.backorderOf.number}`} onClick={() => onOpen(o.backorderOf!.id)} /> : null}
          {o.returnOf ? <Link label={`Goes back from ${o.returnOf.number}`} onClick={() => onOpen(o.returnOf!.id)} /> : null}
          {o.backorders.map((b) => (
            <Link key={b.id} label={`Still to come: ${b.number} (${STATE_WORDS[b.state].toLowerCase()})`} onClick={() => onOpen(b.id)} />
          ))}
          {o.returns.map((r) => (
            <Link key={r.id} label={`Returned: ${r.number} (${RETURN_STATE_WORDS[r.state].toLowerCase()})`} onClick={() => onOpen(r.id)} />
          ))}
        </div>
      ) : null}
      {o.stockDocState === "reversed" ? <p className="rounded-xl border border-crit/40 bg-crit/10 p-3 text-sm">Its stock was undone by an approver (a reversal in Movements).</p> : null}

      {o.may.edit || o.may.ready || o.may.draft || o.may.cancel ? (
        <div className="flex flex-wrap gap-2">
          {o.may.edit ? <SmallButton onClick={() => onEdit(o)}>Edit</SmallButton> : null}
          {o.may.ready ? (
            <SmallButton busy={busy === "ready"} onClick={() => act("ready", () => wh.ready(viewer, o.id), `${o.number} ${isReturn ? "is ready to go back." : "is expected."}`)}>
              {isReturn ? "Mark ready to go back" : "Mark as expected"}
            </SmallButton>
          ) : null}
          {o.may.draft ? (
            <SmallButton busy={busy === "draft"} onClick={() => act("draft", () => wh.draft(viewer, o.id), `${o.number} is a draft again.`)}>
              Back to draft
            </SmallButton>
          ) : null}
          {o.may.cancel ? <SmallButton tone="stop" onClick={() => setCancelling(true)}>Cancel it</SmallButton> : null}
        </div>
      ) : null}
      {cancelling ? (
        <div className="space-y-2 rounded-xl border border-crit/40 p-3">
          <TextField label="Why is it cancelled? (optional)" value={cancelNote} onChange={setCancelNote} maxLength={300} placeholder={isReturn ? "e.g. the supplier took it back at the door" : "e.g. the supplier will not come"} />
          <BigButton tone="stop" busy={busy === "cancel"} onClick={() => act("cancel", () => wh.cancel(viewer, o.id, cancelNote.trim() || undefined), `${o.number} cancelled.`)}>
            Cancel {o.number}
          </BigButton>
        </div>
      ) : null}
      <Problem text={err} />
    </Sheet>
  );
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;

/** One line of a document: what was expected against what came, its weight against the note's for what came, its lot. */
function LineCard({ l, isReturn }: { l: OrderLine; isReturn: boolean }) {
  const short = l.done !== null && l.done < l.expected;
  const more = l.done !== null && l.done > l.expected;
  const partial = l.done !== null && l.done !== l.expected && l.done > 0;
  const under = l.doneKg !== null && l.expectedKgForDone !== null && l.doneKg < l.expectedKgForDone ? r3(l.expectedKgForDone - l.doneKg) : null;
  return (
    <li className="space-y-1 p-3 text-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-x-2">
        <span className="text-base font-semibold">
          <span aria-hidden className="mr-1">{l.icon ?? "📦"}</span>
          {l.name}
          {l.variety ? <span className="font-normal text-mut"> · {l.variety}</span> : null}
        </span>
        {l.lot ? <span className="whitespace-nowrap text-xs text-mut">Lot {l.lot}</span> : null}
      </div>
      <p>
        {isReturn ? "To go back" : "Expected"} <b className="whitespace-nowrap tabular-nums">{amount(l.expected, l.unit)}</b>
        {l.done !== null ? (
          <>
            {" · "}
            {isReturn ? "went back" : "came"} <b className={`whitespace-nowrap tabular-nums ${short ? "text-crit" : ""}`}>{amount(l.done, l.unit)}</b>
            {short ? <span className="text-crit"> ({amount(r3(l.expected - l.done), l.unit)} short)</span> : null}
            {more ? <span className="text-warn"> ({amount(r3(l.done - l.expected), l.unit)} more)</span> : null}
          </>
        ) : null}
      </p>
      {isReturn ? (
        l.doneKg !== null || l.expectedKg !== null ? <p className="text-mut">Weight going back: {kg(l.doneKg ?? l.expectedKg)}</p> : null
      ) : l.doneKg !== null ? (
        <p>
          Weighed <b className="whitespace-nowrap tabular-nums">{kg(l.doneKg)}</b>
          {l.expectedKgForDone !== null ? (
            <span className="text-mut">
              {" — "}the note: {kg(l.expectedKgForDone)}
              {partial && l.done !== null ? ` for ${amount(l.done, l.unit)} (${kg(l.expectedKg)} for ${amount(l.expected, l.unit)})` : ""}
            </span>
          ) : null}
          {under !== null ? <span className="text-warn"> · {kg(under)} under</span> : null}
        </p>
      ) : l.expectedKg !== null ? (
        <p className="text-mut">The note: {kg(l.expectedKg)}</p>
      ) : null}
      {l.bestBefore ? <p className="text-xs text-mut">Best before {dayWords(l.bestBefore)}</p> : null}
      {l.available !== null ? <p className="text-xs text-mut">{amount(l.available, l.unit)} in the warehouse now</p> : null}
    </li>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] uppercase tracking-wide text-mut">{label}</dt>
      <dd className="truncate font-semibold">{value}</dd>
    </div>
  );
}
function Link({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button onClick={onClick} className="block min-h-9 text-left font-semibold text-link hover:underline">
      {label} →
    </button>
  );
}
function SmallButton({ children, onClick, busy, tone = "quiet" }: { children: React.ReactNode; onClick: () => void; busy?: boolean; tone?: "quiet" | "stop" }) {
  return (
    <button
      onClick={onClick}
      disabled={busy}
      className={`min-h-11 rounded-xl border px-3 text-sm font-semibold disabled:opacity-50 ${tone === "stop" ? "border-crit/60 text-crit hover:bg-crit/10" : "border-edge hover:border-link"}`}
    >
      {busy ? "…" : children}
    </button>
  );
}

// ── receiving at the door (or sending back) ──────────────────────────────────
/**
 * What came, line by line — each starts at what was expected, so "everything came" is one tap — and the scale's kilograms.
 * Less than expected asks what about the rest: it comes later (a backorder) or not at all (closed short).
 */
export function ReceiveSheet({ viewer, order, onDone, onClose }: { viewer: string; order: OrderCard; onDone: (msg: string) => void; onClose: () => void }) {
  const [stockDocId] = useState(newId);
  const [backorderId] = useState(newId);
  const isReturn = order.kind === "supplier_return";
  const [qty, setQty] = useState<Record<string, number>>(() => Object.fromEntries(order.lines.map((l) => [l.itemId, l.expected])));
  const [kgs, setKgs] = useState<Record<string, string>>(() => Object.fromEntries(order.lines.map((l) => [l.itemId, isReturn && l.expectedKg !== null ? String(l.expectedKg) : ""])));
  const [rest, setRest] = useState<"later" | "never">("later");
  const [photos, setPhotos] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const short = order.lines.filter((l) => (qty[l.itemId] ?? 0) < l.expected);
  const nothing = order.lines.every((l) => (qty[l.itemId] ?? 0) === 0);
  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await wh.validate(viewer, order.id, {
        stockDocId,
        lines: order.lines.map((l) => ({ itemId: l.itemId, qty: qty[l.itemId] ?? 0, ...(kgs[l.itemId]?.trim() ? { kg: kgs[l.itemId]!.trim().replace(",", ".") } : {}) })),
        ...(!isReturn && short.length > 0 ? { backorder: rest === "later", backorderId: rest === "later" ? backorderId : null } : {}),
        ...(photos.length ? { mediaIds: photos } : {}),
      });
      const parts = [isReturn ? `${r.number} sent back — it has left the warehouse.` : `${r.number} received — it is in the warehouse now.`];
      if (r.backorder) parts.push(`The rest is expected as ${r.backorder.number}.`);
      if (!isReturn && r.short.length > 0) parts.push("The Ops Head has been told it came short.");
      if (isReturn) parts.push("The Ops Head has been told.");
      onDone(parts.join(" "));
    } catch (e) {
      setErr(errorText(e));
      setBusy(false);
    }
  };
  return (
    <Sheet
      title={isReturn ? `↩️ Send back ${order.number}` : `📦 Receive ${order.number}`}
      onClose={onClose}
      footer={
        <BigButton onClick={save} busy={busy} disabled={nothing}>
          {isReturn ? "Send back" : "Receive"}
        </BigButton>
      }
    >
      <p className="text-sm text-mut">
        {isReturn
          ? `What goes back to ${order.supplier.name} now. It leaves the warehouse's stock when you press Send back.`
          : `Count what came from ${order.supplier.name}, and weigh it. Each line starts at what was expected — change what is different.`}
      </p>
      <ul className="space-y-2">
        {order.lines.map((l) => {
          const got = qty[l.itemId] ?? 0;
          const weighed = Number((kgs[l.itemId] ?? "").replace(",", "."));
          // The note weighs what was expected: what came is held to its share of it (the server's rule, noteGramsFor).
          const noteForGot = l.expectedKg === null || l.expected <= 0 ? null : Math.round((l.expectedKg * got * 1000) / l.expected) / 1000;
          const weightHint =
            noteForGot === null || got <= 0
              ? undefined
              : weighed > 0 && weighed < noteForGot
                ? `${kg(Math.round((noteForGot - weighed) * 1000) / 1000)} under the note's ${kg(noteForGot)} for ${amount(got, l.unit)}`
                : `The note's weight for ${amount(got, l.unit)}: ${kg(noteForGot)}`;
          return (
            <li key={l.itemId} className="space-y-2 rounded-xl border border-edge bg-panel p-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-semibold">
                  <span aria-hidden className="mr-1 text-xl">{l.icon ?? "📦"}</span>
                  {l.name}
                </span>
                <span className="text-sm text-mut">
                  {isReturn ? "planned" : "expected"} {amount(l.expected, l.unit)}
                  {l.expectedKg !== null ? ` · ${kg(l.expectedKg)}` : ""}
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <Stepper label={`${l.name} ${isReturn ? "going back" : "that came"}, in ${l.unit}s`} value={got} onChange={(v) => setQty((x) => ({ ...x, [l.itemId]: v }))} step={l.step} {...(isReturn ? { max: l.expected } : {})} />
                {got < l.expected ? <span className="text-sm font-semibold text-crit">{amount(Math.round((l.expected - got) * 1000) / 1000, l.unit)} short</span> : null}
                {got > l.expected ? <span className="text-sm font-semibold text-warn">{amount(Math.round((got - l.expected) * 1000) / 1000, l.unit)} more than expected</span> : null}
              </div>
              <TextField
                label={isReturn ? "Weight going back, kg (optional)" : "Weight on the scale, kg"}
                value={kgs[l.itemId] ?? ""}
                onChange={(v) => setKgs((x) => ({ ...x, [l.itemId]: v }))}
                type="number"
                placeholder={l.expectedKg !== null ? `the note says ${l.expectedKg} for ${amount(l.expected, l.unit)}` : "e.g. 342.5"}
                {...(!isReturn && weightHint ? { hint: weightHint } : {})}
              />
            </li>
          );
        })}
      </ul>
      {!isReturn && short.length > 0 && !nothing ? (
        <div className="space-y-2 rounded-xl border border-warn/40 bg-warn/10 p-3">
          <p className="text-sm font-semibold">Less came than expected. What about the rest?</p>
          <Chips
            options={[
              { value: "later", label: "It will come later", icon: "🕓" },
              { value: "never", label: "It will not come", icon: "✖️" },
            ]}
            value={rest}
            onPick={setRest}
          />
          <p className="text-xs text-mut">{rest === "later" ? "A new expected delivery is made for the rest." : "This one is closed short."}</p>
        </div>
      ) : null}
      <PhotoButton viewer={viewer} retention={isReturn ? "evidence" : "receipt"} ids={photos} onChange={setPhotos} />
      {nothing ? <p className="text-sm text-mut">{isReturn ? "Nothing to send back — cancel the return instead." : "Nothing came? Keep it expected, or cancel it."}</p> : null}
      <Problem text={err} />
    </Sheet>
  );
}

// ── a return from a received delivery ────────────────────────────────────────
export function ReturnSheet({ viewer, receipt, onDone, onClose }: { viewer: string; receipt: OrderCard; onDone: (id: string, msg: string) => void; onClose: () => void }) {
  const [id] = useState(newId);
  const [reason, setReason] = useState<ReturnReason | null>(null);
  const [qty, setQty] = useState<Record<string, number>>({});
  const [kgs, setKgs] = useState<Record<string, string>>({});
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const can = receipt.lines.filter((l) => (l.returnable ?? 0) > 0);
  const lines = can.filter((l) => (qty[l.itemId] ?? 0) > 0);
  const save = async () => {
    if (!reason) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await wh.startReturn(viewer, receipt.id, {
        id,
        reason,
        note: note.trim() || null,
        lines: lines.map((l) => ({ itemId: l.itemId, qty: qty[l.itemId]!, ...(kgs[l.itemId]?.trim() ? { kg: kgs[l.itemId]!.trim().replace(",", ".") } : {}) })),
      });
      onDone(r.id, `${r.number} is ready to go back — press Send back when it leaves.`);
    } catch (e) {
      setErr(errorText(e));
      setBusy(false);
    }
  };
  return (
    <Sheet title={`↩️ Return from ${receipt.number}`} onClose={onClose} footer={<BigButton onClick={save} busy={busy} disabled={!reason || lines.length === 0 || (reason === "other" && !note.trim())}>Make the return</BigButton>}>
      <p className="text-sm text-mut">Back to {receipt.supplier.name}. At most what came in this delivery, less anything already sent back.</p>
      <div>
        <p className="mb-1 text-sm font-semibold">Why does it go back?</p>
        <Chips options={RETURN_REASONS.map((r) => ({ value: r, label: RETURN_REASON_WORDS[r] }))} value={reason} onPick={setReason} />
      </div>
      <ul className="space-y-2">
        {can.map((l) => (
          <li key={l.itemId} className="space-y-2 rounded-xl border border-edge bg-panel p-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="font-semibold">
                <span aria-hidden className="mr-1 text-xl">{l.icon ?? "📦"}</span>
                {l.name}
              </span>
              <span className="text-sm text-mut">up to {amount(l.returnable ?? 0, l.unit)}</span>
            </div>
            <div className="flex flex-wrap items-end gap-3">
              <Stepper label={`${l.name} going back, in ${l.unit}s`} value={qty[l.itemId] ?? 0} onChange={(v) => setQty((x) => ({ ...x, [l.itemId]: v }))} step={l.step} max={l.returnable ?? 0} />
              <div className="w-36">
                <TextField label="kg (optional)" value={kgs[l.itemId] ?? ""} onChange={(v) => setKgs((x) => ({ ...x, [l.itemId]: v }))} type="number" />
              </div>
            </div>
          </li>
        ))}
      </ul>
      <TextArea label={reason === "other" ? "What is wrong" : "Note (optional)"} value={note} onChange={setNote} rows={2} maxLength={500} placeholder="e.g. Not good orange — black spots" />
      <Problem text={err} />
    </Sheet>
  );
}

// ── on the Stock home: what is expected at the door ──────────────────────────
/** "10 cartons Oranges, 2 boxes Cups". */
export const orderLinesText = (o: Pick<OrderCard, "lines">): string => o.lines.map((l) => `${amount(l.expected, l.unit)} ${l.name}`).join(", ");

/**
 * Deliveries marked expected whose day has come (or that have no day), and returns ready to go back — each with its one button,
 * so the person at the door receives the delivery that was planned instead of typing a new one.
 */
export function ExpectedSection({ orders, canMove, onReceive, onAll }: { orders: OrderCard[]; canMove: boolean; onReceive: (o: OrderCard) => void; onAll: () => void }) {
  const today = dubaiDay(0);
  const due = orders
    .filter((o) => o.state === "ready" && (o.kind === "supplier_return" || o.scheduledOn === null || o.scheduledOn <= today))
    .sort((a, b) => Number(b.overdue) - Number(a.overdue) || (a.scheduledOn ?? "9999").localeCompare(b.scheduledOn ?? "9999"));
  if (due.length === 0) return null;
  const shown = due.slice(0, 5);
  return (
    <section aria-label="Expected at the door" className="space-y-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-base font-bold">Expected at the door</h3>
        <button onClick={onAll} className="min-h-10 text-sm font-semibold text-link hover:underline">
          All deliveries →
        </button>
      </div>
      {shown.map((o) => (
        <div key={o.id} className={`flex flex-wrap items-center justify-between gap-2 rounded-xl border p-3 ${o.overdue ? "border-crit/50 bg-crit/5" : "border-edge bg-panel"}`}>
          <div className="min-w-0">
            <div className="font-semibold">
              {kindIcon(o.kind)} {o.kind === "receipt" ? `From ${o.supplier.name}` : `Back to ${o.supplier.name}`} <span className="text-sm font-normal text-mut">· {o.number}</span>
            </div>
            <div className="text-sm">{orderLinesText(o)}</div>
            <div className="text-xs text-mut">
              {o.kind === "receipt" ? (o.scheduledOn ? (o.overdue ? `Expected ${dayWords(o.scheduledOn)} — late` : "Expected today") : "Expected — no day given") : `Ready to go back · ${o.reason ? RETURN_REASON_WORDS[o.reason] : ""}`}
              {o.sourceRef ? ` · note ${o.sourceRef}` : ""}
            </div>
          </div>
          {canMove && o.may.validate ? (
            <button onClick={() => onReceive(o)} className="min-h-12 rounded-xl border border-ok bg-ok/10 px-4 font-semibold text-ok hover:bg-ok/20">
              {o.kind === "receipt" ? "Receive" : "Send back"}
            </button>
          ) : null}
        </div>
      ))}
      {due.length > shown.length ? <p className="text-sm text-mut">…and {due.length - shown.length} more in Deliveries.</p> : null}
    </section>
  );
}
