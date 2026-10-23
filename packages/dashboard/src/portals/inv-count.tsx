import { useEffect, useState } from "react";
import { TextArea, TextField } from "../components/form";
import { ApiError } from "../lib/api";
import { COUNT_KIND_WORDS, REASON_WORDS, amount, inv, newId, units, type CountCard, type CountDetail, type CountItem } from "../lib/inventory-api";
import { BigButton, Chips, Problem, Sheet, Stepper, errorText, hhmm } from "./inv-ui";

/**
 * Counting the warehouse (TASK-060, D218). The count screen never shows the record's figure: the person
 * counting types what they see. A difference beyond the item's tolerance is counted again by someone
 * else — who sees neither the record nor the first count — and the Ops Head, the CEO or an Admin decides.
 */

const KINDS: CountCard["kind"][] = ["opening", "after_handout", "closing", "spot"];
const KIND_ICON: Record<CountCard["kind"], string> = { opening: "🌅", after_handout: "🚐", closing: "🌙", spot: "🔍" };

/** The blind list: every item, each starting empty — an untouched line is not "none". */
function BlindList({ items, values, onChange }: { items: CountItem[]; values: Record<string, number | null>; onChange: (id: string, v: number) => void }) {
  return (
    <ul className="divide-y divide-edge rounded-xl border border-edge bg-panel">
      {items.map((it) => (
        <li key={it.id} className="flex flex-wrap items-center justify-between gap-2 p-3">
          <div className="min-w-0">
            <div className="truncate font-semibold">
              <span aria-hidden className="mr-1 text-xl">{it.icon ?? "📦"}</span>
              {it.name}
            </div>
            <div className="text-xs text-mut">count in {units(it.unit)}</div>
          </div>
          <Stepper label={`${it.name}, counted, in ${units(it.unit)}`} value={values[it.id] ?? null} onChange={(v) => onChange(it.id, v)} step={it.step} />
        </li>
      ))}
    </ul>
  );
}

