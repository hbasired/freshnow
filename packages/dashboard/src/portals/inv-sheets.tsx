import { useEffect, useMemo, useState } from "react";
import { TextArea, TextField } from "../components/form";
import { REASON_WORDS, amount, inv, newId, type DocCard, type Held, type Holder, type ItemNow, type LineIn } from "../lib/inventory-api";
import { BigButton, Chips, ItemSteppers, PersonTiles, PhotoButton, Problem, Sheet, errorText, linesText, type PickItem } from "./inv-ui";

/**
 * The things a person does with stock (TASK-060), one sheet each. Every sheet makes its document's id
 * when it opens, so a double tap or a retry on a bad connection posts once (the server's rule).
 */

// The warehouse's figure is null while this person counts it: the item is offered without a limit, and
// the server still refuses more than there is.
const pickFrom = (items: readonly ItemNow[], key: "warehouse" | null): PickItem[] =>
  items
    .filter((i) => i.active)
    .map((i) => ({ id: i.id, name: i.name, unit: i.unit, step: i.step, icon: i.icon, ...(key && i.warehouse !== null ? { available: i.warehouse } : {}) }));

const inStock = (p: PickItem) => p.available === undefined || p.available > 0;

const linesOf = (values: Record<string, number>): LineIn[] => Object.entries(values).filter(([, q]) => q > 0).map(([itemId, qty]) => ({ itemId, qty }));

/**
 * The amounts chosen on a sheet, and the lines to send: only items still on its list. An item that
 * dropped off it when the screen refreshed (someone else handed out the rest meanwhile, say) is named,
 * never sent unseen (TASK-060 review).
 */
function useChosen(pick: readonly PickItem[]) {
  const [values, setValues] = useState<Record<string, number>>({});
  const [names, setNames] = useState<Record<string, string>>({});
  const set = (id: string, v: number) => {
    setValues((x) => ({ ...x, [id]: v }));
    const name = pick.find((p) => p.id === id)?.name;
    if (name) setNames((x) => (x[id] === name ? x : { ...x, [id]: name }));
  };
  const on = new Set(pick.map((p) => p.id));
  const all = linesOf(values);
  return {
    values,
    setValues,
    set,
    lines: all.filter((l) => on.has(l.itemId)),
    dropped: all.filter((l) => !on.has(l.itemId)).map((l) => names[l.itemId] ?? "An item"),
  };
}

function Dropped({ names, why = "there is none of it left to take from" }: { names: string[]; why?: string }) {
  if (names.length === 0) return null;
  return (
    <p className="mt-2 rounded-xl border border-warn/40 bg-warn/10 p-3 text-sm">
      Taken off the list — {why}: {names.join(", ")}.
    </p>
  );
}

