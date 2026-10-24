import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Card, Empty, Spinner } from "../components/ui";
import { amount, inv, KIND_WORDS, REASON_WORDS, type Holder, type ItemNow } from "../lib/inventory-api";
import { RETURN_REASON_WORDS, dayWords, dubaiDay, kg, wh, type ItemTracking, type MoveRow, type MovesReport, type StockAt, type SupplierRow } from "../lib/warehouse-api";
import { Problem, errorText, when } from "./inv-ui";
import { Segmented } from "./wh-docs";

/**
 * Reports (TASK-086): the warehouse's figures for checking and for the accountant — what was where at the end of a day, every
 * movement line by line (and as a spreadsheet), one item's whereabouts and lots, and how each supplier's deliveries went. Every
 * figure is summed by Postgres from the append-only ledger (core/warehouse-reports.ts); this page only lays it out.
 */

type Report = "stock" | "moves" | "item" | "suppliers";
const REPORTS: { value: Report; label: string }[] = [
  { value: "stock", label: "Stock on a day" },
  { value: "moves", label: "Every movement" },
  { value: "item", label: "One item" },
  { value: "suppliers", label: "Suppliers" },
];
const MOVE_KINDS = ["receipt", "supplier_return", "handover", "use", "damage", "count_adjustment", "reversal"] as const;

export default function ReportsView({ viewer, items }: { viewer: string; items: ItemNow[] }) {
  const [report, setReport] = useState<Report>("stock");
  return (
    <div className="space-y-4">
      <Segmented label="Report" options={REPORTS} value={report} onPick={setReport} />
      {report === "stock" ? <StockOnADay viewer={viewer} /> : null}
      {report === "moves" ? <EveryMove viewer={viewer} items={items} /> : null}
      {report === "item" ? <OneItem viewer={viewer} items={items} /> : null}
      {report === "suppliers" ? <Suppliers viewer={viewer} /> : null}
    </div>
  );
}

const Explain = ({ children }: { children: ReactNode }) => <p className="text-sm text-mut">{children}</p>;

function DayInput({ label, value, onChange, max }: { label: string; value: string; onChange: (v: string) => void; max?: string }) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="font-semibold">{label}</span>
      <input type="date" value={value} max={max} onChange={(e) => e.target.value && onChange(e.target.value)} className="h-11 rounded-xl border border-edge bg-sunken px-2" />
    </label>
  );
}

