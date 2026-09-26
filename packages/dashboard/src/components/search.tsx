import { useEffect, useMemo, useRef, useState } from "react";
import type { Assignment, Blocker, Employee, OpenTask } from "../lib/api";
import { Icon } from "./icons";

/**
 * One search box over everything the board has already loaded — people, open tasks,
 * open blockers, assignments. Nothing is fetched: the data on screen is exactly what this
 * viewer may see, so the results are too. Picking a result jumps to the tab that shows it
 * (and opens the task when it is one). Keyboard: ↑ ↓ to move, Enter to open, Esc to close.
 */
export interface SearchHit {
  kind: "person" | "task" | "blocker" | "assignment";
  id: string;
  title: string;
  detail: string;
}

export function SearchBox({
  people,
  tasks,
  blockers,
  assignments,
  onPick,
}: {
  people: Employee[];
  tasks: OpenTask[];
  blockers: Blocker[];
  assignments: Assignment[];
  onPick: (hit: SearchHit) => void;
}) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(0);
  const box = useRef<HTMLDivElement>(null);

  const hits = useMemo<SearchHit[]>(() => {
    const needle = q.trim().toLowerCase();
    if (needle.length < 2) return [];
    const has = (...parts: (string | null | undefined)[]) => parts.some((p) => (p ?? "").toLowerCase().includes(needle));
    const out: SearchHit[] = [];
    for (const p of people) {
      if (has(p.display_name, p.department, p.role_title, p.site)) {
        out.push({ kind: "person", id: p.id, title: p.display_name, detail: [p.role_title, p.department].filter(Boolean).join(" · ") || "person" });
      }
    }
    for (const t of tasks) {
      if (has(t.title)) out.push({ kind: "task", id: t.id, title: t.title, detail: `task · ${t.status.replace("_", " ")}` });
    }
    for (const b of blockers) {
      if (b.status === "open" && has(b.category, b.affected_asset, b.raised_by_name)) {
        out.push({ kind: "blocker", id: b.id, title: `${b.severity ?? ""} ${b.category ?? "problem"}${b.affected_asset ? ` — ${b.affected_asset}` : ""}`.trim(), detail: `blocker · raised by ${b.raised_by_name}` });
      }
    }
    for (const a of assignments) {
      if (has(a.task_title, a.assigned_to, a.assigned_by)) {
        out.push({ kind: "assignment", id: a.id, title: a.task_title ?? "(untitled)", detail: `assignment · ${a.assigned_by} → ${a.assigned_to}` });
      }
    }
    return out.slice(0, 8);
  }, [q, people, tasks, blockers, assignments]);

  useEffect(() => setCursor(0), [q]);
  useEffect(() => {
    const close = (e: PointerEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, []);

  const pick = (h: SearchHit) => { onPick(h); setOpen(false); setQ(""); };
  const kindIcon = { person: Icon.user, task: Icon.clipboardCheck, blocker: Icon.alertCircle, assignment: Icon.pin } as const;

  return (
    <div ref={box} className="relative w-full max-w-xl">
      <label className="flex items-center gap-2 rounded-xl border border-edge bg-sunken px-3 py-2 text-sm focus-within:border-link">
        <span className="text-mut"><Icon.search size={16} /></span>
        <input
          value={q}
          onChange={(e) => { setQ(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") { e.preventDefault(); setCursor((c) => Math.min(c + 1, hits.length - 1)); }
            else if (e.key === "ArrowUp") { e.preventDefault(); setCursor((c) => Math.max(c - 1, 0)); }
            else if (e.key === "Enter" && hits[cursor]) { e.preventDefault(); pick(hits[cursor]!); }
            else if (e.key === "Escape") { setOpen(false); (e.target as HTMLInputElement).blur(); }
          }}
          placeholder="Search people, tasks, problems, assignments…"
          aria-label="Search"
          aria-expanded={open && hits.length > 0}
          aria-controls="search-results"
          role="combobox"
          className="w-full bg-transparent text-ink placeholder:text-mut focus:outline-none"
        />
        {q ? (
          <button onClick={() => setQ("")} className="text-mut hover:text-ink" aria-label="Clear search"><Icon.x size={14} /></button>
        ) : (
          <kbd className="hidden rounded border border-edge px-1.5 text-[10px] text-mut sm:inline">/</kbd>
        )}
      </label>
      {open && q.trim().length >= 2 ? (
        <ul
          id="search-results"
          role="listbox"
          className="absolute left-0 right-0 top-full z-30 mt-1 overflow-hidden rounded-xl border border-edge bg-panel shadow-xl"
        >
          {hits.length === 0 ? (
            <li className="px-3 py-2 text-sm text-mut">Nothing matches "{q.trim()}" in what you can see.</li>
          ) : (
            hits.map((h, i) => {
              const I = kindIcon[h.kind];
              return (
                <li
                  key={`${h.kind}:${h.id}`}
                  role="option"
                  aria-selected={i === cursor}
                  onPointerEnter={() => setCursor(i)}
                  onClick={() => pick(h)}
                  className={`flex cursor-pointer items-center gap-3 px-3 py-2 text-sm ${i === cursor ? "bg-sunken" : ""}`}
                >
                  <span className="text-mut"><I size={16} /></span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-ink">{h.title}</span>
                    <span className="block truncate text-xs text-mut">{h.detail}</span>
                  </span>
                  <span className="text-mut"><Icon.arrowRight size={14} /></span>
                </li>
              );
            })
          )}
        </ul>
      ) : null}
    </div>
  );
}
