import { useCallback, useEffect, useMemo, useState } from "react";
import { TextField } from "../components/form";
import { Card, Empty, Pill, Spinner } from "../components/ui";
import { amount, inv, newId, type Holder, type InventoryAbilities, type ItemNow } from "../lib/inventory-api";
import { dubaiDay, wh, type ReorderRule, type Suggestion, type Supplier } from "../lib/warehouse-api";
import { BigButton, Chips, Problem, Sheet, Stepper, errorText } from "./inv-ui";

/**
 * Reorder (TASK-086): for each item, the least to keep and the most to fill up to — in the warehouse, or with a person. When what is
 * there plus what is already coming falls below the least, the server suggests how much: up to the most, rounded up to whole packs
 * (core/warehouse-reports.ts). A suggestion orders nothing: the warehouse turns it into delivery drafts, or gives the stock out,
 * with a tap each.
 */

export default function ReorderView({ viewer, can, items, onChanged, onDeliveries }: { viewer: string; can: InventoryAbilities; items: ItemNow[]; onChanged: (msg: string) => void; onDeliveries: () => void }) {
  const [data, setData] = useState<{ hidden: boolean; warehouse: Suggestion[]; people: Suggestion[] } | null>(null);
  const [rules, setRules] = useState<ReorderRule[] | null>(null);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [rule, setRule] = useState<{ rule: ReorderRule | null } | null>(null);
  const [give, setGive] = useState<{ employeeId: string; name: string; rows: Suggestion[] } | null>(null);

  const load = useCallback(async () => {
    try {
      const [s, r, sup] = await Promise.all([wh.suggestions(viewer), wh.rules(viewer), wh.suppliers(viewer)]);
      setData(s);
      setRules(r);
      setSuppliers(sup);
      setErr(null);
    } catch (e) {
      setErr(errorText(e));
    }
  }, [viewer]);
  useEffect(() => {
    void load();
  }, [load]);
  const changed = (msg: string) => {
    onChanged(msg);
    void load();
  };

  if (err) return <Empty>{err}</Empty>;
  if (!data || !rules) return <Spinner label="Working out what to order…" />;
  const people = groupPeople(data.people);
  return (
    <div className="space-y-5">
      <p className="text-sm text-mut">
        For each item, set the <b>least</b> to keep and the <b>most</b> to fill up to. When what is there plus what is already on its way falls below
        the least, it is listed here with how much to order — enough to reach the most, in whole packs. Nothing is ordered by itself: you decide.
      </p>

      <WarehouseSuggestions viewer={viewer} rows={data.warehouse} hidden={data.hidden} suppliers={suppliers} canMove={can.move} onChanged={changed} onDeliveries={onDeliveries} />

      <section aria-label="To give out to people" className="space-y-2">
        <h3 className="text-base font-bold">To give out to people</h3>
        {people.length === 0 ? (
          <p className="text-sm text-mut">No one is below their least. {data.people.length === 0 ? "No rules for what people carry yet." : ""}</p>
        ) : (
          people.map((p) => (
            <Card key={p.employeeId} className="flex flex-wrap items-center justify-between gap-2 p-3">
              <div className="min-w-0">
                <div className="font-semibold">{p.name}</div>
                <ul className="text-sm">
                  {p.rows.map((s) => (
                    <li key={s.rule.id}>
                      {s.rule.item.icon ?? "📦"} {s.rule.item.name}: holds {amount(s.onHand, s.rule.item.unit)}
                      {s.incoming > 0 ? `, ${amount(s.incoming, s.rule.item.unit)} on its way` : ""} (least {amount(s.rule.min, s.rule.item.unit)}) → give{" "}
                      <b>{amount(s.suggest, s.rule.item.unit)}</b>
                    </li>
                  ))}
                </ul>
              </div>
              {can.move ? (
                <button onClick={() => setGive(p)} className="min-h-12 rounded-xl border border-ok bg-ok/10 px-4 font-semibold text-ok hover:bg-ok/20">
                  Give out
                </button>
              ) : null}
            </Card>
          ))
        )}
      </section>

      <section aria-label="Rules" className="space-y-2">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-base font-bold">What to keep ({rules.length})</h3>
          {can.move ? (
            <button onClick={() => setRule({ rule: null })} className="min-h-11 rounded-xl border border-ok bg-ok/10 px-3 text-sm font-semibold text-ok">
              + Add a rule
            </button>
          ) : null}
        </div>
        {rules.length === 0 ? <Empty>No rules yet. {can.move ? "Add one for each item you must not run out of." : ""}</Empty> : null}
        <ul className="divide-y divide-edge rounded-xl border border-edge bg-panel">
          {rules.map((r) => (
            <li key={r.id} className={`flex flex-wrap items-center justify-between gap-2 p-3 ${r.active ? "" : "opacity-60"}`}>
              <div className="min-w-0">
                <div className="font-semibold">
                  {r.item.icon ?? "📦"} {r.item.name} <span className="font-normal text-mut">· {r.place.kind === "warehouse" ? "in the warehouse" : `with ${r.place.name}`}</span>
                </div>
                <div className="text-xs text-mut">
                  Keep {amount(r.min, r.item.unit)} at least, fill up to {amount(r.max, r.item.unit)}
                  {r.multiple !== r.item.step ? ` · in packs of ${r.multiple}` : ""}
                  {r.supplier ? ` · from ${r.supplier.name}` : r.place.kind === "warehouse" ? " · no supplier chosen" : ""}
                  {r.active ? "" : " · switched off"}
                </div>
              </div>
              {can.move ? (
                <button onClick={() => setRule({ rule: r })} className="min-h-11 rounded-xl border border-edge px-3 text-sm font-semibold hover:border-link">
                  Edit
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      </section>

      {rule ? (
        <RuleSheet
          viewer={viewer}
          rule={rule.rule}
          items={items}
          suppliers={suppliers}
          onDone={(msg) => {
            setRule(null);
            changed(msg);
          }}
          onClose={() => setRule(null)}
        />
      ) : null}
      {give ? (
        <GiveOutSheet
          viewer={viewer}
          person={give}
          onDone={(msg) => {
            setGive(null);
            changed(msg);
          }}
          onClose={() => setGive(null)}
        />
      ) : null}
    </div>
  );
}

function groupPeople(rows: Suggestion[]): { employeeId: string; name: string; rows: Suggestion[] }[] {
  const by = new Map<string, { employeeId: string; name: string; rows: Suggestion[] }>();
  for (const s of rows) {
    if (s.suggest <= 0 || !s.rule.place.employeeId) continue;
    const g = by.get(s.rule.place.employeeId) ?? { employeeId: s.rule.place.employeeId, name: s.rule.place.name, rows: [] };
    g.rows.push(s);
    by.set(s.rule.place.employeeId, g);
  }
  return [...by.values()];
}

/** The warehouse's rows: what is short, ticked; one delivery draft per supplier from the ticked ones. */
function WarehouseSuggestions({
  viewer,
  rows,
  hidden,
  suppliers,
  canMove,
  onChanged,
  onDeliveries,
}: {
  viewer: string;
  rows: Suggestion[];
  hidden: boolean;
  suppliers: Supplier[];
  canMove: boolean;
  onChanged: (msg: string) => void;
  onDeliveries: () => void;
}) {
  const short = rows.filter((r) => r.suggest > 0);
  // What the person unticked — everything short with a supplier is ticked unless they say not, including rows that become short later.
  const [unticked, setUnticked] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [made, setMade] = useState<string | null>(null);
  const groups = useMemo(() => {
    const by = new Map<string, { supplier: { id: string; name: string }; rows: Suggestion[] }>();
    for (const r of short) {
      if (unticked.has(r.rule.id) || !r.rule.supplier) continue;
      const g = by.get(r.rule.supplier.id) ?? { supplier: r.rule.supplier, rows: [] };
      g.rows.push(r);
      by.set(r.rule.supplier.id, g);
    }
    return [...by.values()];
  }, [short, unticked]);

  const makeDrafts = async () => {
    setBusy(true);
    setErr(null);
    const numbers: string[] = [];
    try {
      for (const g of groups) {
        const lead = suppliers.find((s) => s.id === g.supplier.id)?.leadDays ?? null;
        const r = await wh.create(viewer, {
          id: newId(),
          kind: "receipt",
          supplierId: g.supplier.id,
          scheduledOn: lead === null ? null : dubaiDay(lead),
          note: "From the reorder list",
          lines: g.rows.map((s) => ({ itemId: s.rule.item.id, qty: s.suggest })),
        });
        numbers.push(`${r.number} (${g.supplier.name})`);
      }
      setMade(`Made ${numbers.length === 1 ? "a draft" : `${numbers.length} drafts`}: ${numbers.join(", ")}. Order from the supplier, then mark ${numbers.length === 1 ? "it" : "each"} as expected in Deliveries.`);
      onChanged(`Made ${numbers.length} delivery draft${numbers.length === 1 ? "" : "s"}.`);
    } catch (e) {
      // Drafts made before the failure stay made — say which.
      setErr(`${errorText(e)}${numbers.length ? ` (already made: ${numbers.join(", ")})` : ""}`);
    }
    setBusy(false);
  };

  return (
    <section aria-label="To order from suppliers" className="space-y-2">
      <h3 className="text-base font-bold">To order from suppliers</h3>
      {hidden ? <p className="rounded-xl border border-edge bg-panel p-3 text-sm text-mut">🔢 Hidden while you count — it would show the warehouse's figures. Hand your count in first.</p> : null}
      {!hidden && rows.length === 0 ? <p className="text-sm text-mut">No rules for the warehouse yet — add one below for each item you must not run out of.</p> : null}
      {!hidden && rows.length > 0 && short.length === 0 ? <p className="text-sm text-ok">✓ Nothing to order: every item is at or above its least, counting what is already on its way.</p> : null}
      {made ? (
        <div role="status" className="space-y-2 rounded-xl border border-ok/40 bg-ok/10 p-3 text-sm">
          <p className="font-semibold text-ok">{made}</p>
          <button onClick={onDeliveries} className="min-h-10 font-semibold text-link hover:underline">
            Open Deliveries →
          </button>
        </div>
      ) : null}
      {!hidden && rows.length > 0 ? (
        <>
          {/* A phone: one card per item, so the amount to order is never off the screen to the right. */}
          <ul className="space-y-2 sm:hidden">
            {rows.map((s) => {
              const need = s.suggest > 0;
              return (
                <li key={s.rule.id} className={`flex gap-3 rounded-xl border p-3 text-sm ${need ? "border-crit/40 bg-panel" : "border-edge bg-panel text-mut"}`}>
                  {canMove && need && s.rule.supplier ? <Tick s={s} unticked={unticked} setUnticked={setUnticked} /> : null}
                  <div className="min-w-0 space-y-0.5">
                    <div className="font-semibold text-ink">
                      {s.rule.item.icon ?? "📦"} {s.rule.item.name}
                      {need ? <span className="ml-1"><Pill tone="crit">below the least</Pill></span> : null}
                    </div>
                    <p>
                      In the warehouse {amount(s.onHand, s.rule.item.unit)}
                      {s.incoming > 0 ? ` · ${amount(s.incoming, s.rule.item.unit)} on its way` : ""}
                    </p>
                    <p>
                      Least {s.rule.min} → most {s.rule.max}
                      {need ? (
                        <>
                          {" · "}order <b className="text-ink">{amount(s.suggest, s.rule.item.unit)}</b>
                        </>
                      ) : null}
                    </p>
                    <p>{s.rule.supplier ? `From ${s.rule.supplier.name}` : <span className="text-crit">No supplier — choose one on the rule</span>}</p>
                  </div>
                </li>
              );
            })}
          </ul>
          <div className="hidden overflow-x-auto rounded-xl border border-edge bg-panel sm:block">
            <table className="w-full min-w-[34rem] text-left text-sm">
              <thead className="bg-sunken text-xs text-mut">
                <tr>
                  {canMove ? <th scope="col" className="w-10 px-2 py-2"><span className="sr-only">Order it</span></th> : null}
                  <th scope="col" className="px-2 py-2">Item</th>
                  <th scope="col" className="px-2 py-2 text-right">In the warehouse</th>
                  <th scope="col" className="px-2 py-2 text-right">On its way</th>
                  <th scope="col" className="px-2 py-2 text-right">Least → most</th>
                  <th scope="col" className="px-2 py-2 text-right">Order</th>
                  <th scope="col" className="px-2 py-2">From</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((s) => {
                  const need = s.suggest > 0;
                  return (
                    <tr key={s.rule.id} className={`border-t border-edge ${need ? "" : "text-mut"}`}>
                      {canMove ? <td className="px-2 py-2">{need && s.rule.supplier ? <Tick s={s} unticked={unticked} setUnticked={setUnticked} /> : null}</td> : null}
                      <td className="px-2 py-2 font-semibold">
                        {s.rule.item.icon ?? "📦"} {s.rule.item.name}
                        {need ? <span className="ml-1"><Pill tone="crit">below the least</Pill></span> : null}
                      </td>
                      <td className="px-2 py-2 text-right tabular-nums">{amount(s.onHand, s.rule.item.unit)}</td>
                      <td className="px-2 py-2 text-right tabular-nums">{s.incoming > 0 ? amount(s.incoming, s.rule.item.unit) : "—"}</td>
                      <td className="px-2 py-2 text-right tabular-nums">
                        {s.rule.min} → {s.rule.max}
                      </td>
                      <td className="px-2 py-2 text-right font-bold tabular-nums">{need ? amount(s.suggest, s.rule.item.unit) : "—"}</td>
                      <td className="px-2 py-2">{s.rule.supplier ? s.rule.supplier.name : <span className="text-crit">choose one on the rule</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
      {!hidden && canMove && short.length > 0 ? (
        <div className="space-y-1">
          <BigButton onClick={makeDrafts} busy={busy} disabled={groups.length === 0}>
            {groups.length === 0 ? "Tick what to order" : `Make ${groups.length === 1 ? "a delivery draft" : `${groups.length} delivery drafts`} (${groups.map((g) => g.supplier.name).join(", ")})`}
          </BigButton>
          <p className="text-xs text-mut">One draft per supplier, with the amounts above. Drafts add nothing to stock — change them in Deliveries before you order.</p>
        </div>
      ) : null}
      <Problem text={err} />
    </section>
  );
}

/** Order this row: ticked unless the person unticked it (rows that become short later start ticked too). */
function Tick({ s, unticked, setUnticked }: { s: Suggestion; unticked: Set<string>; setUnticked: (f: (t: Set<string>) => Set<string>) => void }) {
  return (
    <input
      type="checkbox"
      className="size-5 shrink-0"
      checked={!unticked.has(s.rule.id)}
      aria-label={`Order ${s.rule.item.name}`}
      onChange={(e) =>
        setUnticked((t) => {
          const n = new Set(t);
          if (e.target.checked) n.delete(s.rule.id);
          else n.add(s.rule.id);
          return n;
        })
      }
    />
  );
}

/** Topping a person up to their most: the suggested amounts, changeable, sent as one handover they confirm. */
function GiveOutSheet({ viewer, person, onDone, onClose }: { viewer: string; person: { employeeId: string; name: string; rows: Suggestion[] }; onDone: (msg: string) => void; onClose: () => void }) {
  const [id] = useState(newId);
  const [qty, setQty] = useState<Record<string, number>>(() => Object.fromEntries(person.rows.map((s) => [s.rule.item.id, s.suggest])));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const lines = person.rows.filter((s) => (qty[s.rule.item.id] ?? 0) > 0);
  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      await inv.handover(viewer, { id, from: { kind: "warehouse" }, to: { kind: "person", employeeId: person.employeeId }, lines: lines.map((s) => ({ itemId: s.rule.item.id, qty: qty[s.rule.item.id]! })) });
      onDone(`Sent to ${person.name} — it is theirs once they confirm it arrived.`);
    } catch (e) {
      setErr(errorText(e));
      setBusy(false);
    }
  };
  return (
    <Sheet title={`➡️ Give out to ${person.name}`} onClose={onClose} footer={<BigButton onClick={save} busy={busy} disabled={lines.length === 0}>Give out</BigButton>}>
      <p className="text-sm text-mut">What their rules suggest. Change an amount if you give less or more; {person.name} confirms what arrives.</p>
      <ul className="space-y-2">
        {person.rows.map((s) => (
          <li key={s.rule.id} className="space-y-2 rounded-xl border border-edge bg-panel p-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="font-semibold">
                <span aria-hidden className="mr-1 text-xl">{s.rule.item.icon ?? "📦"}</span>
                {s.rule.item.name}
              </span>
              <span className="text-sm text-mut">
                holds {amount(s.onHand, s.rule.item.unit)} · fill to {s.rule.max}
              </span>
            </div>
            <Stepper label={`${s.rule.item.name} for ${person.name}, in ${s.rule.item.unit}s`} value={qty[s.rule.item.id] ?? 0} onChange={(v) => setQty((x) => ({ ...x, [s.rule.item.id]: v }))} step={s.rule.item.step} />
          </li>
        ))}
      </ul>
      <Problem text={err} />
    </Sheet>
  );
}

/** One rule: an item, a place (the warehouse or a person), the least and the most, the pack, the supplier. */
function RuleSheet({ viewer, rule, items, suppliers, onDone, onClose }: { viewer: string; rule: ReorderRule | null; items: ItemNow[]; suppliers: Supplier[]; onDone: (msg: string) => void; onClose: () => void }) {
  const [itemId, setItemId] = useState(rule?.item.id ?? "");
  const [where, setWhere] = useState<"warehouse" | "person">(rule?.place.kind === "person" ? "person" : "warehouse");
  const [employeeId, setEmployeeId] = useState(rule?.place.employeeId ?? "");
  const [min, setMin] = useState(rule ? String(rule.min) : "");
  const [max, setMax] = useState(rule ? String(rule.max) : "");
  const [pack, setPack] = useState(rule && rule.multiple !== rule.item.step ? String(rule.multiple) : "");
  const [supplierId, setSupplierId] = useState(rule?.supplier?.id ?? "");
  const [active, setActive] = useState(rule?.active ?? true);
  const [holders, setHolders] = useState<Holder[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (where !== "person" || holders) return;
    inv.holders(viewer).then(
      (h) => setHolders(h.filter((x) => x.canReceive)),
      (e) => setErr(errorText(e)),
    );
  }, [where, holders, viewer]);
  const item = items.find((i) => i.id === itemId);
  const n = (t: string) => (t.trim() === "" ? Number.NaN : Number(t.replace(",", ".")));
  const ok = itemId !== "" && Number.isFinite(n(min)) && Number.isFinite(n(max)) && n(max) >= n(min) && (where === "warehouse" || employeeId !== "");
  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      await wh.saveRule(viewer, {
        ...(rule ? { id: rule.id } : {}),
        itemId,
        place: where === "warehouse" ? { kind: "warehouse" } : { kind: "person", employeeId },
        min: n(min),
        max: n(max),
        multiple: pack.trim() ? n(pack) : null,
        supplierId: where === "warehouse" && supplierId ? supplierId : null,
        active,
      });
      onDone(rule ? "Rule saved." : "Rule added.");
    } catch (e) {
      setErr(errorText(e));
      setBusy(false);
    }
  };
  return (
    <Sheet title={rule ? "What to keep" : "New rule"} onClose={onClose} footer={<BigButton onClick={save} busy={busy} disabled={!ok}>Save</BigButton>}>
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-semibold">Item</span>
        <select value={itemId} onChange={(e) => setItemId(e.target.value)} disabled={!!rule} className="h-12 rounded-xl border border-edge bg-sunken px-2">
          <option value="">Choose…</option>
          {items
            .filter((i) => i.active || i.id === itemId)
            .map((i) => (
              <option key={i.id} value={i.id}>
                {i.name} ({i.unit})
              </option>
            ))}
        </select>
      </label>
      <div>
        <p className="mb-1 text-sm font-semibold">Where</p>
        {rule ? (
          <p className="text-sm">{rule.place.kind === "warehouse" ? "In the warehouse" : `With ${rule.place.name}`} <span className="text-mut">— a rule keeps its item and place</span></p>
        ) : (
          <Chips
            options={[
              { value: "warehouse", label: "In the warehouse", icon: "🏬" },
              { value: "person", label: "With a person", icon: "🧑" },
            ]}
            value={where}
            onPick={setWhere}
          />
        )}
      </div>
      {where === "person" && !rule ? (
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-semibold">Who</span>
          <select value={employeeId} onChange={(e) => setEmployeeId(e.target.value)} className="h-12 rounded-xl border border-edge bg-sunken px-2">
            <option value="">{holders ? "Choose…" : "Loading…"}</option>
            {holders?.map((h) => (
              <option key={h.id} value={h.id}>
                {h.name}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <div className="grid grid-cols-2 gap-2">
        <TextField label={`Least to keep${item ? ` (${item.unit}s)` : ""}`} value={min} onChange={setMin} type="number" placeholder="e.g. 10" hint="Below this, it is listed to order" />
        <TextField label={`Fill up to${item ? ` (${item.unit}s)` : ""}`} value={max} onChange={setMax} type="number" placeholder="e.g. 30" hint="An order brings it back to this" />
      </div>
      <TextField label="Comes in packs of (optional)" value={pack} onChange={setPack} type="number" placeholder={item ? `e.g. ${item.step * 6}` : "e.g. 6"} hint="The suggestion is rounded up to whole packs" />
      {where === "warehouse" ? (
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-semibold">Usually ordered from (optional)</span>
          <select value={supplierId} onChange={(e) => setSupplierId(e.target.value)} className="h-12 rounded-xl border border-edge bg-sunken px-2">
            <option value="">No supplier</option>
            {suppliers
              .filter((s) => s.active || s.id === supplierId)
              .map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
          </select>
          <span className="text-xs text-mut">Needed to turn a suggestion into a delivery draft.</span>
        </label>
      ) : (
        <p className="text-xs text-mut">A person is filled up from the warehouse — the suggestion offers to give it out.</p>
      )}
      {Number.isFinite(n(min)) && Number.isFinite(n(max)) && n(max) < n(min) ? <p className="text-sm text-crit">“Fill up to” must be at least the least to keep.</p> : null}
      {rule ? (
        <label className="flex min-h-12 items-center gap-2 text-sm">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} className="size-5" /> On — untick to stop suggesting it
        </label>
      ) : null}
      <Problem text={err} />
    </Sheet>
  );
}