// ── a delivery ───────────────────────────────────────────────────────────────
export function ReceiveSheet({
  viewer,
  items,
  expected = [],
  onPickExpected,
  onDone,
  onClose,
}: {
  viewer: string;
  items: ItemNow[];
  /** Deliveries marked expected (TASK-086): one of them arriving is received there, against what was ordered — not typed again here. */
  expected?: { id: string; label: string }[];
  onPickExpected?: (id: string) => void;
  onDone: (msg: string) => void;
  onClose: () => void;
}) {
  const [id] = useState(newId);
  // Only the items still on the list are sent: one switched off while the sheet is open is said, not sent unseen (review, 20 Oct).
  const { values, set, lines, dropped } = useChosen(pickFrom(items, null));
  const [supplier, setSupplier] = useState("");
  const [invoice, setInvoice] = useState("");
  const [variety, setVariety] = useState("");
  const [cartonKg, setCartonKg] = useState("");
  const [note, setNote] = useState("");
  const [photos, setPhotos] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const oranges = new Set(items.filter((i) => i.category === "oranges").map((i) => i.id));
  const hasOranges = lines.some((l) => oranges.has(l.itemId));
  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      const kg = Number(cartonKg.replace(",", "."));
      const withLot = lines.map((l) =>
        oranges.has(l.itemId) ? { ...l, ...(variety.trim() ? { variety: variety.trim() } : {}), ...(kg > 0 ? { cartonKg: kg } : {}) } : l,
      );
      await inv.receive(viewer, {
        id,
        lines: withLot,
        ...(supplier.trim() ? { supplier: supplier.trim() } : {}),
        ...(invoice.trim() ? { invoiceNo: invoice.trim() } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
        ...(photos.length ? { mediaIds: photos } : {}),
      });
      onDone("Delivery recorded — it is in the warehouse now.");
    } catch (e) {
      setErr(errorText(e));
      setBusy(false);
    }
  };
  return (
    <Sheet title="📦 Delivery in" onClose={onClose} footer={<BigButton onClick={save} busy={busy} disabled={lines.length === 0}>Save delivery{lines.length ? ` (${lines.length} item${lines.length === 1 ? "" : "s"})` : ""}</BigButton>}>
      {expected.length > 0 && onPickExpected ? (
        <div className="space-y-2 rounded-xl border border-warn/50 bg-warn/10 p-3">
          <p className="text-sm font-semibold">Is it one of these expected deliveries? Receive it there instead — it is checked against what was ordered and gets its lot number.</p>
          {expected.map((e) => (
            <button key={e.id} onClick={() => onPickExpected(e.id)} className="block min-h-11 w-full rounded-xl border border-edge bg-panel px-3 py-2 text-left text-sm font-semibold hover:border-link">
              📦 {e.label} →
            </button>
          ))}
        </div>
      ) : null}
      <p className="text-sm text-mut">What arrived, as you counted it. It goes into the warehouse straight away.</p>
      <ItemSteppers items={pickFrom(items, null)} values={values} onChange={set} />
      <Dropped names={dropped} why="it is no longer in use" />
      {hasOranges ? (
        <div className="grid grid-cols-2 gap-2">
          <TextField label="Orange variety (on the carton)" value={variety} onChange={setVariety} placeholder="e.g. LALA" maxLength={40} />
          <TextField label="One carton weighs (kg)" value={cartonKg} onChange={setCartonKg} placeholder="e.g. 17.15" type="number" />
        </div>
      ) : null}
      <div className="grid grid-cols-2 gap-2">
        <TextField label="Supplier" value={supplier} onChange={setSupplier} maxLength={80} />
        <TextField label="Invoice number" value={invoice} onChange={setInvoice} maxLength={40} />
      </div>
      <PhotoButton viewer={viewer} retention="receipt" ids={photos} onChange={setPhotos} />
      <TextArea label="Note (optional)" value={note} onChange={setNote} rows={2} maxLength={500} />
      <Problem text={err} />
    </Sheet>
  );
}

// ── handovers ────────────────────────────────────────────────────────────────
export type GiveMode = "out" | "takeback" | "back" | "person";

const GIVE_TITLE: Record<GiveMode, string> = {
  out: "➡️ Give out",
  takeback: "⬅️ Take back",
  back: "↩️ Give back to the warehouse",
  person: "🤝 Hand to someone",
};

/**
 * out       warehouse → a person (who confirms on their phone)
 * takeback  a person → warehouse, recorded at the desk (the person confirms)
 * back      my stock → warehouse (someone at the warehouse confirms)
 * person    my stock → another person (they confirm)
 */
