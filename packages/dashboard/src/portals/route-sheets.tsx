import { useEffect, useId, useRef, useState } from "react";
import { TextArea, TextField } from "../components/form";
import { Pill, Spinner } from "../components/ui";
import { aed, filsOf } from "../lib/cash-api";
import { inv, newId, type Held } from "../lib/inventory-api";
import {
  EVIDENCE_ICON,
  EVIDENCE_KINDS,
  EVIDENCE_WORDS,
  STOP_TASKS,
  TASK_WORDS,
  dayLabel,
  proofFor,
  route,
  type EvidenceKind,
  type PlanCard,
  type RouteMachine,
  type ShiftWindow,
  type StopTask,
  type VisitDetail,
} from "../lib/route-api";
import { BigButton, ItemSteppers, PhotoButton, Problem, Sheet, Stepper, errorText, hhmm } from "./inv-ui";

/**
 * The Route portal's sheets (TASK-061 part 2): a visit at a machine, and a team's plan. Each write carries an id
 * made when its sheet opens, so a double tap or a retry on a bad connection posts once (the server's rule).
 */

const ROLE_WORDS: Readonly<Record<string, string>> = {
  vmo: "VMO / driver",
  technician: "Technician",
  supervisor: "Supervisor",
  ops_head: "Ops Head",
  admin: "Admin",
  ceo: "CEO",
};

