/**
 * Installing FreshNow as an app on a phone or computer — and making that visible.
 *
 * Two findings from the first real phone (28 Sept):
 *   1. There was no "Install app" to find. Chromium browsers only treat a site as an app —
 *      a real app icon and an install offer, rather than a bookmark — once a service worker
 *      with a fetch handler is running. Ours was registered only when someone turned
 *      notifications on, i.e. after the step people were looking for. It is now registered on
 *      load (`registerWorker`, called from main.tsx).
 *   2. Browser menus differ (Brave's is at the bottom, Samsung Internet calls it "Add page to").
 *      So when the browser says the app can be installed (`beforeinstallprompt`, Chromium
 *      only), the dashboard offers its own button. Where that event does not exist — iPhone,
 *      Firefox, some Chromium forks — it says where the browser keeps the option instead.
 *
 * UNVERIFIED on a real device: whether each Android browser fires `beforeinstallprompt`
 * for this site. The fallback text covers the ones that do not.
 */

interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

export type InstallState =
  | "installed" // running as the installed app
  | "available" // the browser handed us its install prompt: show a button
  | "ios" // iPhone/iPad: only Share → Add to Home Screen exists
  | "menu" // no prompt from this browser (yet): point at its menu
  | "insecure"; // plain http — nothing can be installed

let deferred: InstallPromptEvent | null = null;
let installedNow = false;
const listeners = new Set<() => void>();
const notify = (): void => listeners.forEach((f) => f());

export const isIos = (): boolean => /iPad|iPhone|iPod/.test(navigator.userAgent);
export const isStandalone = (): boolean =>
  window.matchMedia("(display-mode: standalone)").matches ||
  (navigator as unknown as { standalone?: boolean }).standalone === true;

/**
 * Listen from the very start: the browser fires this once, often before any card that could
 * show a button has rendered. `preventDefault` keeps the event for our button instead of the
 * browser's own one-off banner, which is easy to swipe away and does not come back.
 */
if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferred = e as InstallPromptEvent;
    notify();
  });
  window.addEventListener("appinstalled", () => {
    deferred = null;
    installedNow = true;
    notify();
  });
}

/**
 * Register the service worker on load. It adds no cache (see public/sw.js) — it exists so a
 * push can be shown with the app closed, and so the browser treats the site as installable.
 * Only on a secure page: elsewhere the browser refuses, and the device card explains why.
 */
export function registerWorker(): void {
  if (!("serviceWorker" in navigator) || !window.isSecureContext) return;
  void navigator.serviceWorker.register("/app/sw.js", { scope: "/app/" }).catch(() => {
    /* the device card reports what is possible; a failed registration is not an error to show here */
  });
}

export function installState(): InstallState {
  if (installedNow || isStandalone()) return "installed";
  if (!window.isSecureContext) return "insecure";
  if (deferred) return "available";
  return isIos() ? "ios" : "menu";
}

/** Show the browser's install dialog. True when the person accepted. */
export async function promptInstall(): Promise<boolean> {
  const e = deferred;
  if (!e) return false;
  deferred = null; // a prompt can be used once
  await e.prompt();
  const { outcome } = await e.userChoice;
  notify();
  return outcome === "accepted";
}

export function onInstallChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