export function GiveSheet({
  viewer,
  me,
  mode,
  items,
  mine,
  onDone,
  onClose,
}: {
  viewer: string;
  me: string;
  mode: GiveMode;
  items: ItemNow[];
  mine: Held[];
  onDone: (msg: string) => void;
  onClose: () => void;
}) {
  const [id] = useState(newId);
  const [people, setPeople] = useState<Holder[] | null>(mode === "back" ? [] : null);
  const [who, setWho] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (mode === "back") return;
    inv.holders(viewer).then((h) => setPeople(h.filter((p) => p.id !== me)), (e) => setErr(errorText(e)));
  }, [viewer, me, mode]);

  const byId = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);
  const pick: PickItem[] = useMemo(() => {
    if (mode === "out") return pickFrom(items, "warehouse").filter(inStock);
    if (mode === "takeback") {
      const holds = people?.find((p) => p.id === who)?.holds ?? [];
      return holds
        .filter((h) => h.qty > 0)
        .map((h) => {
          const it = byId.get(h.itemId);
          return { id: h.itemId, name: it?.name ?? "Item", unit: it?.unit ?? "", step: it?.step ?? 1, icon: it?.icon ?? null, available: h.qty };
        });
    }
    return mine.filter((m) => m.qty > 0).map((m) => ({ id: m.itemId, name: m.name, unit: m.unit, step: m.step, icon: m.icon, available: m.qty }));
  }, [mode, items, people, who, mine, byId]);

  const { values, setValues, set, lines, dropped } = useChosen(pick);

  // Taking back: start from everything the person holds — usually all of it comes back. Only when the
  // person is chosen: the screen refreshing must not undo amounts the keeper lowered (TASK-060 review).
  useEffect(() => {
    if (mode !== "takeback") return;
    const holds = people?.find((p) => p.id === who)?.holds ?? [];
    setValues(Object.fromEntries(holds.filter((h) => h.qty > 0).map((h) => [h.itemId, h.qty])));
  }, [mode, who, people, setValues]);

  const needsPerson = mode !== "back";
  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      const from = mode === "out" ? { kind: "warehouse" as const } : mode === "takeback" ? { kind: "person" as const, employeeId: who! } : { kind: "person" as const, employeeId: me };
      const to = mode === "out" || mode === "person" ? { kind: "person" as const, employeeId: who! } : { kind: "warehouse" as const };
      await inv.handover(viewer, { id, from, to, lines, ...(note.trim() ? { note: note.trim() } : {}) });
      const person = people?.find((p) => p.id === who);
      const name = person?.name ?? "the warehouse";
      // Someone who cannot confirm (left, or their role changed): someone else at the warehouse does.
      onDone(
        mode === "back" || (mode === "takeback" && person && !person.canReceive)
          ? "Sent — someone else at the warehouse confirms what arrived."
          : `Sent — ${name} confirms on their phone.`,
      );
    } catch (e) {
      setErr(errorText(e));
      setBusy(false);
    }
  };
  const ready = lines.length > 0 && (!needsPerson || who !== null);
  return (
    <Sheet
      title={GIVE_TITLE[mode]}
      onClose={onClose}
      footer={<BigButton onClick={save} busy={busy} disabled={!ready}>{needsPerson && !who ? "Choose who" : lines.length === 0 ? "Choose what" : "Send — they confirm"}</BigButton>}
    >
      {needsPerson ? (
        <section>
          <h4 className="mb-2 font-semibold">{mode === "takeback" ? "From whom?" : "To whom?"}</h4>
          {people === null ? (
            <p className="text-sm text-mut">Loading…</p>
          ) : (
            // Taking back: everyone who holds stock — someone who left too. Giving: only those who can receive it.
            <PersonTiles people={mode === "takeback" ? people.filter((p) => p.holds.length > 0) : people.filter((p) => p.canReceive)} value={who} onPick={setWho} />
          )}
        </section>
      ) : null}
      {!needsPerson || who ? (
        <section>
          <h4 className="mb-2 font-semibold">What?</h4>
          <ItemSteppers items={pick} values={values} onChange={set} />
          <Dropped names={dropped} />
        </section>
      ) : null}
      <p className="text-sm text-mut">
        {mode === "out"
          ? "It leaves the warehouse now and is theirs once they accept it on their phone."
          : mode === "takeback"
            ? people?.find((p) => p.id === who)?.canReceive === false
              ? "They cannot confirm it any more: it is back in the warehouse once someone else at the warehouse confirms what arrived."
              : "It is back in the warehouse once they confirm it on their phone."
            : "It is the other side's once they confirm it."}
      </p>
      <TextArea label="Note (optional)" value={note} onChange={setNote} rows={2} maxLength={500} />
      <Problem text={err} />
    </Sheet>
  );
}

// ── used and damaged ─────────────────────────────────────────────────────────
const USE_OPTIONS = [
  { value: "machine_refill", label: "Into a machine", icon: "🥤" },
  { value: "shift_use", label: "Used on the round", icon: "🚐" },
  { value: "cleaning", label: "Cleaning", icon: "🧽" },
  { value: "repair", label: "A repair", icon: "🔧" },
  { value: "other", label: "Other", icon: "✏️" },
];
const DAMAGE_OPTIONS = [
  { value: "spoiled", label: "Spoiled", icon: "🍂" },
  { value: "broken", label: "Broken", icon: "💥" },
  { value: "expired", label: "Expired", icon: "⌛" },
  { value: "sorting_waste", label: "Sorted out", icon: "🗑️" },
  { value: "other", label: "Other", icon: "✏️" },
];

