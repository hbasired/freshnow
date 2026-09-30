import { useEffect, useState, type ReactNode } from "react";

/**
 * The inputs. Deliberately plain, matching ui.tsx — this is a dashboard, not a design
 * system — but shared, because seven write forms typing their own Tailwind is how two
 * buttons end up meaning different things.
 */

export function Button({
  children,
  onClick,
  tone = "quiet",
  busy = false,
  disabled = false,
  type = "button",
  title,
  className = "",
}: {
  children: ReactNode;
  onClick?: () => void;
  tone?: "primary" | "quiet" | "danger";
  busy?: boolean;
  disabled?: boolean;
  type?: "button" | "submit";
  title?: string;
  /** Size and layout only (e.g. a full-width thumb-sized button on a phone) — never colour. */
  className?: string;
}) {
  const tones = {
    primary: "border-ok bg-ok/10 text-ok hover:bg-ok/20",
    quiet: "border-edge bg-sunken text-ink hover:border-link",
    danger: "border-crit bg-crit/10 text-crit hover:bg-crit/20",
  } as const;
  return (
    <button
      type={type}
      title={title}
      onClick={onClick}
      disabled={disabled || busy}
      className={`rounded-lg border px-3 py-2 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-50 ${tones[tone]} ${className}`}
    >
      {busy ? "…" : children}
    </button>
  );
}

function Label({ label, hint, children }: { label: string; hint?: string | undefined; children: ReactNode }) {
  return (
    <label className="block text-sm">
      <span className="text-mut">{label}</span>
      {children}
      {hint ? <span className="mt-1 block text-xs text-mut">{hint}</span> : null}
    </label>
  );
}

const inputClass =
  "mt-1 w-full rounded-lg border border-edge bg-sunken px-3 py-2 text-sm text-ink placeholder:text-mut focus:border-link focus:outline-none";

export function TextField({
  label,
  value,
  onChange,
  placeholder,
  hint,
  maxLength,
  disabled,
  // "number" only changes the keyboard a phone offers and the browser's own guard rails;
  // the value stays a string here, because every caller parses it itself.
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  hint?: string;
  maxLength?: number;
  disabled?: boolean;
  type?: "text" | "number";
}) {
  return (
    <Label label={label} hint={hint}>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        maxLength={maxLength}
        disabled={disabled}
        className={inputClass}
      />
    </Label>
  );
}

export function TextArea({
  label,
  value,
  onChange,
  placeholder,
  hint,
  rows = 3,
  maxLength,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  hint?: string;
  rows?: number;
  maxLength?: number;
}) {
  return (
    <Label label={label} hint={hint}>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        rows={rows}
        maxLength={maxLength}
        className={`${inputClass} resize-y`}
      />
    </Label>
  );
}

export function Select({
  label,
  value,
  onChange,
  options,
  hint,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  hint?: string;
}) {
  return (
    <Label label={label} hint={hint}>
      <select value={value} onChange={(e) => onChange(e.target.value)} className={inputClass}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </Label>
  );
}

/**
 * Choosing a person. Shows whether they are reachable on Telegram, because assigning work
 * to somebody the bot cannot message is a thing worth knowing *before* pressing the button
 * rather than discovering when nothing arrives.
 */
export function PersonPicker({
  label,
  value,
  onChange,
  people,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  people: { id: string; display_name: string; linked?: boolean }[];
}) {
  return (
    <Select
      label={label}
      value={value}
      onChange={onChange}
      options={[
        { value: "", label: "— choose somebody —" },
        ...people.map((p) => ({
          value: p.id,
          // Not on Telegram is no longer "unreachable": the in-app inbox (and their devices, if
          // turned on) still reach them. The note says which, rather than implying nothing arrives.
          label: p.linked === false ? `${p.display_name} (no Telegram — told in the app)` : p.display_name,
        })),
      ]}
    />
  );
}

/**
 * A short-lived message after an action. Says what happened in plain words; errors stay
 * until dismissed, because a failure that disappears on its own has not been reported.
 */
export function Toast({
  message,
  tone,
  onDone,
}: {
  message: string | null;
  tone: "ok" | "crit";
  onDone: () => void;
}) {
  useEffect(() => {
    if (!message || tone === "crit") return;
    const t = setTimeout(onDone, 4000);
    return () => clearTimeout(t);
  }, [message, tone, onDone]);

  if (!message) return null;
  return (
    <div
      className={`flex items-start gap-3 rounded-lg border px-3 py-2 text-sm ${
        tone === "ok" ? "border-ok/40 bg-ok/10 text-ok" : "border-crit/40 bg-crit/10 text-crit"
      }`}
    >
      <span className="flex-1">{message}</span>
      <button onClick={onDone} className="text-xs opacity-70 hover:opacity-100" aria-label="Dismiss">
        ✕
      </button>
    </div>
  );
}

/** Wraps an action so a form reports its own outcome without every caller repeating it. */
export function useAction(): {
  busy: boolean;
  message: string | null;
  tone: "ok" | "crit";
  clear: () => void;
  run: (fn: () => Promise<string>) => Promise<boolean>;
} {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [tone, setTone] = useState<"ok" | "crit">("ok");

  async function run(fn: () => Promise<string>): Promise<boolean> {
    setBusy(true);
    setMessage(null);
    try {
      const ok = await fn();
      setTone("ok");
      setMessage(ok);
      return true;
    } catch (e) {
      setTone("crit");
      setMessage(e instanceof Error ? e.message : "That did not work.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  return { busy, message, tone, clear: () => setMessage(null), run };
}
