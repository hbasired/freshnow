import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import Root from "./Root";
import { registerWorker } from "./lib/install";
import "./index.css";

// Before React renders: the browser's install offer can arrive at any moment after load, and
// it is only made at all once a service worker is running (lib/install.ts).
registerWorker();

// An update replaces the chunk files; a page loaded before it asks for names that are gone. Vite
// reports that with this event: reload once to get the new page. The flag stops a loop if the
// reload fails too (the portal's own boundary then offers a Reload button), and is cleared once the
// page has run for a while, so a later update is handled the same way.
const RELOADED = "fn.reloadedForUpdate";
window.addEventListener("vite:preloadError", (event) => {
  try {
    if (sessionStorage.getItem(RELOADED) === "1") return;
    sessionStorage.setItem(RELOADED, "1");
  } catch {
    return; // no storage: let the boundary offer the reload instead
  }
  event.preventDefault();
  location.reload();
});
setTimeout(() => {
  try {
    sessionStorage.removeItem(RELOADED);
  } catch {
    /* private mode */
  }
}, 15_000);

// Root decides between demo mode, sign-in, and the dashboard itself.
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
