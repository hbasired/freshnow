/**
 * FreshNow service worker — notifications only.
 *
 * There is deliberately NO offline cache here. A cached operations board is a board showing
 * yesterday's problems as if they were today's, and this system's whole premise is that a
 * number on screen is a count from the database. The same argument the API makes for not
 * caching `index.html` (api/src/routes/app-shell.ts) applies with more force to the data.
 * So this worker exists for one reason: to be running when a push arrives.
 *
 * Served at /app/sw.js, so its scope is /app/ — exactly the app, nothing else on the host.
 */

// Take over as soon as a new version is installed, rather than waiting for every tab to
// close. A stale notification handler is the one kind of staleness that matters here.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

// Page loads go straight to the network — no cache, exactly as if there were no worker.
// The handler exists because Chromium browsers only treat a site as an installable app (an
// app icon and an "Install app" offer, not a bookmark) when its service worker handles
// `fetch`. Only page navigations are touched: data calls, the live stream and sign-in return
// here without `respondWith`, so the browser handles them as it always did.
self.addEventListener("fetch", (event) => {
  if (event.request.mode !== "navigate") return;
  event.respondWith(fetch(event.request));
});

self.addEventListener("push", (event) => {
  // The payload is encrypted end to end (RFC 8291): the push relay — Google, Apple or
  // Mozilla — carried this as ciphertext and could not read it. This is the first point at
  // which it is plaintext, on the recipient's own device.
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: "FreshNow", body: event.data ? event.data.text() : "" };
  }

  const title = data.title || "FreshNow";
  const options = {
    body: data.body || "",
    icon: "/app/icon-192.png",
    badge: "/app/icon-192.png",
    // Same tag collapses repeats of the same problem into one notification rather than
    // stacking five identical banners — the same idea as the alert table's alias dedup.
    tag: data.tag || undefined,
    // With a tag, a repeat silently replaces the old banner unless renotify is set — so an
    // escalation of a problem the person already saw would update the text without a
    // sound. It must buzz. (Chrome rejects renotify without a tag, hence the guard.)
    renotify: Boolean(data.tag),
    data: { url: data.url || "/app/" },
    // A blocker should survive the screen being glanced at and ignored.
    requireInteraction: data.urgent === true,
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || "/app/";
  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      // Focus a tab that is already open rather than opening a second copy of the board.
      for (const client of all) {
        if (client.url.includes("/app/") && "focus" in client) {
          await client.focus();
          if ("navigate" in client) await client.navigate(target).catch(() => {});
          return;
        }
      }
      await self.clients.openWindow(target);
    })(),
  );
});
