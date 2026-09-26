import { useTheme } from "../lib/theme";

/**
 * Light / dark, with a third state that matters: "following the system".
 *
 * Three buttons rather than one switch, because a two-state toggle cannot express the
 * difference between "I chose dark" and "it is dark because my laptop is" — and somebody
 * whose dashboard turns light on its own at sunset deserves to be able to see why, and
 * to stop it.
 */
export function ThemeToggle({ compact = false }: { compact?: boolean }) {
  const { theme, following, setTheme, followSystem } = useTheme();

  const options = [
    { id: "light" as const, icon: "☀️", label: "Light", on: !following && theme === "light", act: () => setTheme("light") },
    { id: "dark" as const, icon: "🌙", label: "Dark", on: !following && theme === "dark", act: () => setTheme("dark") },
    { id: "auto" as const, icon: "🖥️", label: "Auto", on: following, act: followSystem },
  ];

  return (
    <div
      className="flex rounded-lg border border-edge bg-sunken p-0.5 text-sm"
      role="group"
      aria-label="Colour theme"
    >
      {options.map((o) => (
        <button
          key={o.id}
          onClick={o.act}
          aria-pressed={o.on}
          title={o.id === "auto" ? `Follow the system (currently ${theme})` : `${o.label} theme`}
          className={`rounded-md px-2 py-1 ${o.on ? "bg-ok/15 font-semibold text-ok" : "text-mut hover:text-ink"}`}
        >
          <span aria-hidden="true">{o.icon}</span>
          {compact ? <span className="sr-only">{o.label}</span> : <span className="ml-1 hidden sm:inline">{o.label}</span>}
        </button>
      ))}
    </div>
  );
}
