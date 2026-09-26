import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { webhookCallback, type Bot } from "grammy";
import { logAudit } from "@freshnow/core";

/**
 * Webhook mode: Telegram pushes updates to us over HTTPS, instead of us polling.
 *
 * This is the production transport (DEVIATIONS #1) and it did not exist until 2026-09-18 —
 * `TELEGRAM_MODE` was validated by config and read by nothing, and the switch-back was
 * documented as a one-line change it was not. The audit called it out.
 *
 * ── The secret token is the whole security of this endpoint ─────────────────
 * The webhook URL is reachable by anyone who finds it. Telegram sends the
 * `X-Telegram-Bot-Api-Secret-Token` header on every delivery, set to the value we gave
 * `setWebhook`. Without checking it, anyone on the internet could POST a fabricated
 * "employee update" — CLAUDE.md lists this check as non-negotiable.
 *
 * The comparison is constant-time and happens HERE, before grammY sees a byte of the
 * body, so a rejection is ours and is audited. grammY's own `secretToken` option is passed
 * too, as a second lock behind the first.
 *
 * ── What this listener is and is not ─────────────────────────────────────────
 * A plain `node:http` server on a local port, meant to sit behind Caddy (TLS termination,
 * the public hostname). It answers exactly one path with exactly one method and nothing
 * else — no static files, no health page, nothing an attacker can use to fingerprint it.
 * It is deliberately not mounted in the Fastify API: the bot instance lives in this
 * package, and coupling the two processes for one route would mean the API restarting
 * every time the bot does.
 */

export interface WebhookOptions {
  bot: Bot<never>;
  secret: string;
  path: string;
  port: number;
  host?: string;
}

/** Constant-time equality on the header, so the secret cannot be recovered by timing. */
function secretMatches(header: string | string[] | undefined, expected: string): boolean {
  if (typeof header !== "string") return false;
  const a = Buffer.from(header, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

let rejected = 0;
let accepted = 0;

export function webhookStats(): { accepted: number; rejected: number } {
  return { accepted, rejected };
}

export function startWebhookServer(o: WebhookOptions): Server {
  // grammY does the body parsing and dispatch; "http" is its adapter for node:http.
  const handle = webhookCallback(o.bot, "http", { secretToken: o.secret });

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url?.split("?")[0] ?? "";
    if (req.method !== "POST" || url !== o.path) {
      // Say nothing useful. 404 for everything that is not the one route.
      res.writeHead(404).end();
      return;
    }

    if (!secretMatches(req.headers["x-telegram-bot-api-secret-token"], o.secret)) {
      rejected++;
      // Audited, but rate-limited by the audit itself being cheap: a flood of forged
      // requests is a flood of rows, which is still the right record to have.
      void logAudit({
        actor: "system",
        action: "webhook.rejected",
        entity: "telegram",
        entityId: "webhook",
        detail: {
          reason: "secret token missing or wrong",
          ip: req.socket.remoteAddress ?? null,
          // Never the token itself, wrong or right.
        },
      }).catch(() => undefined);
      res.writeHead(401).end();
      return;
    }

    accepted++;
    // grammY answers 200 once the update is accepted; handler errors are the bot's own
    // error boundary's business and must not turn into a 5xx that makes Telegram retry
    // the same update forever.
    void handle(req, res).catch((err) => {
      console.error("[bot] webhook handler error:", err);
      if (!res.headersSent) res.writeHead(200).end();
    });
  });

  server.listen(o.port, o.host ?? "127.0.0.1");
  return server;
}
