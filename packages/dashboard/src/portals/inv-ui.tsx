import { useEffect, useRef, useState, type ReactNode } from "react";
import { amount, inv, units, type Holder } from "../lib/inventory-api";

/**
 * The Inventory portal's building blocks (TASK-060), made for a phone held in one hand at the warehouse:
 * targets at least 48 px (Android's guidance: 48dp, ≈9 mm — checked 2026-10-17), a picture or an icon
 * before the words, numbers changed with − and + rather than typed, and one thing to do per screen.
 */

/** A full-screen sheet on a phone, a panel on a wide screen. Escape and the ✕ close it. */
export function Sheet({ title, onClose, children, footer }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/40" onClick={onClose} role="presentation">
      <section
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        className="flex h-full w-full max-w-lg flex-col border-l border-edge bg-canvas shadow-2xl"
      >
        <header className="flex items-center justify-between gap-2 border-b border-edge px-4 py-3">
          <h3 className="text-lg font-bold">{title}</h3>
          <button onClick={onClose} aria-label="Close" className="flex size-12 items-center justify-center rounded-xl text-2xl text-mut hover:bg-sunken hover:text-ink">
            ✕
          </button>
        </header>
        <div className="flex-1 space-y-4 overflow-y-auto p-4">{children}</div>
        {footer ? <footer className="border-t border-edge p-4">{footer}</footer> : null}
      </section>
    </div>
  );
}

/** The one big button at the bottom of a sheet. */
export function BigButton({ children, onClick, busy, disabled, tone = "go" }: { children: ReactNode; onClick: () => void; busy?: boolean; disabled?: boolean; tone?: "go" | "quiet" | "stop" }) {
  const tones = {
    go: "border-ok bg-ok text-on-accent",
    quiet: "border-edge bg-sunken text-ink",
    stop: "border-crit bg-crit/10 text-crit",
  } as const;
  return (
    <button
      onClick={onClick}
      disabled={disabled || busy}
      className={`min-h-14 w-full rounded-2xl border px-4 py-3 text-lg font-bold disabled:cursor-not-allowed disabled:opacity-50 ${tones[tone]}`}
    >
      {busy ? "…" : children}
    </button>
  );
}

/**
 * − 12 + : the step is the item's (a carton, half a box). Typing a number works too. A count starts
 * empty (null), not at 0 — an untouched line must not be handed in as "none".
 */
export function Stepper({ value: raw, onChange, step, min = 0, max, label }: { value: number | null; onChange: (v: number) => void; step: number; min?: number; max?: number; label: string }) {
  const value = raw ?? Number.NaN;
  // What is being typed, while the box has focus: shown as typed, so "2." keeps its point until the
  // "5" follows (re-reading the number on every key turned "2.5" into 25 — TASK-060 review).
  const [draft, setDraft] = useState<string | null>(null);
  const clamp = (v: number) => {
    const r = Math.round(v / step) * step;
    const lo = Math.max(min, r);
    return Math.round((max === undefined ? lo : Math.min(max, lo)) * 1000) / 1000;
  };
  return (
    <div className="flex items-center gap-2" role="group" aria-label={label}>
      <button
        onClick={() => onChange(clamp(value - step))}
        disabled={raw === null || value <= min}
        aria-label={`One ${step === 1 ? "" : "step "}less`}
        className="flex size-12 shrink-0 items-center justify-center rounded-xl border border-edge bg-sunken text-2xl font-bold disabled:opacity-40"
      >
        −
      </button>
      <input
        inputMode="decimal"
        value={draft ?? (Number.isFinite(value) ? String(value) : "")}
        // A 0 makes way for what is typed (typing "2.5" into "0" read "02.5"); any other figure stays to be edited.
        onFocus={() => setDraft(Number.isFinite(value) && value !== 0 ? String(value) : "")}
        onChange={(e) => {
          const t = e.target.value;
          // Digits, then at most one point (or comma) with up to three decimals; anything else is ignored.
          if (!/^\d*([.,]\d{0,3})?$/.test(t)) return;
          const n = Number(t.replace(",", "."));
          if (!/\d/.test(t) || !Number.isFinite(n)) {
            setDraft(t);
            return;
          }
          if (max !== undefined && n > max) {
            setDraft(String(max));
            onChange(max);
            return;
          }
          setDraft(t);
          onChange(n);
        }}
        onBlur={() => {
          setDraft(null);
          if (raw !== null) onChange(clamp(value));
        }}
        placeholder={raw === null ? "?" : "0"}
        aria-label={label}
        className="h-12 w-20 rounded-xl border border-edge bg-sunken text-center text-xl font-bold tabular-nums"
      />
      <button
        onClick={() => onChange(raw === null ? clamp(step) : clamp(value + step))}
        disabled={raw !== null && max !== undefined && value >= max}
        aria-label={`One ${step === 1 ? "" : "step "}more`}
        className="flex size-12 shrink-0 items-center justify-center rounded-xl border border-edge bg-sunken text-2xl font-bold disabled:opacity-40"
      >
        +
      </button>
    </div>
  );
}