export function UseSheet({
  viewer,
  kind,
  from,
  items,
  mine,
  onDone,
  onClose,
}: {
  viewer: string;
  kind: "use" | "damage";
  from: "warehouse" | "mine";
  items: ItemNow[];
  mine: Held[];
  onDone: (msg: string) => void;
  onClose: () => void;
}) {
  const [id] = useState(newId);
  const [reason, setReason] = useState<string | null>(null);
  const [machine, setMachine] = useState("");
  const [note, setNote] = useState("");
  const [photos, setPhotos] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const pick: PickItem[] =
    from === "warehouse"
      ? pickFrom(items, "warehouse").filter(inStock)
      : mine.filter((m) => m.qty > 0).map((m) => ({ id: m.itemId, name: m.name, unit: m.unit, step: m.step, icon: m.icon, available: m.qty }));
  const { values, set, lines, dropped } = useChosen(pick);
  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      const asset = Number(machine);
      await inv.use(viewer, {
        id,
        kind,
        from,
        reason: reason!,
        lines,
        ...(reason === "machine_refill" && Number.isInteger(asset) && asset > 0 ? { machineAssetNo: asset } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
        ...(photos.length ? { mediaIds: photos } : {}),
      });
      onDone(kind === "use" ? "Recorded as used." : "Recorded as damaged.");
    } catch (e) {
      setErr(errorText(e));
      setBusy(false);
    }
  };
  return (
    <Sheet
      title={kind === "use" ? "🧴 Used" : "🗑️ Damaged"}
      onClose={onClose}
      footer={<BigButton onClick={save} busy={busy} disabled={!reason || lines.length === 0 || (reason === "other" && !note.trim())}>Save</BigButton>}
    >
      <p className="text-sm text-mut">{from === "warehouse" ? "From the warehouse." : "From what you hold."}</p>
      <section>
        <h4 className="mb-2 font-semibold">Why?</h4>
        <Chips options={kind === "use" ? USE_OPTIONS : DAMAGE_OPTIONS} value={reason} onPick={setReason} />
      </section>
      {reason === "machine_refill" ? <TextField label="Machine number (on its sticker)" value={machine} onChange={setMachine} type="number" placeholder="e.g. 401" /> : null}
      <section>
        <h4 className="mb-2 font-semibold">What?</h4>
        <ItemSteppers items={pick} values={values} onChange={set} />
        <Dropped names={dropped} />
      </section>
      {kind === "damage" ? <PhotoButton viewer={viewer} retention="evidence" ids={photos} onChange={setPhotos} /> : null}
      <TextArea label={reason === "other" ? "What happened? (needed)" : "Note (optional)"} value={note} onChange={setNote} rows={2} maxLength={500} />
      <Problem text={err} />
    </Sheet>
  );
}

// ── answering a handover ─────────────────────────────────────────────────────
const REFUSE_OPTIONS = [
  { value: "wrong_count", label: "Different count", icon: "🔢" },
  { value: "not_received", label: "Did not arrive", icon: "❓" },
  { value: "damaged", label: "Damaged", icon: "💥" },
  { value: "wrong_items", label: "Wrong items", icon: "🔀" },
  { value: "other", label: "Other", icon: "✏️" },
];

