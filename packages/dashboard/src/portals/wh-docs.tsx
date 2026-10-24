import { useCallback, useEffect, useMemo, useState } from "react";
import { Card, Empty, Spinner } from "../components/ui";
import type { InventoryAbilities, ItemNow } from "../lib/inventory-api";
import { RETURN_REASON_WORDS, dayWords, kg, wh, type OrderCard, type OrderKind, type OrderState, type Supplier } from "../lib/warehouse-api";
import { Sheet, errorText, when } from "./inv-ui";
import { OrderEditor, OrderSheet, ReceiveSheet, ReturnSheet, StateBadge, SupplierSheet, orderLinesText } from "./wh-sheets";

/**
 * Deliveries (TASK-086): what the suppliers will bring, and what goes back to them. A delivery is written down when it is ordered
 * (a draft, then "expected"), received at the door against what was expected, and only then added to stock — short ones either
 * wait for the rest or close short. A return takes stock out to the supplier, never more than came. Every list and figure comes
 * from the server; this page asks, and leaves out the buttons the server would refuse.
 */

type Show = "open" | "done" | "cancelled" | "all";
const SHOW: { value: Show; label: string }[] = [
  { value: "open", label: "Still to do" },
  { value: "done", label: "Done" },
  { value: "cancelled", label: "Cancelled" },
  { value: "all", label: "Everything" },
];
const KINDS: { value: OrderKind | "both"; label: string }[] = [
  { value: "both", label: "Both" },
  { value: "receipt", label: "📦 Deliveries in" },
  { value: "supplier_return", label: "↩️ Returns" },
];

type Open =
  | { kind: "order"; id: string }
  | { kind: "edit"; orderKind: OrderKind; order: OrderCard | null }
  | { kind: "receive"; order: OrderCard }
  | { kind: "return"; receipt: OrderCard }
  | { kind: "suppliers" };

