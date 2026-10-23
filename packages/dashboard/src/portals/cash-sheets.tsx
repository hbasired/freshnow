import { useEffect, useId, useState } from "react";
import { TextArea, TextField } from "../components/form";
import { newId } from "../lib/inventory-api";
import { AED_NOTES, CASH_REVERSE_WORDS, ENTRY_WORDS, aed, cash, filsOf, type CashEntry, type CashMachine, type ShiftDetail } from "../lib/cash-api";
import { BigButton, Chips, PhotoButton, Problem, Sheet, Stepper, errorText, hhmm, when } from "./inv-ui";

/**
 * The things a person does with cash (TASK-061), one sheet each — made for a phone held in one hand.
 * Every sheet makes its entry's id when it opens, so a double tap or a retry on a bad connection posts
 * once (the server's rule). Amounts are typed in AED and sent in fils.
 */

/** The machine, by the number on its sticker — its name shown as soon as the number is known. */
function MachineField({ viewer, value, onChange }: { viewer: string; value: string; onChange: (v: string) => void }) {
  const [machines, setMachines] = useState<CashMachine[]>([]);
  useEffect(() => {
    cash.machines(viewer).then(setMachines, () => setMachines([]));
  }, [viewer]);
  const n = Number(value);
  const known = machines.find((m) => m.assetNo === n);
  return (
    <div>
      <label className="mb-1 block text-sm font-semibold" htmlFor="cash-machine">
        Machine number (on its sticker)
      </label>
      <input
        id="cash-machine"
        inputMode="numeric"
        list="cash-machines"
        value={value}
        onChange={(e) => onChange(e.target.value.replace(/\D/g, "").slice(0, 5))}
        placeholder="e.g. 793"
        className="h-12 w-full rounded-xl border border-edge bg-sunken px-3 text-xl font-bold tabular-nums"
      />
      <datalist id="cash-machines">
        {machines.map((m) => (
          <option key={m.assetNo} value={m.assetNo}>
            {m.label}
          </option>
        ))}
      </datalist>
      <p className={`mt-1 text-sm ${value && !known && machines.length > 0 ? "text-crit" : "text-mut"}`}>
        {known ? `✓ ${known.label}` : value && machines.length > 0 ? "No machine with this number." : " "}
      </p>
    </div>
  );
}

/** An amount in AED, typed on the phone's number pad. */
function AmountField({ label, value, onChange, autoFocus }: { label: string; value: string; onChange: (v: string) => void; autoFocus?: boolean }) {
  const id = useId();
  return (
    <div>
      <label className="mb-1 block text-sm font-semibold" htmlFor={id}>
        {label}
      </label>
      <div className="flex items-center gap-2">
        <span className="text-lg font-bold text-mut">AED</span>
        <input
          id={id}
          inputMode="decimal"
          value={value}
          autoFocus={autoFocus}
          onChange={(e) => {
            const t = e.target.value;
            if (/^\d{0,7}([.,]\d{0,2})?$/.test(t)) onChange(t);
          }}
          placeholder="0"
          className="h-14 w-full rounded-xl border border-edge bg-sunken px-3 text-2xl font-extrabold tabular-nums"
        />
      </div>
    </div>
  );
}

function Holding({ heldFils }: { heldFils: number }) {
  return <p className="text-sm text-mut">You hold {aed(heldFils)} now.</p>;
}

// ── collected ────────────────────────────────────────────────────────────────
export function CollectSheet({ viewer, onDone, onClose }: { viewer: string; onDone: (msg: string) => void; onClose: () => void }) {
  const [id] = useState(newId);
  const [machine, setMachine] = useState("");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [photos, setPhotos] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const fils = filsOf(amount);
  const asset = Number(machine);
  const ready = Number.isInteger(asset) && asset > 0 && fils !== null && photos.length > 0;
  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      await cash.collect(viewer, { id, machineAssetNo: asset, amountFils: fils!, mediaIds: photos, ...(note.trim() ? { note: note.trim() } : {}) });
      onDone(`Recorded: ${aed(fils!)} from machine ${asset}.`);
    } catch (e) {
      setErr(errorText(e));
      setBusy(false);
    }
  };
  return (
    <Sheet
      title="🏧 Cash collected"
      onClose={onClose}
      footer={
        <BigButton onClick={save} busy={busy} disabled={!ready}>
          {photos.length === 0 && fils !== null ? "Add the photo first" : "Save"}
        </BigButton>
      }
    >
      <p className="text-sm text-mut">What you took out of the machine's cash box, as you counted it — 0 if it was empty.</p>
      <MachineField viewer={viewer} value={machine} onChange={setMachine} />
      <AmountField label="Collected" value={amount} onChange={setAmount} />
      <PhotoButton viewer={viewer} retention="evidence" ids={photos} onChange={setPhotos} />
      <TextArea label="Note (optional)" value={note} onChange={setNote} rows={2} maxLength={500} />
      <Problem text={err} />
    </Sheet>
  );
}

