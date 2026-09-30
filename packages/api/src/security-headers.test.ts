import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb } from "@freshnow/core";
import { dashboardDist, registerAppShell } from "./routes/app-shell.js";
import { inlineScriptHashes } from "./security-headers.js";
import { buildServer } from "./server.js";

/**
 * Browser-side defence (TASK-051): the headers every response carries, per the OWASP HTTP
 * Security Response Headers cheat sheet, and a Content-Security-Policy that allows the app's
 * own scripts and nothing injected.
 */

const app = buildServer(false);
const built = existsSync(join(dashboardDist(), "index.html"));

beforeAll(async () => {
  if (built) await registerAppShell(app);
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await closeDb();
});

describe("every response", () => {
  it("carries the baseline headers", async () => {
    const r = await app.inject({ method: "GET", url: "/health" });
    expect(r.headers).toMatchObject({
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "referrer-policy": "no-referrer",
      "cross-origin-opener-policy": "same-origin",
      "cross-origin-resource-policy": "same-origin",
    });
    expect(String(r.headers["permissions-policy"])).toContain("camera=()");
  });

  it("JSON is data: nothing may load from it or frame it, and it is never cached", async () => {
    const r = await app.inject({ method: "GET", url: "/health" });
    expect(r.headers["content-security-policy"]).toBe("default-src 'none'; frame-ancestors 'none'");
    expect(r.headers["cache-control"]).toBe("no-store");
  });

  it("HSTS only when the request arrived over HTTPS (tunnel or Caddy), never on the plain-HTTP Wi-Fi address", async () => {
    expect((await app.inject({ method: "GET", url: "/health" })).headers["strict-transport-security"]).toBeUndefined();
    const https = await app.inject({ method: "GET", url: "/health", headers: { "x-forwarded-proto": "https" } });
    expect(https.headers["strict-transport-security"]).toMatch(/^max-age=\d+/);
  });
});

describe("the CSP hash of an inline script", () => {
  it("matches the value published for the classic example", () => {
    // The CSP specification's example: <script>alert('Hello, world.');</script>
    expect(inlineScriptHashes("<script>alert('Hello, world.');</script>")).toEqual([
      "'sha256-qznLcsROx4GACP2dm0UCKCzCG+HiZ1guq6ZZDob/Tng='",
    ]);
  });

  it("ignores scripts loaded from a file (they are allowed by origin, not by hash)", () => {
    expect(inlineScriptHashes('<script type="module" src="/app/assets/x.js"></script>')).toEqual([]);
  });
});

describe.skipIf(!built)("the React app's page", () => {
  it("allows its own scripts and the one inline theme script — no 'unsafe-inline', no framing, no other hosts", async () => {
    const r = await app.inject({ method: "GET", url: "/app/" });
    expect(r.statusCode).toBe(200);
    const csp = String(r.headers["content-security-policy"]);
    const directive = (name: string) => csp.split(";").map((d) => d.trim()).find((d) => d.startsWith(`${name} `)) ?? "";
    expect(directive("script-src")).toMatch(/^script-src 'self' 'sha256-[A-Za-z0-9+/=]+'$/);
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).not.toContain("unsafe-eval");
    expect(directive("frame-ancestors")).toBe("frame-ancestors 'none'");
    expect(directive("object-src")).toBe("object-src 'none'");
    expect(directive("connect-src")).toBe("connect-src 'self'");
    // The hash is of the script that is actually in the built page.
    const html = readFileSync(join(dashboardDist(), "index.html"), "utf8");
    expect(directive("script-src")).toContain(inlineScriptHashes(html)[0]!);
  });
});