/** "Something is different": type what arrived — or refuse the lot. */
export function AnswerSheet({ viewer, doc, onDone, onClose }: { viewer: string; doc: DocCard; onDone: (msg: string) => void; onClose: () => void }) {
  const [values, setValues] = useState<Record<string, number>>(() => Object.fromEntries(doc.lines.map((l) => [l.itemId, l.pending ?? l.qty])));
  const [reason, setReason] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<"counted" | "refuse" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // Each line carries its step: a driver's screen has no catalogue to look it up in.
  const pick: PickItem[] = doc.lines.map((l) => ({ id: l.itemId, name: l.name, unit: l.unit, step: l.step, icon: l.icon, available: l.pending ?? l.qty }));
  const send = async (answer: "counted" | "refuse") => {
    setBusy(answer);
    setErr(null);
    try {
      await inv.answer(viewer, doc.id, {
        answer,
        ...(answer === "counted" ? { lines: doc.lines.map((l) => ({ itemId: l.itemId, qty: values[l.itemId] ?? 0 })) } : {}),
        ...(reason ? { reason } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      onDone(answer === "refuse" ? "Refused — it goes back." : "Saved — what you counted is yours; the rest waits for the Ops Head.");
    } catch (e) {
      setErr(errorText(e));
      setBusy(null);
    }
  };
  return (
    <Sheet
      title="Something is different"
      onClose={onClose}
      footer={
        <div className="grid gap-2">
          <BigButton onClick={() => send("counted")} busy={busy === "counted"} disabled={!reason || busy !== null}>
            Accept what I counted
          </BigButton>
          <BigButton tone="stop" onClick={() => send("refuse")} busy={busy === "refuse"} disabled={!reason || busy !== null}>
            Refuse it all
          </BigButton>
        </div>
      }
    >
      <p className="text-sm text-mut">
        {doc.from.employeeId && doc.from.employeeId !== doc.createdBy.id ? `${doc.createdBy.name} took back ${doc.from.name}'s stock` : `From ${doc.createdBy.name}`}:{" "}
        {linesText(doc.lines.map((l) => ({ ...l, qty: l.pending ?? l.qty })))}
      </p>
      <section>
        <h4 className="mb-2 font-semibold">What arrived?</h4>
        <ItemSteppers items={pick} values={values} onChange={(i, v) => setValues((x) => ({ ...x, [i]: v }))} />
      </section>
      <section>
        <h4 className="mb-2 font-semibold">Why?</h4>
        <Chips options={REFUSE_OPTIONS} value={reason} onPick={setReason} />
      </section>
      <TextArea label="Note (optional)" value={note} onChange={setNote} rows={2} maxLength={500} />
      <Problem text={err} />
    </Sheet>
  );
}

// ── settling what is still in transit ────────────────────────────────────────
export function SettleSheet({ viewer, doc, onDone, onClose }: { viewer: string; doc: DocCard; onDone: (msg: string) => void; onClose: () => void }) {
  const open = doc.lines.filter((l) => (l.pending ?? 0) > 0);
  const [outcome, setOutcome] = useState<Record<string, "back" | "write_off">>({});
  const [why, setWhy] = useState<Record<string, string>>({});
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const ready = open.every((l) => outcome[l.itemId] === "back" || (outcome[l.itemId] === "write_off" && why[l.itemId]));
  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      await inv.settle(viewer, doc.id, {
        lines: open.map((l) => ({ itemId: l.itemId, outcome: outcome[l.itemId]!, ...(outcome[l.itemId] === "write_off" ? { reason: why[l.itemId]! } : {}) })),
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      onDone("Settled.");
    } catch (e) {
      setErr(errorText(e));
      setBusy(false);
    }
  };
  return (
    <Sheet title="Settle a handover" onClose={onClose} footer={<BigButton onClick={save} busy={busy} disabled={!ready}>Settle</BigButton>}>
      <p className="text-sm text-mut">
        {doc.createdBy.name} sent {linesText(doc.lines)}; {doc.answeredBy?.name ?? "the receiver"} counted less
        {doc.answerReason ? ` (${REASON_WORDS[doc.answerReason] ?? doc.answerReason})` : ""}.{doc.answerNote ? ` “${doc.answerNote}”` : ""}
      </p>
      {open.map((l) => (
        <section key={l.itemId} className="space-y-2 rounded-xl border border-edge bg-panel p-3">
          <div className="font-semibold">
            {l.icon} {amount(l.pending ?? 0, l.unit)} {l.name} — still in transit
          </div>
          <Chips
            options={[
              { value: "back", label: `Back to ${doc.from.name}`, icon: "↩️" },
              { value: "write_off", label: "Write off", icon: "✖️" },
            ]}
            value={outcome[l.itemId] ?? null}
            onPick={(v) => setOutcome((x) => ({ ...x, [l.itemId]: v as "back" | "write_off" }))}
          />
          {outcome[l.itemId] === "write_off" ? (
            <Chips
              options={[
                { value: "damaged_unrecorded", label: "Damaged, not recorded" },
                { value: "unexplained", label: "No explanation yet" },
              ]}
              value={why[l.itemId] ?? null}
              onPick={(v) => setWhy((x) => ({ ...x, [l.itemId]: v }))}
            />
          ) : null}
        </section>
      ))}
      <TextArea label="Note (optional)" value={note} onChange={setNote} rows={2} maxLength={500} />
      <Problem text={err} />
    </Sheet>
  );
}

// ── reversing a mistake ──────────────────────────────────────────────────────
export function ReverseSheet({ viewer, doc, onDone, onClose }: { viewer: string; doc: DocCard; onDone: (msg: string) => void; onClose: () => void }) {
  const [id] = useState(newId);
  const [reason, setReason] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      await inv.reverse(viewer, doc.id, { id, reason: reason!, ...(note.trim() ? { note: note.trim() } : {}) });
      onDone("Reversed — the original stays in the list, marked reversed.");
    } catch (e) {
      setErr(errorText(e));
      setBusy(false);
    }
  };
  return (
    <Sheet title="Reverse a mistake" onClose={onClose} footer={<BigButton tone="stop" onClick={save} busy={busy} disabled={!reason || (reason === "other" && !note.trim())}>Reverse it</BigButton>}>
      <p className="text-sm text-mut">The opposite moves are added; nothing is deleted. {linesText(doc.lines)}</p>
      <Chips
        options={[
          { value: "entered_by_mistake", label: "Entered by mistake" },
          { value: "wrong_quantity", label: "Wrong amount" },
          { value: "wrong_item", label: "Wrong item" },
          { value: "duplicate", label: "Entered twice" },
          { value: "other", label: "Other" },
        ]}
        value={reason}
        onPick={setReason}
      />
      <TextArea label={reason === "other" ? "What was wrong? (needed)" : "Note (optional)"} value={note} onChange={setNote} rows={2} maxLength={500} />
      <Problem text={err} />
    </Sheet>
  );
}