// ── a test note ──────────────────────────────────────────────────────────────
export function TestNoteSheet({ viewer, heldFils, onDone, onClose }: { viewer: string; heldFils: number; onDone: (msg: string) => void; onClose: () => void }) {
  const [id] = useState(newId);
  const [machine, setMachine] = useState("");
  const [amount, setAmount] = useState("10");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const fils = filsOf(amount);
  const asset = Number(machine);
  const ready = Number.isInteger(asset) && asset > 0 && fils !== null && fils > 0;
  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      await cash.testVend(viewer, { id, machineAssetNo: asset, amountFils: fils!, ...(note.trim() ? { note: note.trim() } : {}) });
      onDone(`Recorded: a ${aed(fils!)} note put into machine ${asset} to test it.`);
    } catch (e) {
      setErr(errorText(e));
      setBusy(false);
    }
  };
  return (
    <Sheet title="🔟 Test note" onClose={onClose} footer={<BigButton onClick={save} busy={busy} disabled={!ready}>Save</BigButton>}>
      <p className="text-sm text-mut">A note from your cash put into a machine to test it, or to try a juice. It goes back into its cash box.</p>
      <Holding heldFils={heldFils} />
      <MachineField viewer={viewer} value={machine} onChange={setMachine} />
      <AmountField label="Put in" value={amount} onChange={setAmount} />
      <TextField label="Why (optional)" value={note} onChange={setNote} placeholder="e.g. note acceptor test" maxLength={500} />
      <Problem text={err} />
    </Sheet>
  );
}