export default function DeliveriesView({
  viewer,
  can,
  items,
  figuresHidden,
  liveTick,
  onChanged,
}: {
  viewer: string;
  can: InventoryAbilities;
  items: ItemNow[];
  figuresHidden: boolean;
  liveTick: number;
  /** Something changed stock or a document: the portal reloads its home and says so. */
  onChanged: (msg: string) => void;
}) {
  const [show, setShow] = useState<Show>("open");
  const [kind, setKind] = useState<OrderKind | "both">("both");
  const [supplierId, setSupplierId] = useState("");
  const [search, setSearch] = useState("");
  const [typed, setTyped] = useState("");
  const [orders, setOrders] = useState<OrderCard[] | null>(null);
  const [more, setMore] = useState(false);
  const [cursor, setCursor] = useState<string | null>(null);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<Open | null>(null);
  // A supplier sheet over another sheet (adding one while writing a delivery, or editing one from the list).
  const [supplierSheet, setSupplierSheet] = useState<{ supplier: Supplier | null } | null>(null);
  const [justAdded, setJustAdded] = useState<string | null>(null);
  // On a phone the choices fold into one line, so the list starts on the first screen.
  const [filtersOpen, setFiltersOpen] = useState(false);

  const filters = useMemo(
    () => ({
      ...(show === "all" ? {} : { state: show === "open" ? ("open" as const) : (show as OrderState) }),
      ...(kind === "both" ? {} : { kind }),
      ...(supplierId ? { supplierId } : {}),
      ...(search ? { search } : {}),
    }),
    [show, kind, supplierId, search],
  );
  const load = useCallback(async () => {
    try {
      const r = await wh.orders(viewer, filters);
      setOrders(r.orders);
      setMore(r.more);
      setCursor(r.cursor);
      setErr(null);
    } catch (e) {
      setErr(errorText(e));
    }
  }, [viewer, filters]);
  const loadSuppliers = useCallback(async () => {
    try {
      setSuppliers(await wh.suppliers(viewer));
    } catch {
      // The list still works without the supplier filter.
    }
  }, [viewer]);
  useEffect(() => {
    void load();
  }, [load, liveTick]);
  useEffect(() => {
    void loadSuppliers();
  }, [loadSuppliers]);
  // Search as the person stops typing, not on every key.
  useEffect(() => {
    const t = setTimeout(() => setSearch(typed.trim()), 350);
    return () => clearTimeout(t);
  }, [typed]);

  const older = async () => {
    if (!cursor) return;
    try {
      const r = await wh.orders(viewer, { ...filters, cursor });
      setOrders((o) => [...(o ?? []), ...r.orders]);
      setMore(r.more);
      setCursor(r.cursor);
    } catch (e) {
      setErr(errorText(e));
    }
  };
  const done = (msg: string, next: Open | null = null) => {
    setOpen(next);
    onChanged(msg);
    void load();
    void loadSuppliers();
  };

  // Still to do: the late ones first, then by the day expected; the rest newest first, as the server sends them.
  const shown = useMemo(() => {
    if (!orders) return null;
    if (show !== "open") return orders;
    return [...orders].sort((a, b) => Number(b.overdue) - Number(a.overdue) || (a.scheduledOn ?? "9999").localeCompare(b.scheduledOn ?? "9999"));
  }, [orders, show]);
  const available = useMemo(() => (figuresHidden ? null : Object.fromEntries(items.filter((i) => i.warehouse !== null).map((i) => [i.id, i.warehouse as number]))), [items, figuresHidden]);
  const late = orders?.filter((o) => o.overdue).length ?? 0;

  return (
    <div className="space-y-4">
      <p className="text-sm text-mut">
        What suppliers will bring, and what goes back to them. A delivery is added to stock only when it is received at the door — counted and
        weighed against what was expected.
      </p>

      {can.move ? (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          <Tile icon="📦" label="Expect a delivery" onClick={() => setOpen({ kind: "edit", orderKind: "receipt", order: null })} />
          <Tile icon="↩️" label="Send back to a supplier" onClick={() => setOpen({ kind: "edit", orderKind: "supplier_return", order: null })} />
          <Tile icon="🏷️" label={`Suppliers (${suppliers.filter((s) => s.active).length})`} onClick={() => setOpen({ kind: "suppliers" })} />
        </div>
      ) : (
        <button onClick={() => setOpen({ kind: "suppliers" })} className="min-h-11 rounded-xl border border-edge px-3 text-sm font-semibold hover:border-link">
          🏷️ Suppliers ({suppliers.filter((s) => s.active).length})
        </button>
      )}

      <button
        onClick={() => setFiltersOpen((o) => !o)}
        aria-expanded={filtersOpen}
        className="flex min-h-12 w-full items-center justify-between gap-2 rounded-xl border border-edge bg-panel px-3 text-left text-sm sm:hidden"
      >
        <span className="min-w-0 truncate">
          <span className="font-semibold">Showing:</span> {SHOW.find((x) => x.value === show)?.label.toLowerCase()} ·{" "}
          {kind === "both" ? "deliveries and returns" : kind === "receipt" ? "deliveries in" : "returns"} ·{" "}
          {suppliers.find((x) => x.id === supplierId)?.name ?? "all suppliers"}
          {search ? ` · “${search}”` : ""}
        </span>
        <span className="shrink-0 font-semibold text-link">{filtersOpen ? "Done" : "Change"}</span>
      </button>
      <div className={`${filtersOpen ? "block" : "hidden"} space-y-2 rounded-xl border border-edge bg-panel p-3 sm:block`}>
        <Segmented label="Show" options={SHOW} value={show} onPick={setShow} />
        <Segmented label="Which" options={KINDS} value={kind} onPick={setKind} />
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-semibold">Supplier</span>
            <select value={supplierId} onChange={(e) => setSupplierId(e.target.value)} className="h-11 rounded-xl border border-edge bg-sunken px-2">
              <option value="">All suppliers</option>
              {suppliers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                  {s.active ? "" : " (not in use)"}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-semibold">Find</span>
            <input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder="A number (IN-2026-0004), a note no. or a plate"
              maxLength={60}
              className="h-11 rounded-xl border border-edge bg-sunken px-3"
            />
          </label>
        </div>
      </div>

      {err ? <Empty>{err}</Empty> : null}
      {!shown && !err ? <Spinner label="Loading deliveries…" /> : null}
      {shown && shown.length === 0 ? (
        <Empty>
          {show === "open"
            ? can.move
              ? "Nothing expected. When you order from a supplier, press “Expect a delivery” so the door knows what is coming."
              : "Nothing expected right now."
            : "Nothing here with these choices."}
        </Empty>
      ) : null}
      {show === "open" && late > 0 ? (
        <p className="text-sm font-semibold text-crit">
          {late} {late === 1 ? "is" : "are"} late — {late === 1 ? "its" : "their"} day has passed. Receive, change the day, or cancel.
        </p>
      ) : null}

      <ul className="space-y-2">
        {shown?.map((o) => (
          <li key={o.id}>
            <OrderRow o={o} canMove={can.move} onOpen={() => setOpen({ kind: "order", id: o.id })} onReceive={() => setOpen({ kind: "receive", order: o })} />
          </li>
        ))}
      </ul>
      {more ? (
        <button onClick={older} className="min-h-12 w-full rounded-xl border border-edge bg-panel font-semibold hover:border-link">
          Older
        </button>
      ) : null}

      {open?.kind === "order" ? (
        <OrderSheet
          viewer={viewer}
          id={open.id}
          onEdit={(order) => setOpen({ kind: "edit", orderKind: order.kind, order })}
          onReceive={(order) => setOpen({ kind: "receive", order })}
          onReturn={(receipt) => setOpen({ kind: "return", receipt })}
          onOpen={(id) => setOpen({ kind: "order", id })}
          onChanged={(msg) => done(msg, { kind: "order", id: open.id })}
          onClose={() => setOpen(null)}
        />
      ) : null}
      {open?.kind === "edit" ? (
        <OrderEditor
          viewer={viewer}
          kind={open.orderKind}
          order={open.order}
          items={items}
          suppliers={suppliers}
          available={available}
          pickSupplier={justAdded}
          onNewSupplier={() => setSupplierSheet({ supplier: null })}
          onDone={(id, msg) => done(msg, { kind: "order", id })}
          onClose={() => {
            setOpen(null);
            setJustAdded(null);
          }}
        />
      ) : null}
      {open?.kind === "receive" ? <ReceiveSheet viewer={viewer} order={open.order} onDone={(msg) => done(msg, { kind: "order", id: open.order.id })} onClose={() => setOpen(null)} /> : null}
      {open?.kind === "return" ? <ReturnSheet viewer={viewer} receipt={open.receipt} onDone={(id, msg) => done(msg, { kind: "order", id })} onClose={() => setOpen(null)} /> : null}
      {open?.kind === "suppliers" ? (
        <SuppliersSheet suppliers={suppliers} canMove={can.move} onEdit={(s) => setSupplierSheet({ supplier: s })} onPick={(id) => { setSupplierId(id); setShow("all"); setOpen(null); }} onClose={() => setOpen(null)} />
      ) : null}
      {supplierSheet ? (
        <SupplierSheet
          viewer={viewer}
          supplier={supplierSheet.supplier}
          onDone={(id, msg) => {
            setSupplierSheet(null);
            if (!supplierSheet.supplier) setJustAdded(id);
            onChanged(msg);
            void loadSuppliers();
          }}
          onClose={() => setSupplierSheet(null)}
        />
      ) : null}
    </div>
  );
}

function OrderRow({ o, canMove, onOpen, onReceive }: { o: OrderCard; canMove: boolean; onOpen: () => void; onReceive: () => void }) {
  const isReturn = o.kind === "supplier_return";
  const day =
    o.state === "done" && o.doneAt
      ? `${isReturn ? "Sent back" : "Received"} ${when(o.doneAt)}${o.doneBy ? ` by ${o.doneBy.name}` : ""}`
      : o.state === "cancelled" && o.cancelledAt
        ? `Cancelled ${when(o.cancelledAt)}`
        : o.scheduledOn
          ? `${isReturn ? "Planned for" : "Expected"} ${dayWords(o.scheduledOn)}`
          : isReturn
            ? "No day planned"
            : "No day given";
  const weight = o.state === "done" && o.totals.doneKg !== null ? `${kg(o.totals.doneKg)} weighed` : o.totals.expectedKg !== null ? `${kg(o.totals.expectedKg)} on the note` : null;
  return (
    <Card className="flex flex-wrap items-center justify-between gap-3 p-3">
      <button onClick={onOpen} className="min-w-0 flex-1 text-left">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="font-semibold">
            {isReturn ? "↩️" : "📦"} {o.number}
          </span>
          <span className="text-sm">{isReturn ? `back to ${o.supplier.name}` : `from ${o.supplier.name}`}</span>
          <StateBadge o={o} />
        </div>
        <div className="mt-1 text-sm">{orderLinesText(o)}</div>
        <div className="text-xs text-mut">
          {day}
          {weight ? ` · ${weight}` : ""}
          {o.reason ? ` · ${RETURN_REASON_WORDS[o.reason]}` : ""}
          {o.sourceRef ? ` · note ${o.sourceRef}` : ""}
        </div>
      </button>
      {canMove && o.may.validate && o.state === "ready" ? (
        <button onClick={onReceive} className="min-h-12 rounded-xl border border-ok bg-ok/10 px-4 font-semibold text-ok hover:bg-ok/20">
          {isReturn ? "Send back" : "Receive"}
        </button>
      ) : null}
    </Card>
  );
}

function SuppliersSheet({ suppliers, canMove, onEdit, onPick, onClose }: { suppliers: Supplier[]; canMove: boolean; onEdit: (s: Supplier | null) => void; onPick: (id: string) => void; onClose: () => void }) {
  return (
    <Sheet title="🏷️ Suppliers" onClose={onClose} footer={canMove ? <button onClick={() => onEdit(null)} className="min-h-14 w-full rounded-2xl border border-ok bg-ok text-lg font-bold text-on-accent">+ New supplier</button> : undefined}>
      <p className="text-sm text-mut">Who delivers to the warehouse. Tap one to see their deliveries.</p>
      {suppliers.length === 0 ? <Empty>No suppliers yet.</Empty> : null}
      <ul className="divide-y divide-edge rounded-xl border border-edge bg-panel">
        {suppliers.map((s) => (
          <li key={s.id} className="flex items-center justify-between gap-2 p-3">
            <button onClick={() => onPick(s.id)} className="min-w-0 flex-1 text-left">
              <div className={`font-semibold ${s.active ? "" : "text-mut line-through"}`}>
                {s.name}
                {s.code ? <span className="ml-1 text-xs font-normal text-mut">{s.code}</span> : null}
              </div>
              <div className="text-xs text-mut">
                {s.open > 0 ? `${s.open} still to come` : "nothing open"}
                {s.lastDelivery ? ` · last delivery ${dayWords(s.lastDelivery.slice(0, 10))}` : " · no delivery yet"}
                {s.leadDays !== null ? ` · delivers in ${s.leadDays} day${s.leadDays === 1 ? "" : "s"}` : ""}
                {s.active ? "" : " · not in use"}
              </div>
            </button>
            {canMove ? (
              <button onClick={() => onEdit(s)} className="min-h-11 rounded-xl border border-edge px-3 text-sm font-semibold hover:border-link">
                Edit
              </button>
            ) : null}
          </li>
        ))}
      </ul>
    </Sheet>
  );
}

function Tile({ icon, label, onClick }: { icon: string; label: string; onClick: () => void }) {
  return (
    <button onClick={onClick} className="flex min-h-20 flex-col items-center justify-center gap-1 rounded-2xl border border-edge bg-panel p-2 text-center font-semibold hover:border-link">
      <span aria-hidden className="text-3xl">
        {icon}
      </span>
      {label}
    </button>
  );
}

export function Segmented<T extends string>({ label, options, value, onPick }: { label: string; options: { value: T; label: string }[]; value: T; onPick: (v: T) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-2" role="group" aria-label={label}>
      <span className="w-14 shrink-0 text-sm font-semibold">{label}</span>
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onPick(o.value)}
          aria-pressed={value === o.value}
          className={`min-h-10 rounded-xl border px-3 text-sm font-semibold ${value === o.value ? "border-ok bg-ok/10" : "border-edge bg-panel hover:border-link"}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