// ── stock on a day ───────────────────────────────────────────────────────────
function StockOnADay({ viewer }: { viewer: string }) {
  const today = dubaiDay(0);
  const [day, setDay] = useState(today);
  const [data, setData] = useState<StockAt | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setData(null);
    setErr(null);
    wh.stockAt(viewer, day === today ? null : day).then(
      (d) => live && setData(d),
      (e) => live && setErr(errorText(e)),
    );
    return () => {
      live = false;
    };
  }, [viewer, day, today]);
  return (
    <div className="space-y-3">
      <Explain>
        What was where at the end of the day you choose — added up from every recorded movement, so a past day is shown exactly as it was, even
        after later corrections. Today means right now.
      </Explain>
      <div className="flex flex-wrap items-end gap-2">
        <DayInput label="Day" value={day} onChange={setDay} max={today} />
        {day !== today ? (
          <button onClick={() => setDay(today)} className="min-h-11 rounded-xl border border-edge px-3 text-sm font-semibold hover:border-link">
            Now
          </button>
        ) : null}
      </div>
      {err ? <Empty>{err}</Empty> : null}
      {!data && !err ? <Spinner label="Adding up…" /> : null}
      {data ? (
        <>
          <p className="text-sm font-semibold">{data.date ? `At the end of ${dayWords(data.date)}` : `Now (${when(data.at)})`}</p>
          {data.items.length === 0 ? <Empty>No stock anywhere then.</Empty> : null}
          {data.items.length > 0 ? (
            <Table
              head={["Item", "Warehouse", "With people", "Being handed over", "In all"]}
              align={["left", "right", "right", "right", "right"]}
              rows={data.items.map((i) => [
                <span key="n" className="font-semibold">
                  {i.icon ?? "📦"} {i.name}
                </span>,
                amount(i.warehouse, i.unit),
                i.withPeople ? amount(i.withPeople, i.unit) : "—",
                i.inTransit ? amount(i.inTransit, i.unit) : "—",
                <b key="t">{amount(i.total, i.unit)}</b>,
              ])}
            />
          ) : null}
          {data.people.length > 0 ? (
            <details className="rounded-xl border border-edge bg-panel p-3">
              <summary className="min-h-10 cursor-pointer font-semibold">Who held what ({data.people.length})</summary>
              <ul className="mt-2 divide-y divide-edge text-sm">
                {data.people.map((p) => (
                  <li key={p.employeeId} className="py-2">
                    <span className="font-semibold">{p.name}</span>:{" "}
                    {p.items
                      .map((x) => {
                        const it = data.items.find((i) => i.id === x.itemId);
                        return it ? `${amount(x.qty, it.unit)} ${it.name}` : null;
                      })
                      .filter(Boolean)
                      .join(", ")}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

// ── every movement ───────────────────────────────────────────────────────────
const placeWords = (p: MoveRow["from"]) => p.name;
const moveWhat = (m: MoveRow) => {
  const k = KIND_WORDS[m.kind] ?? m.kind;
  const why = m.reason ? (RETURN_REASON_WORDS[m.reason as keyof typeof RETURN_REASON_WORDS] ?? REASON_WORDS[m.reason] ?? m.reason) : null;
  const step = m.step === "refuse" ? "refused" : m.step === "cancel" ? "cancelled" : m.step === "settle_back" ? "came back" : m.step === "write_off" ? "written off" : null;
  return [k, step, why].filter(Boolean).join(" · ");
};

function MovesTable({ rows }: { rows: MoveRow[] }) {
  return (
    <Table
      head={["When", "What", "Item", "Amount", "From → to", "By", "Paper"]}
      align={["left", "left", "left", "right", "left", "left", "left"]}
      rows={rows.map((m) => [
        <span key="w" className="whitespace-nowrap">{when(m.at)}</span>,
        moveWhat(m),
        `${m.item.icon ?? ""} ${m.item.name}`,
        <span key="a" className="whitespace-nowrap font-semibold">{amount(m.qty, m.item.unit)}</span>,
        `${placeWords(m.from)} → ${placeWords(m.to)}`,
        m.by.name,
        m.order?.number ?? (m.supplier ? m.supplier : ""),
      ])}
    />
  );
}

function EveryMove({ viewer, items }: { viewer: string; items: ItemNow[] }) {
  const today = dubaiDay(0);
  const [from, setFrom] = useState(dubaiDay(-6));
  const [to, setTo] = useState(today);
  const [itemId, setItemId] = useState("");
  const [employeeId, setEmployeeId] = useState("");
  const [kind, setKind] = useState("");
  const [holders, setHolders] = useState<Holder[]>([]);
  const [data, setData] = useState<MovesReport | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const f = useMemo(() => ({ from, to, ...(itemId ? { itemId } : {}), ...(employeeId ? { employeeId } : {}), ...(kind ? { kind } : {}) }), [from, to, itemId, employeeId, kind]);
  useEffect(() => {
    inv.holders(viewer).then(setHolders, () => setHolders([]));
  }, [viewer]);
  const load = useCallback(async () => {
    setData(null);
    setErr(null);
    try {
      setData(await wh.moves(viewer, f));
    } catch (e) {
      setErr(errorText(e));
    }
  }, [viewer, f]);
  useEffect(() => {
    void load();
  }, [load]);
  const older = async () => {
    if (!data?.cursor) return;
    try {
      const r = await wh.moves(viewer, { ...f, cursor: data.cursor });
      setData({ ...r, rows: [...data.rows, ...r.rows] });
    } catch (e) {
      setErr(errorText(e));
    }
  };
  const download = async () => {
    setSaving(true);
    setSaveErr(null);
    try {
      await wh.downloadMoves(viewer, f);
    } catch (e) {
      setSaveErr(errorText(e));
    }
    setSaving(false);
  };
  const person = holders.find((h) => h.id === employeeId);
  return (
    <div className="space-y-3">
      <Explain>One row for each item moved, newest first — for checking, and for the accountant. Choose the days, and narrow it down if you like.</Explain>
      <div className="grid grid-cols-2 gap-2 rounded-xl border border-edge bg-panel p-3 sm:grid-cols-5">
        <DayInput label="From" value={from} onChange={setFrom} max={to} />
        <DayInput label="To" value={to} onChange={setTo} max={today} />
        <Pick label="Item" value={itemId} onChange={setItemId} all="All items" options={items.map((i) => ({ value: i.id, label: i.name }))} />
        <Pick label="Person" value={employeeId} onChange={setEmployeeId} all="Everyone" options={holders.map((h) => ({ value: h.id, label: h.name }))} />
        <Pick label="Kind" value={kind} onChange={setKind} all="Every kind" options={MOVE_KINDS.map((k) => ({ value: k, label: KIND_WORDS[k] ?? k }))} />
      </div>
      {err ? <Empty>{err}</Empty> : null}
      {!data && !err ? <Spinner label="Reading the movements…" /> : null}
      {data ? (
        <>
          {data.totals.length > 0 ? (
            <Card className="p-3">
              <p className="mb-2 text-sm font-semibold">
                {person ? `Into and out of ${person.name}'s stock` : "Into and out of the warehouse"}, over these days{data.more ? " (all of them, not only the rows below)" : ""}
              </p>
              <ul className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-2">
                {data.totals.map((t) => (
                  <li key={t.id} className="flex justify-between gap-2">
                    <span>
                      {t.icon ?? "📦"} {t.name}
                    </span>
                    <span className="tabular-nums">
                      <span className="text-ok">+{amount(t.into, t.unit)}</span> · <span className="text-crit">−{amount(t.outOf, t.unit)}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}
          {data.rows.length === 0 ? <Empty>No movements with these choices.</Empty> : <MovesTable rows={data.rows} />}
          {data.more ? (
            <button onClick={older} className="min-h-12 w-full rounded-xl border border-edge bg-panel font-semibold hover:border-link">
              Older
            </button>
          ) : null}
          <div className="space-y-1">
            <button onClick={download} disabled={saving || data.rows.length === 0} className="min-h-12 w-full rounded-xl border border-ok bg-ok/10 font-semibold text-ok disabled:opacity-50 sm:w-auto sm:px-5">
              {saving ? "…" : "⬇ Download as a spreadsheet (CSV)"}
            </button>
            <p className="text-xs text-mut">Opens in Excel or Google Sheets. Up to 10,000 rows a file — choose fewer days for more.</p>
            <Problem text={saveErr} />
          </div>
        </>
      ) : null}
    </div>
  );
}

// ── one item ─────────────────────────────────────────────────────────────────
function OneItem({ viewer, items }: { viewer: string; items: ItemNow[] }) {
  const today = dubaiDay(0);
  const [itemId, setItemId] = useState(items.find((i) => i.category === "oranges")?.id ?? items[0]?.id ?? "");
  const [from, setFrom] = useState(dubaiDay(-29));
  const [to, setTo] = useState(today);
  const [data, setData] = useState<ItemTracking | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (!itemId) return;
    let live = true;
    setData(null);
    setErr(null);
    wh.tracking(viewer, itemId, from, to).then(
      (d) => live && setData(d),
      (e) => live && setErr(errorText(e)),
    );
    return () => {
      live = false;
    };
  }, [viewer, itemId, from, to]);
  return (
    <div className="space-y-3">
      <Explain>Where every unit of one item is now, the deliveries (lots) it came in, and everything that moved it over the days you choose.</Explain>
      <div className="grid grid-cols-2 gap-2 rounded-xl border border-edge bg-panel p-3 sm:grid-cols-3">
        <div className="col-span-2 sm:col-span-1">
          <Pick label="Item" value={itemId} onChange={setItemId} options={items.map((i) => ({ value: i.id, label: i.name }))} />
        </div>
        <DayInput label="From" value={from} onChange={setFrom} max={to} />
        <DayInput label="To" value={to} onChange={setTo} max={today} />
      </div>
      {err ? <Empty>{err}</Empty> : null}
      {!data && !err && itemId ? <Spinner label="Following it…" /> : null}
      {data ? (
        <>
          <section aria-label="Where it is now" className="space-y-1">
            <h3 className="text-base font-bold">Where it is now</h3>
            {data.now.length === 0 ? (
              <p className="text-sm text-mut">None anywhere.</p>
            ) : (
              <ul className="flex flex-wrap gap-2">
                {data.now.map((n) => (
                  <li key={n.place.id} className="rounded-xl border border-edge bg-panel px-3 py-2 text-sm">
                    <span className="text-mut">{n.place.name}</span> <b className="tabular-nums">{amount(n.qty, data.item.unit)}</b>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section aria-label="Lots" className="space-y-1">
            <h3 className="text-base font-bold">Deliveries it came in (lots)</h3>
            {data.lots.length === 0 ? (
              <p className="text-sm text-mut">No lots yet — a lot is made when a planned delivery is received in Deliveries.</p>
            ) : (
              <Table
                head={["Lot", "Supplier", "Received", "Best before", "Variety", "Amount", "Weighed"]}
                align={["left", "left", "left", "left", "left", "right", "right"]}
                rows={data.lots.map((l) => [
                  <span key="c" className="font-semibold">{l.code}</span>,
                  l.supplier,
                  dayWords(l.receivedOn),
                  l.bestBefore ? dayWords(l.bestBefore) : "—",
                  l.variety ?? "—",
                  amount(l.qty, data.item.unit),
                  l.kg === null ? "—" : kg(l.kg),
                ])}
              />
            )}
          </section>
          <section aria-label="Its movements" className="space-y-1">
            <h3 className="text-base font-bold">What moved it</h3>
            {data.moves.length === 0 ? <p className="text-sm text-mut">Nothing moved it over these days.</p> : <MovesTable rows={data.moves} />}
            {data.more ? <p className="text-xs text-mut">Only the newest {data.moves.length} are shown — choose fewer days for the rest.</p> : null}
          </section>
        </>
      ) : null}
    </div>
  );
}

// ── suppliers ────────────────────────────────────────────────────────────────
function Suppliers({ viewer }: { viewer: string }) {
  const today = dubaiDay(0);
  const [from, setFrom] = useState(`${today.slice(0, 8)}01`);
  const [to, setTo] = useState(today);
  const [data, setData] = useState<{ lightShare: number; rows: SupplierRow[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setData(null);
    setErr(null);
    wh.supplierReport(viewer, from, to).then(
      (d) => live && setData(d),
      (e) => live && setErr(errorText(e)),
    );
    return () => {
      live = false;
    };
  }, [viewer, from, to]);
  const of = (a: number, b: number) => (b === 0 ? "—" : `${a} of ${b}`);
  const rows = data?.rows ?? null;
  const share = data ? `${(data.lightShare * 100).toLocaleString("en-GB", { maximumFractionDigits: 1 })} %` : "a set share";
  return (
    <div className="space-y-3">
      <Explain>
        How each supplier's deliveries went over the days you choose: counted, not scored. “On time” counts the deliveries that had a day expected;
        “complete” counts the lines that came in full. “Weight” sets the scale against the delivery note's kilograms for what came — 8 of 10
        cartons are held to 8/10 of the note — and “lighter” counts the lines more than {share} under it.
      </Explain>
      <div className="grid grid-cols-2 gap-2 rounded-xl border border-edge bg-panel p-3 sm:max-w-md">
        <DayInput label="From" value={from} onChange={setFrom} max={to} />
        <DayInput label="To" value={to} onChange={setTo} max={today} />
      </div>
      {err ? <Empty>{err}</Empty> : null}
      {!rows && !err ? <Spinner label="Counting…" /> : null}
      {rows && rows.length === 0 ? <Empty>No deliveries or returns over these days.</Empty> : null}
      {rows && rows.length > 0 ? (
        <Table
          head={["Supplier", "Received", "On time", "Lines complete", "Weight: scale of note", "Lighter lines", "Returns", "Still to come"]}
          align={["left", "right", "right", "right", "right", "right", "right", "right"]}
          rows={rows.map((r) => [
            <span key="s" className="font-semibold">{r.supplier.name}</span>,
            String(r.receipts),
            of(r.onTime, r.scheduled),
            of(r.linesComplete, r.lines),
            r.kgExpected === null || r.kgReceived === null ? "—" : `${kg(r.kgReceived)} of ${kg(r.kgExpected)}`,
            r.kgExpected === null ? "—" : String(r.linesLight),
            r.returns ? `${r.returns} (${r.returnLines} line${r.returnLines === 1 ? "" : "s"})` : "0",
            r.open ? `${r.open}${r.overdue ? ` · ${r.overdue} late` : ""}` : "0",
          ])}
        />
      ) : null}
    </div>
  );
}

// ── small pieces ─────────────────────────────────────────────────────────────
function Pick({ label, value, onChange, options, all }: { label: string; value: string; onChange: (v: string) => void; options: { value: string; label: string }[]; all?: string }) {
  return (
    <label className="flex min-w-0 flex-col gap-1 text-sm">
      <span className="font-semibold">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} className="h-11 min-w-0 rounded-xl border border-edge bg-sunken px-2">
        {all !== undefined ? <option value="">{all}</option> : null}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function Table({ head, rows, align }: { head: string[]; rows: ReactNode[][]; align: ("left" | "right")[] }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-edge bg-panel">
      <table className="w-full min-w-[36rem] text-sm">
        <thead className="bg-sunken text-xs text-mut">
          <tr>
            {head.map((h, i) => (
              <th key={h} scope="col" className={`px-2 py-2 ${align[i] === "right" ? "text-right" : "text-left"}`}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, j) => (
            <tr key={j} className="border-t border-edge align-top">
              {r.map((c, i) => (
                <td key={i} className={`px-2 py-1.5 ${align[i] === "right" ? "text-right tabular-nums" : ""}`}>
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