// ── spent ────────────────────────────────────────────────────────────────────
export function ExpenseSheet({ viewer, kind, heldFils, onDone, onClose }: { viewer: string; kind: "fuel" | "other"; heldFils: number; onDone: (msg: string) => void; onClose: () => void }) {
  const [id] = useState(newId);
  const [amount, setAmount] = useState("");
  const [litres, setLitres] = useState("");
  const [note, setNote] = useState("");
  const [photos, setPhotos] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const fils = filsOf(amount);
  const l = Number(litres.replace(",", "."));
  const ready = fils !== null && fils > 0 && photos.length > 0 && (kind === "fuel" || note.trim().length > 0);
  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      await cash.expense(viewer, {
        id,
        expenseKind: kind,
        amountFils: fils!,
        mediaIds: photos,
        ...(kind === "fuel" && l > 0 ? { litres: Math.round(l * 100) / 100 } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      onDone(`Recorded: ${aed(fils!)} ${kind === "fuel" ? "for fuel" : `for ${note.trim()}`}.`);
    } catch (e) {
      setErr(errorText(e));
      setBusy(false);
    }
  };
  return (
    <Sheet
      title={kind === "fuel" ? "⛽ Fuel" : "🧾 Other expense"}
      onClose={onClose}
      footer={
        <BigButton onClick={save} busy={busy} disabled={!ready}>
          {photos.length === 0 && fils ? "Add the receipt's photo first" : "Save"}
        </BigButton>
      }
    >
      <p className="text-sm text-mut">Paid from the cash you hold — with a photo of the receipt.</p>
      <Holding heldFils={heldFils} />
      <AmountField label="Paid" value={amount} onChange={setAmount} />
      {kind === "fuel" ? (
        <TextField label="Litres (optional, as on the receipt)" value={litres} onChange={(v) => /^\d{0,3}([.,]\d{0,2})?$/.test(v) && setLitres(v)} placeholder="e.g. 55.5" />
      ) : (
        <TextField label="What for? (needed)" value={note} onChange={setNote} placeholder="e.g. a tyre" maxLength={500} />
      )}
      <PhotoButton viewer={viewer} retention="receipt" ids={photos} onChange={setPhotos} />
      {kind === "fuel" ? <TextArea label="Note (optional)" value={note} onChange={setNote} rows={2} maxLength={500} /> : null}
      <Problem text={err} />
    </Sheet>
  );
}

// ── deposited ────────────────────────────────────────────────────────────────
export function DepositSheet({ viewer, heldFils, onDone, onClose }: { viewer: string; heldFils: number; onDone: (msg: string) => void; onClose: () => void }) {
  const [id] = useState(newId);
  const [notes, setNotes] = useState<Record<string, number | null>>({});
  const [amount, setAmount] = useState("");
  const [txn, setTxn] = useState("");
  const [operator, setOperator] = useState("");
  const [cds, setCds] = useState("");
  const [bag, setBag] = useState("");
  const [photos, setPhotos] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // The receipt lists the notes; when they are entered, the amount is their total — typed otherwise.
  const counted = Object.entries(notes).filter(([, n]) => (n ?? 0) > 0);
  const notesFils = counted.reduce((t, [face, n]) => t + Number(face) * 100 * (n ?? 0), 0);
  const fils = counted.length > 0 ? notesFils : filsOf(amount);
  const ready = fils !== null && fils > 0 && photos.length > 0;
  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      await cash.deposit(viewer, {
        id,
        amountFils: fils!,
        mediaIds: photos,
        ...(counted.length > 0 ? { denominations: Object.fromEntries(counted.map(([face, n]) => [face, n ?? 0])) } : {}),
        ...(txn.trim() ? { cdmTxnNo: txn.trim() } : {}),
        ...(operator.trim() ? { cdmOperator: operator.trim() } : {}),
        ...(cds.trim() ? { cdsId: cds.trim() } : {}),
        ...(bag.trim() ? { bagNo: bag.trim() } : {}),
      });
      onDone(`Recorded: ${aed(fils!)} deposited.`);
    } catch (e) {
      setErr(errorText(e));
      setBusy(false);
    }
  };
  return (
    <Sheet
      title="🏦 Deposited"
      onClose={onClose}
      footer={
        <BigButton onClick={save} busy={busy} disabled={!ready}>
          {photos.length === 0 && fils ? "Add the receipt's photo first" : fils ? `Save ${aed(fils)}` : "Save"}
        </BigButton>
      }
    >
      <p className="text-sm text-mut">What you paid into the cash-deposit machine — as its receipt says.</p>
      <Holding heldFils={heldFils} />
      <PhotoButton viewer={viewer} retention="receipt" ids={photos} onChange={setPhotos} />
      <section>
        <h4 className="mb-1 font-semibold">Notes on the receipt</h4>
        <ul className="divide-y divide-edge rounded-xl border border-edge bg-panel">
          {AED_NOTES.map((face) => (
            <li key={face} className="flex items-center justify-between gap-2 p-2">
              <span className="font-semibold tabular-nums">AED {face}</span>
              <Stepper value={notes[String(face)] ?? 0} onChange={(v) => setNotes((x) => ({ ...x, [String(face)]: v }))} step={1} label={`Notes of AED ${face}`} />
            </li>
          ))}
        </ul>
        <p className="mt-1 text-sm font-semibold">{counted.length > 0 ? `Total ${aed(notesFils)}` : "Or type the amount:"}</p>
      </section>
      {counted.length === 0 ? <AmountField label="Deposited" value={amount} onChange={setAmount} /> : null}
      <div className="grid grid-cols-2 gap-2">
        <TextField label="Transaction no." value={txn} onChange={setTxn} maxLength={40} />
        <TextField label="Operator id" value={operator} onChange={setOperator} maxLength={60} />
        <TextField label="CDS id" value={cds} onChange={setCds} maxLength={40} />
        <TextField label="Bag no." value={bag} onChange={setBag} maxLength={40} />
      </div>
      <Problem text={err} />
    </Sheet>
  );
}

