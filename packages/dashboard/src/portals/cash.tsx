import { useCallback, useEffect, useState } from "react";
import { TextArea, TextField } from "../components/form";
import { Card, Empty, Pill, Spinner } from "../components/ui";
import { ApiError } from "../lib/api";
import { aed, cash, type CashEntry, type CashHome, type ShiftSummary } from "../lib/cash-api";
import { newId } from "../lib/inventory-api";
import { CASH_VIEWS, type CashView } from "../portals";
import { CollectSheet, DepositSheet, EntryList, ExpenseSheet, ShiftSheet, ShiftSums, TestNoteSheet, UndoSheet } from "./cash-sheets";
import { BigButton, Problem, errorText, when } from "./inv-ui";

/**
 * The Cash portal (TASK-061): every dirham from a machine's cash box to the cash-deposit machine, from
 * the cash ledger (migration 0035) — replacing the "CASH COLLECTION" WhatsApp group. A driver records
 * each collection, test note, fuel receipt and deposit as it happens, and sees what they hold; the
 * auditor checks each ended shift — with the photos and, beside each collection, Televend's own figure
 * (D221), which a driver never sees (D237) — and asks a question the driver answers here.
 *
 * Open to whoever handles cash and whoever sees all of it (portals.ts). The server decides what each may
 * see and do; this page only leaves out buttons that would be refused.
 */

const VIEW_LABEL: Record<CashView, string> = { mine: "My cash", check: "To check", shifts: "All shifts" };

type Open =
  | { kind: "collect" }
  | { kind: "test" }
  | { kind: "expense"; expense: "fuel" | "other" }
  | { kind: "deposit" }
  | { kind: "undo"; entry: CashEntry }
  | { kind: "shift"; id: string };