// ── a visit ──────────────────────────────────────────────────────────────────
export function VisitSheet({
  viewer,
  visitId,
  canCash,
  onDone,
  onClose,
}: {
  viewer: string;
  visitId: string;
  canCash: boolean;
  onDone: (msg: string) => void;
  onClose: () => void;
}) {
  const [v, setV] = useState<VisitDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [open, setOpen] = useState<"fill" | "cash" | null>(null);
  const [note, setNote] = useState("");

  useEffect(() => {
    route.visit(viewer, visitId).then(setV, (e) => setErr(errorText(e)));
  }, [viewer, visitId]);

  /** One change at a time; the server answers with the visit as it now is. */
  const act = async (key: string, run: () => Promise<VisitDetail>): Promise<boolean> => {
    setBusy(key);
    setErr(null);
    try {
      setV(await run());
      return true;
    } catch (e) {
      setErr(errorText(e));
      return false;
    } finally {
      setBusy(null);
    }
  };

  if (!v) {
    return (
      <Sheet title="📍 Visit" onClose={onClose}>
        {err ? <Problem text={err} /> : <Spinner label="Opening the visit…" />}
      </Sheet>
    );
  }

  const live = !v.endedAt && v.may.change;
  const tasks: readonly StopTask[] = v.stop ? v.stop.tasks : STOP_TASKS;
  const asked: readonly EvidenceKind[] = v.stop && v.stop.evidence.length > 0 ? v.stop.evidence : EVIDENCE_KINDS;
  const end = async () => {
    setBusy("end");
    setErr(null);
    try {
      const r = await route.end(viewer, v.id, note.trim() || undefined);
      const parts = [
        r.missing.length > 0 ? `proof still missing: ${r.missing.map((k) => EVIDENCE_WORDS[k]).join(", ")}` : null,
        r.tasksLeft.length > 0 ? `not ticked: ${r.tasksLeft.map((t) => TASK_WORDS[t]).join(", ")}` : null,
      ].filter(Boolean);
      onDone(parts.length > 0 ? `Visit at ${v.machine.label} ended — ${parts.join("; ")}.` : `✓ Visit at ${v.machine.label} ended — all the proof is in.`);
    } catch (e) {
      setErr(errorText(e));
      setBusy(null);
    }
  };

  return (
    <Sheet
      title={`📍 ${v.machine.label}${v.machine.assetNo ? ` · ${v.machine.assetNo}` : ""}`}
      onClose={onClose}
      footer={
        !v.endedAt && v.may.end ? (
          <BigButton onClick={end} busy={busy === "end"} disabled={busy !== null && busy !== "end"}>
            {v.missing.length > 0 ? `End the visit (${v.missing.length} proof missing)` : "End the visit"}
          </BigButton>
        ) : null
      }
    >
      <div className="text-sm text-mut">
        {v.employee.name} · since {hhmm(v.startedAt)} · {v.startedHow === "qr" ? "started by the sticker" : "started by the machine's number"}
        {v.endedAt ? ` · ended ${hhmm(v.endedAt)}` : ""}
      </div>
      {v.stop ? (
        <div className="rounded-xl border border-edge bg-panel p-3">
          <div className="text-sm font-semibold">{v.stop.team}'s stop</div>
          {v.stop.instructions ? <div className="mt-1">“{v.stop.instructions}”</div> : null}
        </div>
      ) : (
        <p className="rounded-xl border border-warn/40 bg-warn/10 p-3 text-sm">This machine is not on your team's plan today — the visit is still recorded.</p>
      )}

      <section aria-label="What to do" className="space-y-2">
        <h4 className="font-bold">What to do {live ? <span className="text-sm font-normal text-mut">— tap each when it is done</span> : null}</h4>
        <div className="flex flex-wrap gap-2">
          {tasks.map((t) => {
            const done = v.tasksDone.includes(t);
            return (
              <button
                key={t}
                disabled={!live || busy !== null}
                aria-pressed={done}
                onClick={() => void act("tasks", () => route.tasks(viewer, v.id, done ? v.tasksDone.filter((x) => x !== t) : [...v.tasksDone, t]))}
                className={`min-h-12 rounded-xl border px-3 py-2 text-sm font-semibold disabled:cursor-default ${done ? "border-ok bg-ok/10 text-ok" : "border-edge bg-panel"}`}
              >
                {done ? "✓ " : ""}
                {TASK_WORDS[t]}
              </button>
            );
          })}
        </div>
      </section>

      <section aria-label="Proof" className="space-y-2">
        <h4 className="font-bold">Proof</h4>
        <ul className="space-y-2">
          {asked.map((k) => {
            const have = v.evidence.filter((e) => e.kind === k);
            const required = v.stop?.evidence.includes(k) ?? false;
            return (
              <li key={k} className={`rounded-xl border p-3 ${required && have.length === 0 ? "border-crit/50" : "border-edge"} bg-panel`}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="font-semibold">
                    {EVIDENCE_ICON[k]} {EVIDENCE_WORDS[k]}
                    {have.length > 0 ? <span className="ml-2 text-sm text-ok">✓ {have.length}</span> : required ? <span className="ml-2 text-sm text-crit">still needed</span> : null}
                  </div>
                  {live ? (
                    <EvidenceButton
                      kind={k}
                      busy={busy === `ev:${k}`}
                      disabled={busy !== null}
                      // Sent and added as one change, so "End the visit" waits for it: ending while a photo was still on its way
                      // lost the photo ("This visit has ended") — seen in the Route browser check, 20 Oct.
                      onFile={(f) =>
                        void act(`ev:${k}`, async () => {
                          // Kept as evidence; a video is kept as a video whatever is asked (the server decides, D212).
                          const m = await inv.uploadPhoto(viewer, f, "evidence");
                          return route.addEvidence(viewer, v.id, k, m.id);
                        })
                      }
                    />
                  ) : null}
                </div>
                {have.length > 0 ? (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {have.map((e) => (
                      <div key={e.id} className="relative">
                        {e.mediaId === null ? (
                          <span className="flex size-16 items-center justify-center rounded-lg border border-edge text-xs text-mut">removed by retention</span>
                        ) : k === "dispenser_video" ? (
                          <a
                            href={`/dashboard/media/${e.mediaId}?viewer=${encodeURIComponent(viewer)}`}
                            target="_blank"
                            rel="noreferrer"
                            className="flex size-16 items-center justify-center rounded-lg border border-edge text-2xl"
                            aria-label="Play the video"
                          >
                            ▶
                          </a>
                        ) : (
                          <a href={`/dashboard/media/${e.mediaId}?viewer=${encodeURIComponent(viewer)}`} target="_blank" rel="noreferrer">
                            <img
                              src={`/dashboard/media/${e.mediaId}?variant=thumb&viewer=${encodeURIComponent(viewer)}`}
                              alt={EVIDENCE_WORDS[k]}
                              className="size-16 rounded-lg border border-edge object-cover"
                            />
                          </a>
                        )}
                        {live ? (
                          <button
                            onClick={() => void act("remove", () => route.removeEvidence(viewer, v.id, e.id))}
                            disabled={busy !== null}
                            aria-label="Take this one off"
                            className="absolute -right-2 -top-2 flex size-8 items-center justify-center rounded-full border border-edge bg-canvas text-sm"
                          >
                            ✕
                          </button>
                        ) : null}
                      </div>
                    ))}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      </section>

      <section aria-label="Stock and cash" className="space-y-2">
        <h4 className="font-bold">Stock and cash</h4>
        {v.fills.map((f) => (
          <p key={f.docId} className="text-sm">
            🍊 Put in: {f.items}
          </p>
        ))}
        {v.cash.map((c) => (
          <p key={c.docId} className="text-sm">
            🏧 Cash taken out{c.amountFils !== null ? `: ${aed(c.amountFils)}` : " — recorded"}
          </p>
        ))}
        {live ? (
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => setOpen(open === "fill" ? null : "fill")}
              aria-expanded={open === "fill"}
              className="min-h-12 rounded-xl border border-edge bg-panel px-3 font-semibold hover:border-link"
            >
              🍊 Put stock in
            </button>
            {canCash ? (
              <button
                onClick={() => setOpen(open === "cash" ? null : "cash")}
                aria-expanded={open === "cash"}
                className="min-h-12 rounded-xl border border-edge bg-panel px-3 font-semibold hover:border-link"
              >
                🏧 Cash taken out
              </button>
            ) : null}
          </div>
        ) : null}
        {live && open === "fill" ? (
          <FillPanel
            viewer={viewer}
            onSave={async (id, lines) => {
              if (await act("fill", () => route.fill(viewer, v.id, { id, lines }))) setOpen(null);
            }}
            busy={busy === "fill"}
          />
        ) : null}
        {live && open === "cash" ? (
          <CashPanel
            viewer={viewer}
            onSave={async (id, amountFils, mediaIds) => {
              if (await act("cash", () => route.cash(viewer, v.id, { id, amountFils, mediaIds }))) setOpen(null);
            }}
            busy={busy === "cash"}
          />
        ) : null}
      </section>

      {!v.endedAt && v.may.change ? <TextArea label="Note for the supervisor (optional)" value={note} onChange={setNote} rows={2} maxLength={500} /> : v.note ? <p className="text-sm">Note: {v.note}</p> : null}
      <Problem text={err} />
    </Sheet>
  );
}

/** A photo, or for the dispenser a short video — the phone's camera opens; it is sent at once. */
function EvidenceButton({
  kind,
  busy,
  disabled,
  onFile,
}: {
  kind: EvidenceKind;
  busy: boolean;
  disabled: boolean;
  onFile: (f: File) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const video = kind === "dispenser_video";
  return (
    <>
      <input
        ref={input}
        type="file"
        accept={video ? "video/mp4,video/*" : "image/*"}
        capture="environment"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) onFile(f);
        }}
      />
      <button
        onClick={() => input.current?.click()}
        disabled={disabled}
        className="min-h-12 rounded-xl border border-ok bg-ok/10 px-3 text-sm font-semibold text-ok disabled:opacity-50"
      >
        {busy ? "Sending…" : video ? "🎥 Record (15 s at most)" : "📷 Take a photo"}
      </button>
    </>
  );
}

/** What the person holds, with a stepper each — what goes into this machine. */
function FillPanel({ viewer, onSave, busy }: { viewer: string; onSave: (id: string, lines: { itemId: string; qty: number }[]) => void; busy: boolean }) {
  const [id] = useState(newId);
  const [held, setHeld] = useState<Held[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [qty, setQty] = useState<Record<string, number>>({});
  useEffect(() => {
    inv.home(viewer).then(
      (h) => setHeld(h.mine.filter((m) => m.qty > 0)),
      (e) => setErr(errorText(e)),
    );
  }, [viewer]);
  const lines = Object.entries(qty)
    .filter(([, q]) => q > 0)
    .map(([itemId, q]) => ({ itemId, qty: q }));
  if (err) return <Problem text={err} />;
  if (!held) return <Spinner label="Looking at what you hold…" />;
  if (held.length === 0) return <p className="text-sm text-mut">You hold no stock. Take it from the warehouse in Stock first — it is handed to you there.</p>;
  return (
    <div className="space-y-2 rounded-xl border border-edge p-3">
      <p className="text-sm text-mut">From what you hold — what went into this machine.</p>
      <ItemSteppers items={held.map((h) => ({ id: h.itemId, name: h.name, unit: h.unit, step: h.step, icon: h.icon, available: h.qty }))} values={qty} onChange={(i, n) => setQty((q) => ({ ...q, [i]: n }))} />
      <BigButton onClick={() => onSave(id, lines)} busy={busy} disabled={lines.length === 0}>
        Save what went in
      </BigButton>
    </div>
  );
}

/** The cash out of the machine's box, typed in AED, with the photo of it. */
function CashPanel({ viewer, onSave, busy }: { viewer: string; onSave: (id: string, amountFils: number, mediaIds: string[]) => void; busy: boolean }) {
  const [id] = useState(newId);
  const [amount, setAmount] = useState("");
  const [photos, setPhotos] = useState<string[]>([]);
  const field = useId();
  const fils = filsOf(amount);
  return (
    <div className="space-y-2 rounded-xl border border-edge p-3">
      <label htmlFor={field} className="block text-sm font-semibold">
        What you took out of the cash box, as you counted it — 0 if it was empty
      </label>
      <div className="flex items-center gap-2">
        <span className="text-lg font-bold text-mut">AED</span>
        <input
          id={field}
          inputMode="decimal"
          value={amount}
          onChange={(e) => /^\d{0,7}([.,]\d{0,2})?$/.test(e.target.value) && setAmount(e.target.value)}
          placeholder="0"
          className="h-14 w-full rounded-xl border border-edge bg-sunken px-3 text-2xl font-extrabold tabular-nums"
        />
      </div>
      <PhotoButton viewer={viewer} retention="evidence" ids={photos} onChange={setPhotos} />
      <BigButton onClick={() => onSave(id, fils!, photos)} busy={busy} disabled={fils === null || photos.length === 0}>
        {fils !== null && photos.length === 0 ? "Add the photo first" : fils !== null ? `Save ${aed(fils)}` : "Save"}
      </BigButton>
    </div>
  );
}

// ── a team's plan ────────────────────────────────────────────────────────────
interface DraftStop {
  id: string;
  asset: string;
  tasks: StopTask[];
  crates: number | null;
  instructions: string;
  evidence: EvidenceKind[];
  /** The planner chose the proof themselves: changing the tasks no longer changes it. */
  evidenceChosen: boolean;
  open: boolean;
}

const blankStop = (): DraftStop => ({ id: newId(), asset: "", tasks: [], crates: null, instructions: "", evidence: [], evidenceChosen: false, open: true });

export function PlanEditor({
  viewer,
  plan,
  date,
  onDone,
  onClose,
}: {
  viewer: string;
  plan: PlanCard | null;
  date: string;
  onDone: (msg: string) => void;
  onClose: () => void;
}) {
  const [id] = useState(() => plan?.id ?? newId());
  const [day, setDay] = useState(plan?.businessDate ?? date);
  const [shift, setShift] = useState<ShiftWindow>(plan?.shiftWindow ?? "day");
  const [name, setName] = useState(plan?.name ?? "");
  const [note, setNote] = useState(plan?.note ?? "");
  const [members, setMembers] = useState<string[]>(plan?.members.map((m) => m.id) ?? []);
  const [stops, setStops] = useState<DraftStop[]>(
    () =>
      plan?.stops.map((s) => ({
        id: s.id,
        asset: s.machine.assetNo ? String(s.machine.assetNo) : "",
        tasks: s.tasks,
        crates: s.crates,
        instructions: s.instructions ?? "",
        evidence: s.evidence,
        evidenceChosen: true,
        open: false,
      })) ?? [blankStop()],
  );
  const [people, setPeople] = useState<{ id: string; name: string; role: string }[] | null>(null);
  const [machines, setMachines] = useState<RouteMachine[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [cancelArmed, setCancelArmed] = useState(false);
  const list = useId();

  useEffect(() => {
    route.people(viewer).then(setPeople, (e) => setErr(errorText(e)));
    route.machines(viewer).then(setMachines, () => setMachines([]));
  }, [viewer]);

  const machineOf = (asset: string) => machines.find((m) => m.assetNo === Number(asset));
  const change = (i: number, patch: Partial<DraftStop>) => setStops((all) => all.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  const move = (i: number, by: -1 | 1) =>
    setStops((all) => {
      const j = i + by;
      if (j < 0 || j >= all.length) return all;
      const next = [...all];
      [next[i], next[j]] = [next[j]!, next[i]!];
      return next;
    });

  // What would be refused, said before the tap — the server checks it all again.
  const problems: string[] = [];
  if (!name.trim()) problems.push("Give the plan a name — the team's, e.g. “Team Kiran”.");
  if (members.length === 0) problems.push("Choose who goes.");
  stops.forEach((s, i) => {
    const n = i + 1;
    if (!machineOf(s.asset)) problems.push(`Stop ${n}: choose the machine.`);
    if (s.tasks.length === 0) problems.push(`Stop ${n}: choose what to do.`);
    if ((s.tasks.includes("check") || s.tasks.includes("other")) && !s.instructions.trim()) problems.push(`Stop ${n}: say what to check or do.`);
  });
  const seen = new Set<string>();
  stops.forEach((s, i) => {
    if (s.asset && seen.has(s.asset)) problems.push(`Stop ${i + 1}: machine ${s.asset} is already on this plan.`);
    seen.add(s.asset);
  });
  const crates = stops.reduce((t, s) => t + (s.crates ?? 0), 0);

  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await route.savePlan(viewer, {
        id,
        businessDate: day,
        shiftWindow: shift,
        name: name.trim(),
        ...(note.trim() ? { note: note.trim() } : {}),
        memberIds: members,
        stops: stops.map((s) => ({
          id: s.id,
          machineAssetNo: Number(s.asset),
          tasks: s.tasks,
          crates: s.crates,
          instructions: s.instructions.trim() || null,
          evidence: s.evidence,
        })),
      });
      const head = `${r.created ? "Made" : "Saved"} ${name.trim()}: ${stops.length} machine${stops.length === 1 ? "" : "s"}${r.crates > 0 ? `, ${r.crates} crate${r.crates === 1 ? "" : "s"} of oranges` : ""}.`;
      onDone(r.warnings.length > 0 ? `${head} Note: ${r.warnings.join(" ")}` : head);
    } catch (e) {
      setErr(errorText(e));
      setBusy(false);
    }
  };

  return (
    <Sheet
      title={plan ? `Change ${plan.name}` : "New team plan"}
      onClose={onClose}
      footer={
        <div className="space-y-2">
          {problems.length > 0 ? <p className="text-sm text-mut">{problems[0]}</p> : null}
          <BigButton onClick={save} busy={busy} disabled={problems.length > 0}>
            {plan ? "Save the plan" : "Make the plan"}
            {crates > 0 ? ` · ${crates} crate${crates === 1 ? "" : "s"}` : ""}
          </BigButton>
        </div>
      }
    >
      {plan ? (
        <p className="text-sm text-mut">
          {dayLabel(plan.businessDate)}, {plan.shiftWindow} shift — another day or shift is another plan.
        </p>
      ) : (
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-sm font-semibold">
            Day
            <input type="date" value={day} onChange={(e) => e.target.value && setDay(e.target.value)} className="mt-1 block h-12 rounded-xl border border-edge bg-sunken px-3" />
          </label>
          <div role="group" aria-label="Shift" className="flex gap-2">
            {(["day", "night"] as const).map((w) => (
              <button
                key={w}
                onClick={() => setShift(w)}
                aria-pressed={shift === w}
                className={`min-h-12 rounded-xl border px-4 font-semibold ${shift === w ? "border-ok bg-ok/10" : "border-edge bg-panel"}`}
              >
                {w === "day" ? "☀️ Day shift" : "🌙 Night shift"}
              </button>
            ))}
          </div>
        </div>
      )}
      <TextField label="Team" value={name} onChange={setName} placeholder="Team Kiran" maxLength={80} />

      <div>
        <div className="mb-1 text-sm font-semibold">Who goes</div>
        {!people ? (
          <Spinner label="Loading people…" />
        ) : people.length === 0 ? (
          <p className="text-sm text-mut">Nobody's role visits machines yet — give someone the VMO or Technician role in People.</p>
        ) : (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {people.map((p) => {
              const on = members.includes(p.id);
              return (
                <button
                  key={p.id}
                  onClick={() => setMembers((m) => (on ? m.filter((x) => x !== p.id) : m.length >= 6 ? m : [...m, p.id]))}
                  aria-pressed={on}
                  className={`flex min-h-14 flex-col items-start justify-center rounded-xl border px-3 py-2 text-left ${on ? "border-ok bg-ok/10" : "border-edge bg-panel hover:border-link"}`}
                >
                  <span className="font-semibold">
                    {on ? "✓ " : ""}
                    {p.name}
                  </span>
                  <span className="text-xs text-mut">{ROLE_WORDS[p.role] ?? p.role}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div className="space-y-2">
        <div className="flex items-baseline justify-between">
          <div className="text-sm font-semibold">
            Machines, in order · {stops.length}
            {crates > 0 ? ` · ${crates} crate${crates === 1 ? "" : "s"}` : ""}
          </div>
        </div>
        <datalist id={list}>
          {machines.map((m) => (
            <option key={m.assetNo} value={m.assetNo}>
              {m.label}
            </option>
          ))}
        </datalist>
        <ol className="space-y-2">
          {stops.map((s, i) => {
            const m = machineOf(s.asset);
            const wrongShift = m?.serviceShift && m.serviceShift !== shift;
            return (
              <li key={s.id} className="rounded-xl border border-edge bg-panel p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="w-6 text-center font-bold text-mut">{i + 1}</span>
                  <input
                    inputMode="numeric"
                    list={list}
                    value={s.asset}
                    onChange={(e) => change(i, { asset: e.target.value.replace(/\D/g, "").slice(0, 5) })}
                    placeholder="No."
                    aria-label={`Stop ${i + 1}: machine number`}
                    className="h-12 w-24 rounded-xl border border-edge bg-sunken px-3 text-lg font-bold tabular-nums"
                  />
                  <button onClick={() => change(i, { open: !s.open })} aria-expanded={s.open} className="min-h-12 min-w-0 flex-1 text-left">
                    <span className="block truncate font-semibold">{m ? m.label : s.asset ? "No machine with this number" : "Choose the machine"}</span>
                    <span className="block truncate text-xs text-mut">
                      {s.tasks.map((t) => TASK_WORDS[t]).join(", ") || "nothing chosen yet"}
                      {s.crates ? ` · ${s.crates} crate${s.crates === 1 ? "" : "s"}` : ""}
                      {s.evidence.length > 0 ? ` · ${s.evidence.map((k) => EVIDENCE_ICON[k]).join("")}` : ""}
                    </span>
                  </button>
                  <div className="flex gap-1">
                    <button onClick={() => move(i, -1)} disabled={i === 0} aria-label="Earlier" className="size-11 rounded-lg border border-edge disabled:opacity-30">
                      ↑
                    </button>
                    <button onClick={() => move(i, 1)} disabled={i === stops.length - 1} aria-label="Later" className="size-11 rounded-lg border border-edge disabled:opacity-30">
                      ↓
                    </button>
                    <button onClick={() => setStops((all) => all.filter((_, j) => j !== i))} aria-label="Take this machine off the plan" className="size-11 rounded-lg border border-edge hover:border-crit hover:text-crit">
                      ✕
                    </button>
                  </div>
                </div>
                {wrongShift ? (
                  <p className="mt-1 text-sm text-warn">
                    {m!.serviceShift === "night" ? "🌙 Served at night only" : "☀️ Served by day only"}
                    {m!.serviceNote ? ` — ${m!.serviceNote}` : ""}
                  </p>
                ) : null}
                {s.open ? (
                  <div className="mt-3 space-y-3">
                    <div className="flex flex-wrap gap-1.5" role="group" aria-label={`Stop ${i + 1}: what to do`}>
                      {STOP_TASKS.map((t) => {
                        const on = s.tasks.includes(t);
                        return (
                          <button
                            key={t}
                            onClick={() => {
                              const tasks = on ? s.tasks.filter((x) => x !== t) : [...s.tasks, t];
                              change(i, { tasks, ...(s.evidenceChosen ? {} : { evidence: proofFor(tasks) }) });
                            }}
                            aria-pressed={on}
                            className={`min-h-11 rounded-lg border px-2.5 text-sm ${on ? "border-ok bg-ok/10 font-semibold" : "border-edge"}`}
                          >
                            {TASK_WORDS[t]}
                          </button>
                        );
                      })}
                    </div>
                    <div className="flex flex-wrap items-center gap-3">
                      <span className="text-sm font-semibold">Crates of oranges</span>
                      <Stepper label={`Stop ${i + 1}: crates of oranges`} value={s.crates} onChange={(n) => change(i, { crates: n })} step={1} min={0} max={20} />
                    </div>
                    <TextField
                      label={s.tasks.includes("check") || s.tasks.includes("other") ? "What to check or do" : "Instructions (optional)"}
                      value={s.instructions}
                      onChange={(t) => change(i, { instructions: t })}
                      placeholder="Check the tap after the repair"
                      maxLength={300}
                    />
                    <div>
                      <div className="mb-1 text-sm font-semibold">Proof to bring back</div>
                      <div className="flex flex-wrap gap-1.5" role="group" aria-label={`Stop ${i + 1}: proof`}>
                        {EVIDENCE_KINDS.map((k) => {
                          const on = s.evidence.includes(k);
                          return (
                            <button
                              key={k}
                              onClick={() => change(i, { evidence: on ? s.evidence.filter((x) => x !== k) : EVIDENCE_KINDS.filter((x) => x === k || s.evidence.includes(x)), evidenceChosen: true })}
                              aria-pressed={on}
                              className={`min-h-11 rounded-lg border px-2.5 text-sm ${on ? "border-ok bg-ok/10 font-semibold" : "border-edge"}`}
                            >
                              {EVIDENCE_ICON[k]} {EVIDENCE_WORDS[k]}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ol>
        <button
          onClick={() => setStops((all) => [...all.map((s) => ({ ...s, open: false })), blankStop()])}
          disabled={stops.length >= 60}
          className="min-h-12 w-full rounded-xl border border-dashed border-edge font-semibold hover:border-link"
        >
          + Add a machine
        </button>
      </div>

      <TextArea label="Note for the team (optional)" value={note} onChange={setNote} rows={2} maxLength={500} />

      {plan && plan.state === "active" ? (
        <div className="border-t border-edge pt-3">
          <button
            onClick={async () => {
              if (!cancelArmed) {
                setCancelArmed(true);
                return;
              }
              setBusy(true);
              try {
                await route.cancelPlan(viewer, plan.id);
                onDone(`${plan.name}'s plan for ${dayLabel(plan.businessDate)} is cancelled.`);
              } catch (e) {
                setErr(errorText(e));
                setBusy(false);
              }
            }}
            disabled={busy}
            className="min-h-12 rounded-xl border border-crit/50 px-4 text-sm font-semibold text-crit"
          >
            {cancelArmed ? "Tap again to cancel this plan" : "Cancel this plan"}
          </button>
        </div>
      ) : null}
      <Problem text={err} />
    </Sheet>
  );
}

// ── machines served only by day or only by night ─────────────────────────────
export function ServiceRules({ viewer, liveTick }: { viewer: string; liveTick: number }) {
  const [machines, setMachines] = useState<RouteMachine[] | null>(null);
  const [asset, setAsset] = useState("");
  const [shift, setShift] = useState<ShiftWindow | "any">("night");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const list = useId();
  useEffect(() => {
    route.machines(viewer).then(setMachines, (e) => setErr(errorText(e)));
  }, [viewer, liveTick, tick]);
  const ruled = machines?.filter((m) => m.serviceShift) ?? [];
  const known = machines?.find((m) => m.assetNo === Number(asset));
  return (
    <details className="rounded-2xl border border-edge bg-panel p-3">
      <summary className="min-h-10 cursor-pointer font-semibold">
        Machines served only by day or only by night · {ruled.length}
      </summary>
      <div className="mt-2 space-y-3">
        {ruled.length > 0 ? (
          <ul className="divide-y divide-edge text-sm">
            {ruled.map((m) => (
              <li key={m.assetNo} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span>
                  <Pill tone="mut">{m.serviceShift === "night" ? "🌙 night" : "☀️ day"}</Pill> {m.label} · {m.assetNo}
                  {m.serviceNote ? <span className="text-mut"> — {m.serviceNote}</span> : null}
                </span>
                <button
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      await route.setRule(viewer, m.assetNo, null);
                      setTick((t) => t + 1);
                    } catch (e) {
                      setErr(errorText(e));
                    } finally {
                      setBusy(false);
                    }
                  }}
                  className="min-h-10 rounded-lg border border-edge px-3 text-sm"
                >
                  Any shift
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-mut">None — every machine can go on a day or a night plan.</p>
        )}
        <div className="flex flex-wrap items-end gap-2">
          <input
            inputMode="numeric"
            list={list}
            value={asset}
            onChange={(e) => setAsset(e.target.value.replace(/\D/g, "").slice(0, 5))}
            placeholder="No."
            aria-label="Machine number"
            className="h-12 w-24 rounded-xl border border-edge bg-sunken px-3 text-lg font-bold tabular-nums"
          />
          <datalist id={list}>
            {machines?.map((m) => (
              <option key={m.assetNo} value={m.assetNo}>
                {m.label}
              </option>
            ))}
          </datalist>
          {(["night", "day", "any"] as const).map((w) => (
            <button key={w} onClick={() => setShift(w)} aria-pressed={shift === w} className={`min-h-12 rounded-xl border px-3 text-sm font-semibold ${shift === w ? "border-ok bg-ok/10" : "border-edge"}`}>
              {w === "night" ? "🌙 Night only" : w === "day" ? "☀️ Day only" : "Any shift"}
            </button>
          ))}
        </div>
        <p className="text-sm text-mut">{known ? `✓ ${known.label}` : asset && machines ? "No machine with this number." : " "}</p>
        <TextField label="Why (optional)" value={note} onChange={setNote} placeholder="The mall's loading bay opens at night" maxLength={300} />
        <button
          disabled={!known || busy}
          onClick={async () => {
            setBusy(true);
            setErr(null);
            try {
              await route.setRule(viewer, known!.assetNo, shift === "any" ? null : shift, note.trim() || undefined);
              setAsset("");
              setNote("");
              setTick((t) => t + 1);
            } catch (e) {
              setErr(errorText(e));
            } finally {
              setBusy(false);
            }
          }}
          className="min-h-12 rounded-xl border border-ok bg-ok/10 px-4 font-semibold text-ok disabled:opacity-50"
        >
          Save the rule
        </button>
        <Problem text={err} />
      </div>
    </details>
  );
}