// ── undo ─────────────────────────────────────────────────────────────────────
export function UndoSheet({ viewer, entry, onDone, onClose }: { viewer: string; entry: CashEntry; onDone: (msg: string) => void; onClose: () => void }) {
  const [id] = useState(newId);
  const [reason, setReason] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const w = ENTRY_WORDS[entry.kind];
  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      await cash.reverse(viewer, entry.id, { id, reason: reason!, ...(note.trim() ? { note: note.trim() } : {}) });
      onDone("Undone — the entry stays in the record, marked undone.");
    } catch (e) {
      setErr(errorText(e));
      setBusy(false);
    }
  };
  return (
    <Sheet
      title="↩️ Undo an entry"
      onClose={onClose}
      footer={
        <BigButton onClick={save} busy={busy} tone="stop" disabled={!reason || (reason === "other" && !note.trim())}>
          Undo it
        </BigButton>
      }
    >
      <p className="font-semibold">
        {w.icon} {w.label} {aed(entry.amountFils)}
        {entry.machine ? ` · machine ${entry.machine.assetNo}` : ""} · {hhmm(entry.recordedAt)}
      </p>
      <p className="text-sm text-mut">Nothing is deleted: the opposite is recorded, and the entry is marked undone. Then enter it again, right.</p>
      <Chips options={Object.entries(CASH_REVERSE_WORDS).map(([value, label]) => ({ value, label }))} value={reason} onPick={setReason} />
      <TextArea label={reason === "other" ? "What was wrong? (needed)" : "Note (optional)"} value={note} onChange={setNote} rows={2} maxLength={500} />
      <Problem text={err} />
    </Sheet>
  );
}

// ── one shift, for the auditor ───────────────────────────────────────────────
/** Every entry of a shift with its photos and, beside each collection, Televend's figure; ok, or a question. */
export function ShiftSheet({ viewer, shiftId, onUndo, onDone, onClose }: { viewer: string; shiftId: string; onUndo: (e: CashEntry) => void; onDone: (msg: string) => void; onClose: () => void }) {
  const [s, setS] = useState<ShiftDetail | null>(null);
  const [question, setQuestion] = useState("");
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    cash.shift(viewer, shiftId).then(setS, (e) => setErr(errorText(e)));
  }, [viewer, shiftId]);
  const check = async (outcome: "ok" | "query") => {
    setBusy(true);
    setErr(null);
    try {
      await cash.audit(viewer, shiftId, { outcome, ...(outcome === "query" ? { note: question.trim() } : {}) });
      onDone(outcome === "ok" ? `✅ ${s?.employee.name}'s shift checked — ok.` : `❓ Asked ${s?.employee.name} — they answer in the app.`);
    } catch (e) {
      setErr(errorText(e));
      setBusy(false);
    }
  };
  return (
    <Sheet
      title={s ? `${s.employee.name} · ${dayOf(s.businessDate)}` : "A shift"}
      onClose={onClose}
      footer={
        s?.may.audit ? (
          asking ? (
            <BigButton onClick={() => check("query")} busy={busy} disabled={question.trim().length === 0}>
              Send the question
            </BigButton>
          ) : (
            <div className="grid grid-cols-2 gap-2">
              <BigButton onClick={() => setAsking(true)} tone="quiet">
                ❓ Ask
              </BigButton>
              <BigButton onClick={() => check("ok")} busy={busy}>
                ✓ All ok
              </BigButton>
            </div>
          )
        ) : undefined
      }
    >
      {!s && !err ? <p className="text-sm text-mut">Loading…</p> : null}
      {s ? (
        <>
          <ShiftSums s={s} />
          {s.audit ? (
            <p className="rounded-xl border border-edge bg-sunken p-3 text-sm">
              {s.audit.outcome === "ok" ? "✅" : "❓"} {s.audit.by}, {when(s.audit.at)}
              {s.audit.outcome === "ok" && s.answer && s.audit.note ? `: all ok — after asking “${s.audit.note}”` : s.audit.note ? `: “${s.audit.note}”` : ": all ok"}
              {s.answer ? (
                <>
                  <br />
                  💬 {s.employee.name}, {when(s.answer.at)}: “{s.answer.note}”
                </>
              ) : null}
            </p>
          ) : null}
          <EntryList viewer={viewer} entries={s.entries} onUndo={onUndo} showTelevend />
          {asking ? <TextArea label="Your question (they answer in the app)" value={question} onChange={setQuestion} rows={3} maxLength={500} /> : null}
        </>
      ) : null}
      <Problem text={err} />
    </Sheet>
  );
}

const dayOf = (date: string) => new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short" }).format(new Date(`${date}T12:00:00+04:00`));

