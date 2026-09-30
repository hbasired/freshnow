import { useEffect, useState } from "react";

/**
 * Whether a media query matches, kept current as the window changes.
 *
 * Used where the phone and the desktop need different ELEMENTS, not just different styles:
 * a table becomes cards, the sidebar becomes a tab bar. Hiding one copy with CSS would
 * still mount both — two inbox bells fetching the same notifications, two copies of every
 * form — so the layout that is not shown is not rendered at all.
 *
 * The first value is read synchronously, so the right layout is drawn on the first paint
 * rather than the desktop one flashing on a phone.
 */
export function useMedia(query: string): boolean {
  const [matches, setMatches] = useState(() => (typeof window !== "undefined" ? window.matchMedia(query).matches : false));
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setMatches(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [query]);
  return matches;
}

/** Tailwind's `lg` (1024 px): the sidebar layout from here up, the phone app below it. */
export const WIDE = "(min-width: 1024px)";
/** Tailwind's `sm` (640 px): below it, tables are shown as cards. */
export const NARROW = "(max-width: 639px)";