export interface PickItem {
  id: string;
  name: string;
  unit: string;
  step: number;
  icon: string | null;
  /** How much there is to take from — shown, and the stepper's top. Absent: no limit shown. */
  available?: number;
}

/** Every item with a stepper; only those above zero are sent. */
export function ItemSteppers({ items, values, onChange, showAvailable = true }: { items: PickItem[]; values: Record<string, number>; onChange: (id: string, v: number) => void; showAvailable?: boolean }) {
  if (items.length === 0) return <p className="text-sm text-mut">Nothing to choose from.</p>;
  return (
    <ul className="divide-y divide-edge rounded-xl border border-edge bg-panel">
      {items.map((it) => (
        <li key={it.id} className="flex flex-wrap items-center justify-between gap-2 p-3">
          <div className="min-w-0">
            <div className="truncate font-semibold">
              <span aria-hidden className="mr-1 text-xl">{it.icon ?? "📦"}</span>
              {it.name}
            </div>
            <div className="text-xs text-mut">
              {it.unit}
              {showAvailable && it.available !== undefined ? ` · ${amount(it.available, it.unit)} there` : ""}
            </div>
          </div>
          <Stepper
            label={`${it.name}, in ${units(it.unit)}`}
            value={values[it.id] ?? 0}
            onChange={(v) => onChange(it.id, v)}
            step={it.step}
            {...(showAvailable && it.available !== undefined ? { max: it.available } : {})}
          />
        </li>
      ))}
    </ul>
  );
}

/** People who can be given stock: big tiles with initials — a face to tap, not a list to read. */
export function PersonTiles({ people, value, onPick }: { people: Holder[]; value: string | null; onPick: (id: string) => void }) {
  if (people.length === 0) return <p className="text-sm text-mut">Nobody here can be given stock yet — their role must allow it.</p>;
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
      {people.map((p) => {
        const on = p.id === value;
        const initials = p.name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("");
        return (
          <button
            key={p.id}
            onClick={() => onPick(p.id)}
            aria-pressed={on}
            className={`flex min-h-16 items-center gap-2 rounded-xl border p-2 text-left ${on ? "border-ok bg-ok/10" : "border-edge bg-panel hover:border-link"}`}
          >
            <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-sunken font-bold">{initials}</span>
            <span className="min-w-0">
              <span className="block truncate font-semibold">{p.name}</span>
              <span className="block truncate text-xs text-mut">{p.canReceive ? p.role : `${p.role} — can no longer be given stock`}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** Choice chips — reasons, kinds — each a big target with an icon. */
export function Chips<T extends string>({ options, value, onPick }: { options: { value: T; label: string; icon?: string }[]; value: T | null; onPick: (v: T) => void }) {
  return (
    <div className="flex flex-wrap gap-2">
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onPick(o.value)}
          aria-pressed={value === o.value}
          className={`min-h-12 rounded-xl border px-3 py-2 text-sm font-semibold ${value === o.value ? "border-ok bg-ok/10 text-ink" : "border-edge bg-panel text-ink hover:border-link"}`}
        >
          {o.icon ? <span aria-hidden className="mr-1">{o.icon}</span> : null}
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Take a photo (the phone's camera opens) or choose one; it is uploaded at once and its id kept. */
export function PhotoButton({ viewer, retention, ids, onChange }: { viewer: string; retention: "evidence" | "receipt"; ids: string[]; onChange: (ids: string[]) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <div>
      <input
        ref={input}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={async (e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (!f) return;
          setBusy(true);
          setErr(null);
          try {
            const m = await inv.uploadPhoto(viewer, f, retention);
            onChange([...ids, m.id]);
          } catch (x) {
            setErr(x instanceof Error ? x.message : "The photo could not be sent.");
          } finally {
            setBusy(false);
          }
        }}
      />
      <button
        onClick={() => input.current?.click()}
        disabled={busy || ids.length >= 6}
        className="min-h-12 rounded-xl border border-edge bg-panel px-3 py-2 text-sm font-semibold hover:border-link disabled:opacity-50"
      >
        📷 {busy ? "Sending…" : ids.length > 0 ? `${ids.length} photo${ids.length === 1 ? "" : "s"} — add another` : "Add a photo"}
      </button>
      {err ? <p className="mt-1 text-sm text-crit">{err}</p> : null}
    </div>
  );
}

/** A refusal from the server, in its own words. */
export function Problem({ text }: { text: string | null }) {
  if (!text) return null;
  return (
    <p role="alert" className="rounded-xl border border-crit/40 bg-crit/10 p-3 text-sm text-crit">
      {text}
    </p>
  );
}

export const when = (iso: string): string =>
  new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Dubai", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));
export const hhmm = (iso: string): string =>
  new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Dubai", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));

/** The lines a document says, in a line of words. */
export function linesText(lines: { name: string; unit: string; qty: number; icon: string | null }[]): string {
  return lines.map((l) => `${l.icon ? `${l.icon} ` : ""}${amount(l.qty, l.unit)} ${l.name}`).join(" · ");
}

export const errorText = (e: unknown): string => (e instanceof Error ? e.message : "Something went wrong.");
