import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type { FastifyInstance, FastifyRequest } from "fastify";

/**
 * Browser-side defence: response headers that tell the phone's browser what this app is
 * allowed to do, so that one bug (a note rendered as HTML, a poisoned file name) cannot
 * become "run an attacker's script with the CEO's session".
 *
 * Follows the OWASP HTTP Security Response Headers cheat sheet. No npm package (helmet):
 * the whole policy is a dozen strings, and writing it out keeps every choice reviewable.
 *
 * Content-Security-Policy for the React app is the strict one:
 *   - scripts only from this origin, plus the ONE inline script in index.html (the theme
 *     picker that must run before first paint), allowed by its SHA-256 hash, not by
 *     'unsafe-inline' — any other inline or injected script is refused by the browser;
 *   - network calls only to this origin (and the Supabase origin when it is not proxied),
 *     so an injected script could not send data anywhere else even if it ran;
 *   - no plugins, no <base> rewriting, no framing by another site (clickjacking).
 * The old hand-written page at `/` (only served when sign-in is off, i.e. never in
 * production) uses inline handlers, so it gets a looser policy that still pins every
 * network call to this origin.
 *
 * Deliberately NOT sent: `upgrade-insecure-requests` (the office-Wi-Fi demo is plain HTTP;
 * the directive would send every asset to an https port that does not exist) and
 * Cross-Origin-Embedder-Policy (nothing here needs cross-origin isolation, and it breaks
 * more than it protects for this app).
 */

const BASE_HEADERS: Record<string, string> = {
  // Never guess a content type: an uploaded "image" must not be run as a script.
  "x-content-type-options": "nosniff",
  // Links out of the app carry no URL — task and document ids stay here.
  "referrer-policy": "no-referrer",
  // Older browsers' clickjacking guard; CSP frame-ancestors is the modern one.
  "x-frame-options": "DENY",
  // Features the app never uses, switched off so an injected script cannot ask for them.
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=(), hid=()",
  // A page opened from the app (or that opened it) cannot reach into its window.
  "cross-origin-opener-policy": "same-origin",
  // Another site cannot embed our responses (images, JSON) in its pages.
  "cross-origin-resource-policy": "same-origin",
};

/** Every inline <script> in an HTML file, as CSP hash sources ('sha256-…'). */
export function inlineScriptHashes(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<script\b(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script>/gi)) {
    const body = m[1] ?? "";
    if (body.trim()) out.push(`'sha256-${createHash("sha256").update(body, "utf8").digest("base64")}'`);
  }
  return out;
}

export function appCsp(p: { scriptHashes: string[]; connectExtra?: string[] }): string {
  return [
    "default-src 'self'",
    `script-src 'self' ${p.scriptHashes.join(" ")}`.trim(),
    "style-src 'self'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src 'self' ${(p.connectExtra ?? []).join(" ")}`.trim(),
    "worker-src 'self'",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

/** The legacy page at `/` has inline handlers; it keeps them, but cannot talk to anyone else. */
export const LEGACY_PAGE_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

/** JSON is data, never a document: nothing may load from or frame it (OWASP REST cheat sheet). */
export const API_CSP = "default-src 'none'; frame-ancestors 'none'";

/** HTTPS reached us through a proxy (Cloudflare tunnel, Caddy) — only then does HSTS mean anything. */
function viaHttps(req: FastifyRequest): boolean {
  const proto = req.headers["x-forwarded-proto"];
  if (typeof proto === "string" && proto.split(",")[0]?.trim() === "https") return true;
  const visitor = req.headers["cf-visitor"];
  return typeof visitor === "string" && visitor.includes('"https"');
}

export function registerSecurityHeaders(
  app: FastifyInstance,
  opts: { appIndexHtml?: string; supabaseOrigin?: string | null } = {},
): void {
  let hashes: string[] = [];
  if (opts.appIndexHtml && existsSync(opts.appIndexHtml)) hashes = inlineScriptHashes(readFileSync(opts.appIndexHtml, "utf8"));
  const connectExtra = opts.supabaseOrigin ? [opts.supabaseOrigin] : [];
  const app_csp = appCsp({ scriptHashes: hashes, connectExtra });

  app.addHook("onSend", async (req, reply, payload) => {
    for (const [k, v] of Object.entries(BASE_HEADERS)) if (!reply.hasHeader(k)) reply.header(k, v);
    if (viaHttps(req)) reply.header("strict-transport-security", "max-age=31536000");

    const type = String(reply.getHeader("content-type") ?? "");
    if (type.startsWith("text/html")) {
      reply.header("content-security-policy", req.url.startsWith("/app") ? app_csp : LEGACY_PAGE_CSP);
    } else if (type.startsWith("application/json")) {
      reply.header("content-security-policy", API_CSP);
      // Personal data: never kept in the browser's or a proxy's cache.
      if (!reply.hasHeader("cache-control")) reply.header("cache-control", "no-store");
    }
    return payload;
  });
}
