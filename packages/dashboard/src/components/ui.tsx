import { useState, type KeyboardEvent, type ReactNode } from "react";

/** Small shared primitives. Deliberately plain — this is a dashboard, not a design system. */

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={`rounded-xl border border-edge bg-panel p-4 ${className}`}>{children}</div>
  );
}

export function Pill({ children, tone = "mut" }: { children: ReactNode; tone?: "mut" | "ok" | "warn" | "crit" }) {
  const tones = {
    mut: "border-edge text-mut",
    ok: "border-ok/40 text-ok",
    warn: "border-warn/40 text-warn",
    crit: "border-crit/40 text-crit",
  } as const;
  return (
    <span className={`inline-block whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] ${tones[tone]}`}>
      {children}
    </span>
  );
}

/** Severity carries meaning, so it gets a fixed colour rather than a generic pill. */
export function Severity({ value }: { value: string | null }) {
  if (!value) return <span className="text-mut">—</span>;
  const map: Record<string, string> = {
    critical: "bg-crit-bg text-crit-fg",
    high: "bg-high-bg text-high-fg",
    medium: "bg-med-bg text-med-fg",
    low: "bg-sunken text-mut",
  };
  return (
    <span className={`rounded px-1.5 py-0.5 text-[10px] font-extrabold uppercase tracking-wide ${map[value] ?? map.low}`}>
      {value}
    </span>
  );
}

export function Demo({ on }: { on: boolean }) {
  if (!on) return null;
  return (
    <span className="ml-1 rounded border border-demo-edge bg-high-bg px-1 text-[10px] text-warn">DEMO</span>
  );
}

/** Age is what turns a pending task into a problem, so it is coloured by age. */
export function Age({ days }: { days: number }) {
  const tone = days >= 3 ? "text-crit" : days >= 1 ? "text-warn" : "text-mut";
  return <span className={`font-bold ${tone}`}>{days}d</span>;
}

export function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-edge p-5 text-center text-sm text-mut">
      {children}
    </div>
  );
}

export function Spinner({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 p-4 text-sm text-mut">
      <span className="inline-block size-3 animate-spin rounded-full border-2 border-edge border-t-link" />
      {label}
    </div>
  );
}

export interface Column<T> {
  head: string;
  cell: (row: T) => ReactNode;
  /** Narrow columns stay narrow on a phone. */
  tight?: boolean;
}

/**
 * A table whose rows can expand to show what the person actually wrote.
 *
 * The exact words are the point of this system — a status board that shows only a status
 * hides the thing the CEO needs. `detail` returns null when a row has nothing more.
 */
export function DataTable<T>({
  rows,
  columns,
  empty,
  detail,
  rowKey,
}: {
  rows: T[];
  columns: Column<T>[];
  empty: string;
  detail?: (row: T) => ReactNode | null;
  rowKey: (row: T) => string;
}) {
  if (rows.length === 0) return <Empty>{empty}</Empty>;
  return (
    <div className="overflow-x-auto rounded-lg border border-edge">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr>
            {columns.map((c) => (
              <th
                key={c.head}
                className="sticky top-0 border-b border-edge bg-sunken px-3 py-2 text-left text-[10px] font-medium uppercase tracking-wider text-mut"
              >
                {c.head}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const d = detail?.(r) ?? null;
            return (
              <Row key={rowKey(r)} row={r} columns={columns} detail={d} />
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * A row, plus its detail line when it has one.
 *
 * The disclosure actually works. It previously rendered a ▸ marker and `cursor-pointer`
 * over a permanently-expanded detail row with no handler behind it — an affordance that
 * promised something the component could not do. Detail now starts open (nothing is
 * hidden by default, which is what the boards relied on) and the marker collapses it.
 */
function Row<T>({ row, columns, detail }: { row: T; columns: Column<T>[]; detail: ReactNode | null }) {
  const [open, setOpen] = useState(true);
  const toggle = (): void => {
    if (detail) setOpen((o) => !o);
  };
  return (
    <>
      <tr
        className={detail ? "cursor-pointer hover:bg-panel" : ""}
        onClick={toggle}
        {...(detail
          ? {
              role: "button",
              tabIndex: 0,
              "aria-expanded": open,
              onKeyDown: (e: KeyboardEvent<HTMLTableRowElement>) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  toggle();
                }
              },
            }
          : {})}
      >
        {columns.map((c, i) => (
          <td key={c.head} className="border-b border-edge px-3 py-2 align-top">
            {i === 0 && detail ? (
              <span className="mr-1 inline-block text-mut" aria-hidden="true">{open ? "▾" : "▸"}</span>
            ) : null}
            {c.cell(row)}
          </td>
        ))}
      </tr>
      {detail && open ? (
        <tr>
          <td colSpan={columns.length} className="border-b border-edge px-3 pb-3">
            {detail}
          </td>
        </tr>
      ) : null}
    </>
  );
}

/** Their exact words, presented as a quote rather than as a field. */
export function Words({ text, read }: { text: string; read?: string | null }) {
  return (
    <div>
      <div className="whitespace-pre-wrap break-words rounded bg-well px-3 py-2 text-sm">{text}</div>
      {read ? <div className="mt-1 text-xs text-mut">read as: {read}</div> : null}
    </div>
  );
}