export function CountSheet({ viewer, kind: given, onDone, onClose }: { viewer: string; kind?: CountCard["kind"]; onDone: (msg: string) => void; onClose: () => void }) {
  const [id] = useState(newId);
  const [kind, setKind] = useState<CountCard["kind"] | null>(given ?? null);
  const [session, setSession] = useState<{ id: string; kind: CountCard["kind"]; startedAt: string; items: CountItem[]; resumed: boolean } | null>(null);
  const [values, setValues] = useState<Record<string, number | null>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<{ state: string; lines: number; matched: number; small: number; recount: number } | null>(null);

  useEffect(() => {
    if (!kind || session) return;
    inv.startCount(viewer, { id, kind }).then(
      (r) => setSession({ id: r.sessionId, kind: r.kind, startedAt: r.startedAt, items: r.items, resumed: r.resumed && r.sessionId !== id }),
      (e) => setErr(errorText(e)),
    );
  }, [viewer, id, kind, session]);

  // A count already open is carried on as the kind it was opened as — never handed in as another
  // (TASK-060 review). Cancelling it lets the chosen one start.
  const shown = session?.kind ?? kind;
  const otherKind = session !== null && kind !== null && session.kind !== kind;
  const cancelOpen = async () => {
    if (!session) return;
    setBusy(true);
    setErr(null);
    try {
      await inv.cancelCount(viewer, session.id);
      setValues({});
      setSession(null);
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const full = shown !== "spot";
  const counted = session ? session.items.filter((i) => values[i.id] !== null && values[i.id] !== undefined) : [];
  const ready = session !== null && (full ? counted.length === session.items.length : counted.length > 0);
  const handIn = async () => {
    if (!session) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await inv.submitCount(viewer, session.id, counted.map((i) => ({ itemId: i.id, qty: values[i.id]! })));
      setOutcome(r);
    } catch (e) {
      // The list of items changed while counting (one switched off, one added): the open count is read again — it carries
      // on as it is — and the figures already typed stay for the items still on it (review, 20 Oct).
      if (e instanceof ApiError && (e.code === "bad_item" || e.code === "count_every_item")) {
        try {
          const again = await inv.startCount(viewer, { id: session.id, kind: session.kind });
          const still = new Set(again.items.map((i) => i.id));
          setValues((v) => Object.fromEntries(Object.entries(v).filter(([k]) => still.has(k))));
          setSession({ ...session, items: again.items });
          setErr("The list of items changed while you counted — it is up to date now. Count any new item, then hand in again.");
        } catch (e2) {
          setErr(errorText(e2));
        }
      } else {
        setErr(errorText(e));
      }
    } finally {
      setBusy(false);
    }
  };

  if (outcome) {
    const words =
      outcome.state === "closed"
        ? outcome.lines === 1
          ? "✅ It matches the record."
          : `✅ All ${outcome.lines} items match the record.`
        : outcome.state === "recount"
          ? `🔢 ${outcome.recount} item${outcome.recount === 1 ? "" : "s"} differ — someone else will count ${outcome.recount === 1 ? "it" : "them"} again, then the Ops Head decides.`
          : `🕓 Small differences on ${outcome.small} item${outcome.small === 1 ? "" : "s"} — waiting for the Ops Head.`;
    return (
      <Sheet title="Count handed in" onClose={() => onDone(words)} footer={<BigButton onClick={() => onDone(words)}>Done</BigButton>}>
        <p className="text-lg">{words}</p>
        <p className="text-sm text-mut">Your count is kept as you handed it in. Nobody can change it.</p>
      </Sheet>
    );
  }

  return (
    <Sheet
      title={shown ? `🔢 ${COUNT_KIND_WORDS[shown]}` : "🔢 Count the warehouse"}
      onClose={onClose}
      footer={
        session ? (
          <BigButton onClick={handIn} busy={busy} disabled={!ready}>
            {ready ? "Hand in the count" : full ? `Count every item (${counted.length} of ${session.items.length})` : "Count at least one item"}
          </BigButton>
        ) : undefined
      }
    >
      {!kind ? (
        <section>
          <h4 className="mb-2 font-semibold">Which count?</h4>
          <Chips options={KINDS.map((k) => ({ value: k, label: COUNT_KIND_WORDS[k]!, icon: KIND_ICON[k] }))} value={kind} onPick={setKind} />
        </section>
      ) : null}
      {kind && !session && !err ? <p className="text-sm text-mut">Opening the count…</p> : null}
      {session ? (
        <>
          {otherKind ? (
            <div className="rounded-xl border border-warn/40 bg-warn/10 p-3 text-sm">
              <p>
                You already have a {COUNT_KIND_WORDS[session.kind]!.toLowerCase()} open, started at {hhmm(session.startedAt)} — this carries it on. Hand it in, or cancel it to
                start the {COUNT_KIND_WORDS[kind!]!.toLowerCase()}.
              </p>
              <button onClick={cancelOpen} disabled={busy} className="mt-2 min-h-12 rounded-xl border border-edge bg-panel px-4 font-semibold disabled:opacity-50">
                Cancel the open count
              </button>
            </div>
          ) : session.resumed ? (
            <p className="rounded-xl border border-warn/40 bg-warn/10 p-3 text-sm">You had a count open — this is it, carried on.</p>
          ) : null}
          <p className="text-sm text-mut">Count what is on the shelves and type what you see. The record's figure is not shown — that is on purpose.</p>
          <BlindList items={session.items} values={values} onChange={(i, v) => setValues((x) => ({ ...x, [i]: v }))} />
        </>
      ) : null}
      <Problem text={err} />
    </Sheet>
  );
}

/** Someone else counts the differing items again — also blind. */
export function RecountSheet({ viewer, sessionId, onDone, onClose }: { viewer: string; sessionId: string; onDone: (msg: string) => void; onClose: () => void }) {
  const [items, setItems] = useState<CountItem[] | null>(null);
  const [values, setValues] = useState<Record<string, number | null>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    inv.startRecount(viewer, sessionId).then((r) => setItems(r.items), (e) => setErr(errorText(e)));
  }, [viewer, sessionId]);
  const ready = items !== null && items.every((i) => values[i.id] !== null && values[i.id] !== undefined);
  const handIn = async () => {
    setBusy(true);
    setErr(null);
    try {
      await inv.submitRecount(viewer, sessionId, items!.map((i) => ({ itemId: i.id, qty: values[i.id]! })));
      onDone("Recount handed in — the Ops Head decides now.");
    } catch (e) {
      setErr(errorText(e));
      setBusy(false);
    }
  };
  return (
    <Sheet title="🔢 Count again" onClose={onClose} footer={items ? <BigButton onClick={handIn} busy={busy} disabled={!ready}>Hand in the recount</BigButton> : undefined}>
      <p className="text-sm text-mut">These items differed from the record. Count them yourself — neither the record nor the first count is shown.</p>
      {items ? <BlindList items={items} values={values} onChange={(i, v) => setValues((x) => ({ ...x, [i]: v }))} /> : !err ? <p className="text-sm text-mut">Loading…</p> : null}
      <Problem text={err} />
    </Sheet>
  );
}

const DECISION_REASONS = ["used_unrecorded", "damaged_unrecorded", "delivery_difference", "earlier_miscount", "found", "opening_balance", "unexplained"];

