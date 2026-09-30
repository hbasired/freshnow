import { useState } from "react";
import { api, PROGRESS_BANDS, progressLabel, type OpenTask, type ProgressBand, type ProgressSource, type ReportedStatus } from "../lib/api";
import { Button, Select, TextArea, TextField, Toast, useAction } from "./form";
export { dueShortcuts } from "../lib/dates";

/**
 * The quick ways to report: pick instead of type.
 *
 * The people this is for report from a phone, between jobs, often in a second language.
 * Every input here that can be a tap is a tap — a range from a list instead of a typed
 * percentage, a starter sentence instead of a blank box — but the starter is only a start:
 * it lands in an ordinary text box the person can change, because their own words are
 * what the CEO reads and what the blocker parser classifies.
 */

/** A row of tappable choices. Wraps on a phone; each is thumb-sized (≥ 36 px tall). */
export function Chips({
  options,
  onPick,
  selected,
  label,
}: {
  options: readonly string[];
  onPick: (v: string) => void;
  /** Shown as pressed — for chips that are a choice rather than a starter. */
  selected?: string | null;
  label?: string;
}) {
  return (
    <div>
      {label ? <div className="mb-1 text-xs text-mut">{label}</div> : null}
      <div className="flex flex-wrap gap-1.5">
        {options.map((o) => {
          const on = selected === o;
          return (
            <button
              key={o}
              type="button"
              onClick={() => onPick(o)}
              aria-pressed={selected !== undefined ? on : undefined}
              className={`min-h-9 rounded-full border px-3 py-1.5 text-sm ${
                on ? "border-ok bg-ok/15 font-semibold text-ok" : "border-edge bg-sunken text-ink hover:border-link"
              }`}
            >
              {o}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Tapping a starter fills an empty box, or adds to what is already there. */
function withStarter(current: string, starter: string): string {
  const t = current.trim();
  if (!t) return starter;
  if (t.includes(starter)) return current;
  return `${t.replace(/[.;,]\s*$/, "")}; ${starter}`;
}

/** Starters for "what was done" on a self-reported percentage. */
export const PROGRESS_STARTERS = ["Started the work", "Materials ready", "Some of it done", "Most of it done", "Final checks left", "Paused for today"] as const;

/**
 * Starters for a problem. Plain, concrete, and in the words the blocker parser already reads
 * well — "machine not working" rather than a category code — because the model still reads
 * the sentence; these only save typing it.
 */
export const BLOCKER_STARTERS = ["Machine not working", "Out of oranges / stock", "Waiting for parts", "No power or water", "Vehicle problem", "Need help from someone"] as const;

const EXACT = "exact";

function bandKey(b: ProgressBand): string {
  return `${b.low}-${b.high}`;
}

/**
 * "How far along is it?" — a dropdown of ten-point ranges, plus a way to give an exact number
 * for the rare person who has one. The range is sent as a range; the server stores it as the
 * range and counts it as the midpoint, so "10–20%" is never later shown as "15%".
 */
export function ProgressReport({
  viewer,
  task,
  onSaved,
}: {
  viewer: string;
  task: { id: string; progress_pct: number; progress_source: ProgressSource; progress_band_low: number | null; progress_band_high: number | null };
  onSaved: () => void;
}) {
  const act = useAction();
  const current = task.progress_band_low != null && task.progress_band_high != null ? bandKey({ low: task.progress_band_low, high: task.progress_band_high }) : "";
  const [choice, setChoice] = useState(current);
  const [exact, setExact] = useState("");
  const [note, setNote] = useState("");

  const band = PROGRESS_BANDS.find((b) => bandKey(b) === choice) ?? null;
  const exactOk = choice === EXACT && /^\d{1,3}$/.test(exact) && Number(exact) <= 100;
  const ready = (band !== null || exactOk) && note.trim().length >= 3;

  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (!ready) return;
        void act.run(async () => {
          const r = await api.reportProgress(viewer, task.id, band ? { band: { low: band.low, high: band.high } } : { pct: Number(exact) }, note.trim());
          setNote("");
          setExact("");
          onSaved();
          return `Recorded ${r.band ? `${r.band.low}–${r.band.high}%` : `${r.pct}%`} (self-reported).`;
        });
      }}
    >
      <Toast message={act.message} tone={act.tone} onDone={act.clear} />
      <div className="grid gap-3 sm:grid-cols-[minmax(12rem,16rem)_1fr]">
        <Select
          label="How far along is it?"
          value={choice}
          onChange={setChoice}
          options={[
            { value: "", label: "— choose a range —" },
            ...PROGRESS_BANDS.map((b) => ({ value: bandKey(b), label: `${b.low}–${b.high}%${b.hint ? ` · ${b.hint}` : ""}` })),
            { value: EXACT, label: "I know the exact number…" },
          ]}
          hint={`Now: ${progressLabel(task)}${task.progress_source === "counted" ? " — counted from its steps; ticking steps is stronger than a range" : ""}. Finished? Use ✅ Done instead.`}
        />
        {choice === EXACT ? (
          <TextField label="Exact %" type="number" value={exact} onChange={setExact} placeholder="0–100" maxLength={3} />
        ) : null}
      </div>
      <Chips label="Tap to fill in what was done — then add detail if you can" options={PROGRESS_STARTERS} onPick={(s) => setNote((n) => withStarter(n, s))} />
      <TextArea label="What was done (required)" value={note} onChange={setNote} rows={2} maxLength={500} placeholder="e.g. cleaned 3 of the 5 machines at the mall" />
      <Button type="submit" tone="primary" busy={act.busy} disabled={!ready} className="w-full sm:w-auto">
        Save progress
      </Button>
    </form>
  );
}

/**
 * Done / Pending / Problem — the bot's three buttons, as three thumb-sized buttons. A problem
 * asks for the person's own words (with starters) before anything is sent, exactly as the bot
 * does with its force-reply, because those words are what the CEO reads.
 */
export function StatusReport({
  viewer,
  task,
  onChanged,
}: {
  viewer: string;
  task: Pick<OpenTask, "id" | "title">;
  onChanged: () => void;
}) {
  const act = useAction();
  const [blocking, setBlocking] = useState(false);
  const [note, setNote] = useState("");

  async function report(status: ReportedStatus, withNote?: string): Promise<void> {
    const ok = await act.run(async () => {
      const r = await api.reportUpdate(viewer, { taskId: task.id, status, ...(withNote ? { note: withNote } : {}) });
      onChanged();
      if (r.needsReview) return "Saved. Your note could not be read automatically, so a person will look at it.";
      if (r.blockerId) return `Saved as a problem (${r.severity ?? "severity pending"}) — ${r.alerted ? "the CEO has been alerted." : "queued for the CEO."}`;
      return `Saved: "${task.title}" → ${status.replace("_", " ")}.`;
    });
    if (ok) {
      setBlocking(false);
      setNote("");
    }
  }

  return (
    <div className="space-y-2">
      <Toast message={act.message} tone={act.tone} onDone={act.clear} />
      {blocking ? (
        <div className="space-y-2 rounded-lg border border-crit/40 bg-crit/5 p-3">
          <Chips label="What is the problem? Tap one, then add detail" options={BLOCKER_STARTERS} onPick={(s) => setNote((n) => withStarter(n, s))} />
          <TextArea label="In your own words, any language" value={note} onChange={setNote} placeholder="e.g. van 2 ka chiller kaam nahi kar raha" maxLength={2000} />
          <div className="grid grid-cols-2 gap-2 sm:flex">
            <Button tone="danger" busy={act.busy} disabled={note.trim().length < 3} onClick={() => void report("blocker", note.trim())} className="min-h-11">
              🚫 Send problem
            </Button>
            <Button onClick={() => { setBlocking(false); setNote(""); }} className="min-h-11">Cancel</Button>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-3 gap-2 sm:flex sm:flex-wrap">
          <Button tone="primary" busy={act.busy} onClick={() => void report("done")} className="min-h-11" title="The task is finished">✅ Done</Button>
          <Button busy={act.busy} onClick={() => void report("pending")} className="min-h-11" title="Still going, no problem">⏳ Pending</Button>
          <Button tone="danger" busy={act.busy} onClick={() => { setBlocking(true); setNote(""); }} className="min-h-11" title="Something is stopping the work">🚫 Problem</Button>
        </div>
      )}
    </div>
  );
}

