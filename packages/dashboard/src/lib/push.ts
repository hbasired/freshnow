import { api } from "./api";
import { isIos, isStandalone } from "./install";

/**
 * Turning this device's notifications on and off.
 *
 * Three things have to be true and each fails differently, so each gets its own message
 * rather than one "notifications unavailable":
 *
 *   1. A SECURE CONTEXT. Service workers only run on https:// or http://localhost — by
 *      browser design, not by our choice. On a LAN address there is nothing to enable, and
 *      saying so is more useful than a button that does nothing.
 *   2. The server has VAPID keys (`vapidPublicKey` from /app-config).
 *   3. The person grants permission — asked on an explicit tap, never on load. A prompt
 *      nobody asked for is the fastest way to have notifications blocked forever.
 *
 * On iPhone there is a fourth: the page must be added to the Home Screen first, or the
 * push manager is not there at all. That is Apple's rule and the UI says so plainly.
 */

export type PushState =
  | { kind: "insecure" }
  | { kind: "unsupported" }
  | { kind: "ios-needs-install" }
  | { kind: "not-configured" }
  | { kind: "denied" }
  | { kind: "off" }
  | { kind: "on" };


/** Base64url → the Uint8Array `applicationServerKey` wants. */
function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padded = (base64 + "=".repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(padded);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export async function pushState(vapidPublicKey: string | null): Promise<PushState> {
  if (!window.isSecureContext) return { kind: "insecure" };
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    return isIos() && !isStandalone() ? { kind: "ios-needs-install" } : { kind: "unsupported" };
  }
  if (!vapidPublicKey) return { kind: "not-configured" };
  if (Notification.permission === "denied") return { kind: "denied" };
  const reg = await navigator.serviceWorker.getRegistration("/app/");
  const sub = await reg?.pushManager.getSubscription();
  return sub ? { kind: "on" } : { kind: "off" };
}

/** Register the worker, ask, subscribe, and tell the server. Called from a click handler. */
export async function enablePush(viewer: string, vapidPublicKey: string): Promise<PushState> {
  const reg = await navigator.serviceWorker.register("/app/sw.js", { scope: "/app/" });
  await navigator.serviceWorker.ready;
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return permission === "denied" ? { kind: "denied" } : { kind: "off" };

  const sub =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({
      // Required by every browser: a push must always show something. We never send a
      // silent one, so this costs nothing and is what iOS insists on.
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapidPublicKey) as BufferSource,
    }));

  const json = sub.toJSON() as { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
  if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) throw new Error("The browser returned an incomplete subscription.");
  await api.subscribePush(viewer, {
    endpoint: json.endpoint,
    keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
    userAgent: navigator.userAgent.slice(0, 300),
  });
  return { kind: "on" };
}

/** Unsubscribe here and forget the device on the server. */
export async function disablePush(viewer: string): Promise<PushState> {
  const reg = await navigator.serviceWorker.getRegistration("/app/");
  const sub = await reg?.pushManager.getSubscription();
  if (sub) {
    const endpoint = sub.endpoint;
    await sub.unsubscribe().catch(() => {});
    await api.unsubscribePush(viewer, endpoint).catch(() => {});
  }
  return { kind: "off" };
}
