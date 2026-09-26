import { useCallback, useEffect, useState } from "react";

/**
 * Light and dark, chosen by the person and remembered.
 *
 * The rule: an explicit choice always wins; with no choice, follow the operating system,
 * and keep following it if the person changes it while the page is open. A dashboard left
 * on a wall should go light when the office does, without anybody touching it.
 *
 * The attribute this writes (`data-theme` on <html>) is the only thing the CSS reads —
 * see `index.css`. A matching snippet runs in `index.html` BEFORE React mounts, so a
 * light-theme reload never flashes dark first.
 */

export type Theme = "light" | "dark";
export const THEME_KEY = "fn.theme";

/** What the OS is asking for. Defaults to dark, which is what this dashboard has always been. */
function systemTheme(): Theme {
  try {
    return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  } catch {
    return "dark";
  }
}

/** The stored choice, or null when the person has never expressed one. */
export function storedTheme(): Theme | null {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return v === "light" || v === "dark" ? v : null;
  } catch {
    // Private mode, or storage disabled. Following the system is a fine answer.
    return null;
  }
}

export function resolveTheme(): Theme {
  return storedTheme() ?? systemTheme();
}

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset["theme"] = theme;
}

/**
 * The theme, and a way to change it. Returns `following` so the UI can say whether it is
 * tracking the system or holding a choice — the difference matters when somebody wonders
 * why the page went light on its own.
 */
export function useTheme(): { theme: Theme; following: boolean; setTheme: (t: Theme) => void; followSystem: () => void } {
  const [theme, setThemeState] = useState<Theme>(() => resolveTheme());
  const [following, setFollowing] = useState<boolean>(() => storedTheme() === null);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  // While following the system, track it live rather than only at page load.
  useEffect(() => {
    if (!following) return;
    let mq: MediaQueryList;
    try {
      mq = window.matchMedia("(prefers-color-scheme: light)");
    } catch {
      return;
    }
    const onChange = (): void => setThemeState(systemTheme());
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [following]);

  const setTheme = useCallback((t: Theme) => {
    try {
      localStorage.setItem(THEME_KEY, t);
    } catch {
      /* the choice still applies for this page load */
    }
    setFollowing(false);
    setThemeState(t);
  }, []);

  const followSystem = useCallback(() => {
    try {
      localStorage.removeItem(THEME_KEY);
    } catch {
      /* nothing stored to remove */
    }
    setFollowing(true);
    setThemeState(systemTheme());
  }, []);

  return { theme, following, setTheme, followSystem };
}
