import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import Root from "./Root";
import { registerWorker } from "./lib/install";
import "./index.css";

// Before React renders: the browser's install offer can arrive at any moment after load, and
// it is only made at all once a service worker is running (lib/install.ts).
registerWorker();

// Root decides between demo mode, sign-in, and the dashboard itself.
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
