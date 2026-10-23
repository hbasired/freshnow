import { useEffect, useState } from "react";
import { Card, Empty, Pill, Spinner } from "../components/ui";
import { Select, TextField } from "../components/form";
import { inv, units, type CatalogueItem, type InventoryAbilities } from "../lib/inventory-api";
import { BigButton, Problem, Sheet, errorText } from "./inv-ui";

/**
 * The items the warehouse keeps (TASK-060). The keeper adds and names them, sets each one's unit, its
 * smallest step and its minimum (below which the warehouse is low); the Ops Head, the CEO or an Admin
 * sets the count tolerance. An item's unit and step are fixed from its first movement.
 */

const CATEGORIES = [
  { value: "oranges", label: "🍊 Oranges" },
  { value: "cups_packaging", label: "🥤 Cups and packaging" },
  { value: "consumable", label: "🧤 Consumables" },
  { value: "cleaning", label: "🧴 Cleaning" },
  { value: "spare_part", label: "🔧 Spare parts" },
  { value: "vehicle", label: "🚐 Vehicle" },
  { value: "device", label: "📱 Company phones" },
  { value: "other", label: "📦 Other" },
];

export default function ItemsView({ viewer, can }: { viewer: string; can: InventoryAbilities }) {
  const [items, setItems] = useState<CatalogueItem[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [edit, setEdit] = useState<CatalogueItem | "new" | null>(null);
  const load = () => inv.items(viewer).then(setItems, (e) => setErr(errorText(e)));
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reload when the viewer changes
  }, [viewer]);
  return (
    <div className="space-y-3">
      {can.move ? <BigButton tone="quiet" onClick={() => setEdit("new")}>＋ Add an item</BigButton> : null}
      {err ? <Empty>{err}</Empty> : null}
      {!items && !err ? <Spinner label="Loading items…" /> : null}
      <ul className="grid gap-2 sm:grid-cols-2">
        {items?.map((i) => (
          <li key={i.id}>
            <Card className={`flex items-center justify-between gap-2 ${i.active ? "" : "opacity-60"}`}>
              <div className="min-w-0">
                <div className="truncate font-semibold">
                  <span aria-hidden className="mr-1 text-xl">{i.icon ?? "📦"}</span>
                  {i.name}
                </div>
                <div className="text-xs text-mut">
                  in {units(i.unit)} · step {i.step} · minimum {i.minLevel ?? "not set"} · tolerance {i.countTolerance}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {!i.active ? <Pill>not in use</Pill> : null}
                {can.move ? (
                  <button onClick={() => setEdit(i)} className="min-h-11 rounded-lg border border-edge bg-sunken px-3 text-sm font-semibold">
                    Edit
                  </button>
                ) : null}
              </div>
            </Card>
          </li>
        ))}
      </ul>
      {edit ? <ItemSheet viewer={viewer} item={edit === "new" ? null : edit} canTolerance={can.approve} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); void load(); }} /> : null}
    </div>
  );
}

function ItemSheet({ viewer, item, canTolerance, onClose, onSaved }: { viewer: string; item: CatalogueItem | null; canTolerance: boolean; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(item?.name ?? "");
  const [category, setCategory] = useState(item?.category ?? "consumable");
  const [unit, setUnit] = useState(item?.unit ?? "box");
  const [step, setStep] = useState(String(item?.step ?? 1));
  const [min, setMin] = useState(item?.minLevel === null || item?.minLevel === undefined ? "" : String(item.minLevel));
  const [tol, setTol] = useState(String(item?.countTolerance ?? 0));
  const [icon, setIcon] = useState(item?.icon ?? "");
  const [active, setActive] = useState(item?.active ?? true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const fixed = item?.hasMoved === true;
  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      await inv.saveItem(viewer, {
        ...(item ? { id: item.id } : {}),
        name: name.trim(),
        category,
        unit: unit.trim(),
        step: Number(step),
        minLevel: min.trim() === "" ? null : Number(min),
        ...(canTolerance ? { countTolerance: Number(tol) } : {}),
        icon: icon.trim() || null,
        active,
      });
      onSaved();
    } catch (e) {
      setErr(errorText(e));
      setBusy(false);
    }
  };
  return (
    <Sheet title={item ? `Edit ${item.name}` : "Add an item"} onClose={onClose} footer={<BigButton onClick={save} busy={busy} disabled={!name.trim() || !unit.trim() || !(Number(step) > 0)}>Save</BigButton>}>
      <TextField label="Name" value={name} onChange={setName} maxLength={60} />
      <Select label="Kind" value={category} onChange={setCategory} options={CATEGORIES} />
      <div className="grid grid-cols-2 gap-2">
        <TextField label="Counted in" value={unit} onChange={setUnit} placeholder="carton, box, piece" maxLength={20} disabled={fixed} {...(fixed ? { hint: "Fixed: it has moved." } : {})} />
        <TextField label="Smallest step" value={step} onChange={setStep} type="number" disabled={fixed} hint={fixed ? "Fixed: it has moved." : "1, or 0.5 for half a box"} />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <TextField label="Low below" value={min} onChange={setMin} type="number" hint="Empty: no alert" />
        <TextField label="Count tolerance" value={tol} onChange={setTol} type="number" disabled={!canTolerance} hint={canTolerance ? "A count this close skips the recount" : "Set by the Ops Head"} />
      </div>
      <TextField label="Icon (an emoji)" value={icon} onChange={setIcon} maxLength={8} placeholder="🍊" />
      {item ? (
        <label className="flex min-h-12 items-center gap-3 rounded-xl border border-edge bg-panel px-3">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} className="size-5" />
          <span className="font-semibold">In use</span>
        </label>
      ) : null}
      <Problem text={err} />
    </Sheet>
  );
}