/** The approver's page: every differing line, both counts and the record — the count or the record is right. */
export function DecideSheet({ viewer, sessionId, onDone, onClose }: { viewer: string; sessionId: string; onDone: (msg: string) => void; onClose: () => void }) {
  const [docId] = useState(newId);
  const [c, setC] = useState<CountDetail | null>(null);
  const [choice, setChoice] = useState<Record<string, "accept_count" | "keep_ledger">>({});
  const [why, setWhy] = useState<Record<string, string>>({});
  const [note, setNote] = useState("");
  const [waive, setWaive] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const load = () => inv.count(viewer, sessionId).then(setC, (e) => setErr(errorText(e)));
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per opened count
  }, [viewer, sessionId]);
  if (!c) return <Sheet title="A count" onClose={onClose}>{err ? <Problem text={err} /> : <p className="text-sm text-mut">Loading…</p>}</Sheet>;

  const lines = c.lines.filter((l) => l.needsDecision);
  const ready = c.state === "approval" && lines.every((l) => choice[l.itemId] === "keep_ledger" || (choice[l.itemId] === "accept_count" && why[l.itemId]));
  const decide = async () => {
    setBusy(true);
    setErr(null);
    try {
      await inv.decide(viewer, sessionId, {
        docId,
        lines: lines.map((l) => ({ itemId: l.itemId, decision: choice[l.itemId]!, ...(choice[l.itemId] === "accept_count" ? { reason: why[l.itemId]! } : {}) })),
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      onDone("Decided — the record now says what you chose.");
    } catch (e) {
      setErr(errorText(e));
      setBusy(false);
    }
  };
  const letGo = async () => {
    setBusy(true);
    setErr(null);
    try {
      await inv.waive(viewer, sessionId, waive.trim());
      await load();
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      title={`${COUNT_KIND_WORDS[c.kind]} — ${c.submittedAt ? hhmm(c.submittedAt) : ""}`}
      onClose={onClose}
      footer={c.state === "approval" ? <BigButton onClick={decide} busy={busy} disabled={!ready}>Decide</BigButton> : undefined}
    >
      <p className="text-sm text-mut">
        Counted by {c.startedBy.name}
        {c.recountBy ? `, counted again by ${c.recountBy.name}` : ""}
        {c.recountWaivedReason ? ` — recount let go: “${c.recountWaivedReason}”` : ""}.
      </p>
      {c.state === "recount" ? (
        <section className="space-y-2 rounded-xl border border-warn/40 bg-warn/10 p-3">
          <p className="text-sm">This count waits for someone other than {c.startedBy.name} to count the differing items again{c.recountBy ? ` (${c.recountBy.name} is on it)` : ""}.</p>
          {c.may.waive ? (
            <>
              <TextField label="Or let the recount go — why?" value={waive} onChange={setWaive} placeholder="e.g. only one keeper on shift" maxLength={300} />
              <BigButton tone="quiet" onClick={letGo} busy={busy} disabled={waive.trim().length < 3}>
                Let the recount go
              </BigButton>
            </>
          ) : null}
        </section>
      ) : null}
      {c.state === "approval" && lines.length === 0 ? <p>The recount agrees with the record — nothing to decide. Press Decide to close it.</p> : null}
      {c.state === "approval"
        ? lines.map((l) => {
            const final = l.recount ?? l.counted ?? 0;
            const ledger = l.recount !== null ? (l.recountExpected ?? 0) : (l.expected ?? 0);
            const moved = l.recount !== null ? l.recountMovedDuring : l.movedDuring;
            return (
              <section key={l.itemId} className="space-y-2 rounded-xl border border-edge bg-panel p-3">
                <div className="font-semibold">
                  {l.icon} {l.name}
                </div>
                <dl className="grid grid-cols-3 gap-2 text-center text-sm">
                  <div className="rounded-lg bg-sunken p-2">
                    <dt className="text-xs text-mut">First count</dt>
                    <dd className="text-lg font-bold">{l.counted === null ? "—" : amount(l.counted, l.unit)}</dd>
                  </div>
                  <div className="rounded-lg bg-sunken p-2">
                    <dt className="text-xs text-mut">Recount</dt>
                    <dd className="text-lg font-bold">{l.recount === null ? "—" : amount(l.recount, l.unit)}</dd>
                  </div>
                  <div className="rounded-lg bg-sunken p-2">
                    <dt className="text-xs text-mut">The record</dt>
                    <dd className="text-lg font-bold">{amount(ledger, l.unit)}</dd>
                  </div>
                </dl>
                <p className={`text-sm font-semibold ${final < ledger ? "text-crit" : "text-ok"}`}>
                  {final === ledger ? "Same as the record" : `${final < ledger ? "Short" : "Over"} by ${amount(Math.abs(final - ledger), l.unit)}`}
                </p>
                {moved ? <p className="text-sm text-warn">It moved while it was being counted — only “the record is right” can be chosen; count again for a new figure.</p> : null}
                <Chips
                  options={[
                    ...(moved ? [] : [{ value: "accept_count" as const, label: "The count is right" }]),
                    { value: "keep_ledger" as const, label: "The record is right" },
                  ]}
                  value={choice[l.itemId] ?? null}
                  onPick={(v) => setChoice((x) => ({ ...x, [l.itemId]: v }))}
                />
                {choice[l.itemId] === "accept_count" ? (
                  <Chips options={DECISION_REASONS.map((r) => ({ value: r, label: REASON_WORDS[r] ?? r }))} value={why[l.itemId] ?? null} onPick={(v) => setWhy((x) => ({ ...x, [l.itemId]: v }))} />
                ) : null}
              </section>
            );
          })
        : null}
      {c.state === "approval" ? <TextArea label="Note (optional)" value={note} onChange={setNote} rows={2} maxLength={500} /> : null}
      <Problem text={err} />
    </Sheet>
  );
}