export default function CashPortal({ viewer, view, onView, liveTick }: { viewer: string; view: CashView; onView: (v: CashView) => void; liveTick: number }) {
  const [home, setHome] = useState<CashHome | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<Open | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setHome(await cash.home(viewer));
      setErr(null);
    } catch (e) {
      setErr(e instanceof ApiError && e.status === 403 ? e.message : errorText(e));
    }
  }, [viewer]);
  // Postgres rings the doorbell when cash moves (0035's live scope): an auditor's question, or a shift
  // ended, appears without a refresh. The minute's poll is the fallback.
  useEffect(() => {
    void load();
  }, [load, liveTick]);
  useEffect(() => {
    const t = setInterval(() => void load(), 60_000);
    return () => clearInterval(t);
  }, [load]);

  const can = home?.can;
  const views = CASH_VIEWS.filter((v) => (v === "mine" ? can?.hold : v === "check" ? can?.audit : can?.read));
  // The cash auditor holds no cash: their page is the shifts to check.
  const shown: CashView = home && !views.includes(view) ? (views[0] ?? "mine") : view;

  const done = (msg: string) => {
    setOpen(null);
    setFlash(msg);
    void load();
    setTimeout(() => setFlash(null), 6_000);
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold tracking-tight">Cash</h2>
          <p className="text-sm text-mut">Every dirham, from the machine to the bank — added up as you go, checked shift by shift.</p>
        </div>
        {views.length > 1 ? (
          <div className="flex rounded-xl border border-edge bg-sunken p-0.5" role="tablist" aria-label="Cash views">
            {views.map((v) => (
              <button
                key={v}
                role="tab"
                aria-selected={shown === v}
                onClick={() => onView(v)}
                className={`min-h-10 rounded-lg px-3 py-1.5 text-sm ${shown === v ? "bg-panel font-semibold text-ink shadow-sm" : "text-mut hover:text-ink"}`}
              >
                {VIEW_LABEL[v]}
                {v === "check" && home && home.toCheck.length > 0 ? ` (${home.toCheck.length})` : ""}
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
      {!home && !err ? <Spinner label="Opening cash…" /> : null}

      {home && shown === "mine" ? <MyCash viewer={viewer} home={home} onOpen={setOpen} onChanged={done} /> : null}
      {home && shown === "check" ? <ToCheck shifts={home.toCheck} onOpen={(id) => setOpen({ kind: "shift", id })} /> : null}
      {home && shown === "shifts" ? <AllShifts viewer={viewer} liveTick={liveTick} onOpen={(id) => setOpen({ kind: "shift", id })} /> : null}

      {open?.kind === "collect" ? <CollectSheet viewer={viewer} onDone={done} onClose={() => setOpen(null)} /> : null}
      {home && open?.kind === "test" ? <TestNoteSheet viewer={viewer} heldFils={home.heldFils} onDone={done} onClose={() => setOpen(null)} /> : null}
      {home && open?.kind === "expense" ? <ExpenseSheet viewer={viewer} kind={open.expense} heldFils={home.heldFils} onDone={done} onClose={() => setOpen(null)} /> : null}
      {home && open?.kind === "deposit" ? <DepositSheet viewer={viewer} heldFils={home.heldFils} onDone={done} onClose={() => setOpen(null)} /> : null}
      {open?.kind === "undo" ? <UndoSheet viewer={viewer} entry={open.entry} onDone={done} onClose={() => setOpen(null)} /> : null}
      {open?.kind === "shift" ? (
        <ShiftSheet viewer={viewer} shiftId={open.id} onUndo={(entry) => setOpen({ kind: "undo", entry })} onDone={done} onClose={() => setOpen(null)} />
      ) : null}
    </div>
  );
}

// ── the person's own cash ────────────────────────────────────────────────────
function MyCash({ viewer, home, onOpen, onChanged }: { viewer: string; home: CashHome; onOpen: (o: Open) => void; onChanged: (msg: string) => void }) {
  const s = home.openShift;
  const questions = home.questions.filter((x) => x.may.answer);
  return (
    <div className="space-y-4">
      {questions.map((q) => (
        <AnswerCard key={q.id} viewer={viewer} shift={q} onChanged={onChanged} />
      ))}

      <Card className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-sm text-mut">You hold</div>
          <div className="text-3xl font-extrabold tabular-nums">{aed(home.heldFils)}</div>
        </div>
        <ShiftControl viewer={viewer} home={home} onChanged={onChanged} />
      </Card>

      <section aria-label="What do you want to record?" className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        {(
          [
            ["🏧", "Collected", { kind: "collect" }],
            ["⛽", "Fuel", { kind: "expense", expense: "fuel" }],
            ["🔟", "Test note", { kind: "test" }],
            ["🏦", "Deposited", { kind: "deposit" }],
            ["🧾", "Other expense", { kind: "expense", expense: "other" }],
          ] as const
        ).map(([icon, label, o]) => (
          <button
            key={label}
            onClick={() => onOpen(o)}
            className="flex min-h-20 flex-col items-center justify-center gap-1 rounded-2xl border border-edge bg-panel p-2 text-center font-semibold hover:border-link"
          >
            <span aria-hidden className="text-3xl">
              {icon}
            </span>
            {label}
          </button>
        ))}
      </section>

      {s ? (
        <section aria-label="This shift" className="space-y-2">
          <h3 className="text-base font-bold">This shift</h3>
          <ShiftSums s={s} />
          {s.withoutPhoto > 0 ? <p className="text-sm text-crit">📷 {s.withoutPhoto} entr{s.withoutPhoto === 1 ? "y has" : "ies have"} no photo.</p> : null}
          <EntryList viewer={viewer} entries={[...s.entries].reverse()} onUndo={(entry) => onOpen({ kind: "undo", entry })} />
        </section>
      ) : null}

      {home.recentShifts.length > 0 ? (
        <section aria-label="Your last shifts" className="space-y-2">
          <h3 className="text-base font-bold">Your last shifts</h3>
          <ul className="space-y-2">
            {home.recentShifts.map((r) => (
              <li key={r.id}>
                <ShiftRow shift={r} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function ShiftControl({ viewer, home, onChanged }: { viewer: string; home: CashHome; onChanged: (msg: string) => void }) {
  const [vehicle, setVehicle] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const s = home.openShift;
  const run = async (f: () => Promise<string>) => {
    setBusy(true);
    setErr(null);
    try {
      onChanged(await f());
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  if (s) {
    return (
      <div className="text-right">
        <div className="text-sm text-mut">
          Shift since {when(s.startedAt)}
          {s.vehicle ? ` · ${s.vehicle}` : ""}
        </div>
        <button
          onClick={() =>
            run(async () => {
              const r = await cash.endShift(viewer);
              return r.heldFils > 0 ? `Shift ended — you still hold ${aed(r.heldFils)}: deposit it and record the receipt.` : "Shift ended — nothing in hand.";
            })
          }
          disabled={busy}
          className="mt-1 min-h-12 rounded-xl border border-edge px-4 font-semibold hover:border-crit hover:text-crit disabled:opacity-50"
        >
          End shift
        </button>
        <Problem text={err} />
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-end gap-2">
      <TextField label="Van (optional)" value={vehicle} onChange={setVehicle} placeholder="e.g. Van 4" maxLength={40} />
      <button
        onClick={() =>
          run(async () => {
            await cash.startShift(viewer, { id: newId(), ...(vehicle.trim() ? { vehicle: vehicle.trim() } : {}) });
            return "Shift started.";
          })
        }
        disabled={busy}
        className="min-h-12 rounded-xl border border-ok bg-ok/10 px-4 font-semibold text-ok disabled:opacity-50"
      >
        Start shift
      </button>
      <Problem text={err} />
    </div>
  );
}

function AnswerCard({ viewer, shift, onChanged }: { viewer: string; shift: ShiftSummary; onChanged: (msg: string) => void }) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const send = async () => {
    setBusy(true);
    setErr(null);
    try {
      await cash.answer(viewer, shift.id, note.trim(), shift.audit?.at ?? null);
      onChanged("Answer sent to the auditor.");
    } catch (e) {
      setErr(errorText(e));
      setBusy(false);
    }
  };
  return (
    <Card className="space-y-2 border-warn/50 bg-warn/10">
      <div className="font-semibold">
        ❓ {shift.audit?.by} asks about your shift of {shift.businessDate}:
      </div>
      <p className="text-lg">“{shift.audit?.note}”</p>
      {shift.answer ? <p className="text-sm text-mut">You answered {when(shift.answer.at)}: “{shift.answer.note}” — you can answer again.</p> : null}
      <TextArea label="Your answer" value={note} onChange={setNote} rows={2} maxLength={500} />
      <BigButton onClick={send} busy={busy} disabled={note.trim().length === 0}>
        Send the answer
      </BigButton>
      <Problem text={err} />
    </Card>
  );
}

function ShiftRow({ shift: r, onOpen }: { shift: ShiftSummary; onOpen?: () => void }) {
  const status =
    r.state === "open" ? (
      <Pill tone="warn">open</Pill>
    ) : r.audit?.outcome === "ok" ? (
      <Pill tone="ok">✓ checked</Pill>
    ) : r.audit?.outcome === "query" ? (
      <Pill tone="crit">{r.answer ? "❓ answered" : "❓ question"}</Pill>
    ) : (
      <Pill tone="mut">not checked yet</Pill>
    );
  const body = (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="min-w-0">
        <div className="font-semibold">
          {r.employee.name} · {r.businessDate}
        </div>
        <div className="text-sm text-mut">
          collected {aed(r.collectedFils)} · deposited {aed(r.depositedFils)}
          {r.fuelFils + r.otherFils > 0 ? ` · spent ${aed(r.fuelFils + r.otherFils)}` : ""}
          {r.testFils > 0 ? ` · test ${aed(r.testFils)}` : ""}
        </div>
        <div className="flex flex-wrap gap-1 pt-1 text-xs">
          {r.leftFils !== 0 && r.state === "closed" ? <Pill tone="crit">left in hand {aed(r.leftFils)}</Pill> : null}
          {r.differences ? <Pill tone="crit">{r.differences} differ from Televend</Pill> : null}
          {r.unmatched ? <Pill tone="warn">{r.unmatched} not seen by Televend</Pill> : null}
          {r.withoutPhoto > 0 ? <Pill tone="crit">📷 {r.withoutPhoto} without photo</Pill> : null}
        </div>
      </div>
      {status}
    </div>
  );
  return onOpen ? (
    <button onClick={onOpen} className="block w-full rounded-2xl border border-edge bg-panel p-3 text-left hover:border-link">
      {body}
    </button>
  ) : (
    <div className="rounded-2xl border border-edge bg-panel p-3">{body}</div>
  );
}

// ── the auditor's queue ──────────────────────────────────────────────────────
function ToCheck({ shifts, onOpen }: { shifts: ShiftSummary[]; onOpen: (id: string) => void }) {
  if (shifts.length === 0) return <Empty>Every ended shift is checked. ✓</Empty>;
  return (
    <section aria-label="Shifts to check" className="space-y-2">
      <p className="text-sm text-mut">Ended shifts not yet checked ok, oldest first. Open one to see its entries, photos and Televend's figures.</p>
      <ul className="space-y-2">
        {shifts.map((s) => (
          <li key={s.id}>
            <ShiftRow shift={s} onOpen={() => onOpen(s.id)} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function AllShifts({ viewer, liveTick, onOpen }: { viewer: string; liveTick: number; onOpen: (id: string) => void }) {
  const [rows, setRows] = useState<ShiftSummary[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    cash.shifts(viewer).then(
      (r) => {
        setRows(r);
        setErr(null);
      },
      (e) => setErr(errorText(e)),
    );
  }, [viewer, liveTick]);
  if (err) return <Empty>{err}</Empty>;
  if (!rows) return <Spinner label="Loading shifts…" />;
  if (rows.length === 0) return <Empty>No shifts in the last 7 days.</Empty>;
  return (
    <section aria-label="All shifts" className="space-y-2">
      <p className="text-sm text-mut">Everyone's shifts of the last 7 days, newest first.</p>
      <ul className="space-y-2">
        {rows.map((s) => (
          <li key={s.id}>
            <ShiftRow shift={s} onOpen={() => onOpen(s.id)} />
          </li>
        ))}
      </ul>
    </section>
  );
}