/** A shift's sums in the order the WhatsApp list wrote them: in, out, left. */
export function ShiftSums({ s }: { s: ShiftDetail | import("../lib/cash-api").ShiftSummary }) {
  const rows: [string, number, string][] = [
    ["Carried in", s.carriedInFils, ""],
    ["Collected", s.collectedFils, "+"],
    ["Test notes", s.testFils, "−"],
    ["Fuel", s.fuelFils, "−"],
    ["Other spent", s.otherFils, "−"],
    ["Deposited", s.depositedFils, "−"],
  ];
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-1 rounded-xl border border-edge bg-panel p-3 text-sm sm:grid-cols-3">
      {rows
        .filter(([label, v]) => v !== 0 || label === "Collected" || label === "Deposited")
        .map(([label, v, sign]) => (
          <div key={label} className="flex justify-between gap-2">
            <dt className="text-mut">{label}</dt>
            <dd className="font-semibold tabular-nums">
              {sign && v ? `${sign} ` : ""}
              {aed(v)}
            </dd>
          </div>
        ))}
      <div className="col-span-full mt-1 flex justify-between gap-2 border-t border-edge pt-1">
        <dt className="font-semibold">{s.state === "open" ? "In hand now" : "Left in hand"}</dt>
        <dd className={`text-base font-extrabold tabular-nums ${s.leftFils > 0 && s.state === "closed" ? "text-crit" : ""}`}>{aed(s.leftFils)}</dd>
      </div>
    </dl>
  );
}

/** The entries of a shift — with Televend's figure beside each collection for whoever may see it. */
export function EntryList({ viewer, entries, onUndo, showTelevend = false }: { viewer: string; entries: CashEntry[]; onUndo: (e: CashEntry) => void; showTelevend?: boolean }) {
  if (entries.length === 0) return <p className="text-sm text-mut">Nothing recorded in this shift yet.</p>;
  return (
    <ul className="divide-y divide-edge rounded-xl border border-edge bg-panel">
      {entries.map((e) => {
        const w = ENTRY_WORDS[e.kind];
        const off = e.state === "reversed" || e.kind === "reversal";
        const tv = e.televend;
        return (
          <li key={e.id} className={`flex flex-wrap items-start justify-between gap-2 p-3 ${off ? "opacity-60" : ""}`}>
            <div className="min-w-0">
              <div className={`font-semibold ${e.state === "reversed" ? "line-through" : ""}`}>
                <span aria-hidden className="mr-1">{w.icon}</span>
                {e.kind === "expense" ? (e.expenseKind === "fuel" ? "Fuel" : "Spent") : w.label} {aed(e.amountFils)}
                {e.machine ? <span className="font-normal text-mut"> · {e.machine.assetNo} {e.machine.label}</span> : null}
              </div>
              <div className="text-xs text-mut">
                {hhmm(e.recordedAt)}
                {Math.abs(Date.parse(e.enteredAt) - Date.parse(e.recordedAt)) > 5 * 60_000 ? ` (made on the phone at ${hhmm(e.enteredAt)}, reached FreshNow at ${hhmm(e.recordedAt)})` : ""}
                {e.litres ? ` · ${e.litres} L` : ""}
                {e.deposit?.txnNo ? ` · txn ${e.deposit.txnNo}` : ""}
                {e.reason ? ` · ${CASH_REVERSE_WORDS[e.reason] ?? e.reason}` : ""}
                {e.note ? ` · “${e.note}”` : ""}
                {e.state === "reversed" ? " · undone" : ""}
              </div>
              {showTelevend && e.kind === "collection" && e.state === "posted" ? (
                <div className={`mt-1 text-xs font-semibold ${tv && tv.expectedFils === e.amountFils ? "text-ok" : "text-crit"}`}>
                  {tv
                    ? tv.expectedFils === e.amountFils
                      ? `✓ Televend: ${tv.cashVends} cash sale${tv.cashVends === 1 ? "" : "s"} = ${aed(tv.expectedFils)}`
                      : `Televend: ${tv.cashVends} cash sale${tv.cashVends === 1 ? "" : "s"} = ${aed(tv.expectedFils)} — ${e.amountFils > tv.expectedFils ? "more" : "less"} by ${aed(Math.abs(e.amountFils - tv.expectedFils))}`
                    : `Televend has no collection within 90 minutes of ${hhmm(e.enteredAt)}`}
                </div>
              ) : null}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {e.photos.map((p) => (
                <a key={p} href={`/dashboard/media/${p}?viewer=${encodeURIComponent(viewer)}`} target="_blank" rel="noreferrer">
                  <img src={`/dashboard/media/${p}?variant=thumb&viewer=${encodeURIComponent(viewer)}`} alt="The entry's photo" className="size-12 rounded-lg border border-edge object-cover" />
                </a>
              ))}
              {e.may.undo ? (
                <button onClick={() => onUndo(e)} className="min-h-12 rounded-xl border border-edge px-3 text-sm font-semibold hover:border-crit hover:text-crit">
                  Undo
                </button>
              ) : null}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
