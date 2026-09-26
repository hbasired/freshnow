import "dotenv/config";
import { loadConfig } from "@freshnow/core";
import { run } from "@grammyjs/runner";
import { llmSemaphore } from "@freshnow/core";
import { createBot } from "./bot.js";
import { startWebhookServer } from "./webhook.js";

const config = loadConfig();
if (!config.BOT_TOKEN) throw new Error("BOT_TOKEN is required to start the bot");

const bot = createBot({ token: config.BOT_TOKEN, ceoUserId: config.CEO_TELEGRAM_USER_ID });
// A thrown handler must never leave the person staring at silence. They cannot tell the
// difference between "it crashed" and "it ignored me", and the second makes them stop
// trusting the tool. Tell them, and log the correlation-free error loudly for us.
bot.catch(async (err) => {
  console.error("[bot] runtime error:", err.error);
  try {
    await err.ctx.reply(
      "⚠️ Something went wrong handling that — it was not your fault and nothing was lost.\n" +
        "Please try again, or send /cancel to start over.",
    );
  } catch (replyErr) {
    console.error("[bot] could not even tell the user:", replyErr);
  }
});

if (config.CEO_TELEGRAM_USER_ID == null) {
  console.warn(
    "[bot] CEO_TELEGRAM_USER_ID is not set — everyone resolves to role 'employee'. " +
      "Send /start from the CEO's account, then put the id it replies with in .env.",
  );
}

/**
 * Retry a transient network call with exponential backoff.
 * Observed live: a single ECONNRESET on deleteWebhook killed the process at startup.
 * A momentary blip must not take the bot down.
 */
async function withRetry<T>(label: string, fn: () => Promise<T>, attempts = 5): Promise<T | null> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (attempt === attempts) {
        console.error(`[bot] ${label} failed after ${attempts} attempts: ${message}`);
        return null;
      }
      const waitMs = Math.min(1000 * 2 ** (attempt - 1), 15_000);
      console.warn(`[bot] ${label} failed (${attempt}/${attempts}): ${message}. Retrying in ${waitMs}ms`);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
  return null;
}

// Register the command menu so the commands appear in Telegram's ☰ menu rather
// than having to be remembered and typed.
await withRetry("setMyCommands", () =>
  bot.api.setMyCommands([
    { command: "start", description: "Open my menu" },
    // First after /start on purpose: reporting your day is the thing people do daily,
    // and menu-diving to reach it is a barrier for exactly whoever most needs it.
    { command: "log", description: "Report my task status now" },
    { command: "help", description: "How to use this bot" },
    { command: "invite", description: "CEO: create an invite code" },
    { command: "blockers", description: "CEO: open problems" },
    { command: "eod", description: "End-of-day report" },
    { command: "assign", description: "CEO: assign a task" },
    { command: "cancel", description: "Stop what I was doing" },
    { command: "whoami", description: "Show my id and role" },
  ]),
);

// ── Transport: webhook in production, long polling for the local demo ────────
if (config.TELEGRAM_MODE === "webhook") {
  // Fail CLOSED. A webhook listener without a secret would accept fabricated employee
  // updates from anyone who found the URL; a listener Telegram was never told about
  // would accept nothing at all and look like a silent outage. Both are refused here.
  if (!config.TELEGRAM_WEBHOOK_SECRET || config.TELEGRAM_WEBHOOK_SECRET.length < 16) {
    throw new Error("TELEGRAM_MODE=webhook requires TELEGRAM_WEBHOOK_SECRET of at least 16 characters");
  }
  if (!config.PUBLIC_URL) {
    throw new Error("TELEGRAM_MODE=webhook requires PUBLIC_URL (the public HTTPS origin Telegram will call)");
  }
  const url = new URL(config.TELEGRAM_WEBHOOK_PATH, config.PUBLIC_URL).toString();
  if (!url.startsWith("https://")) {
    throw new Error(`Telegram only delivers webhooks over HTTPS; PUBLIC_URL is ${config.PUBLIC_URL}`);
  }

  const server = startWebhookServer({
    bot: bot as never,
    secret: config.TELEGRAM_WEBHOOK_SECRET,
    path: config.TELEGRAM_WEBHOOK_PATH,
    port: config.TELEGRAM_WEBHOOK_PORT,
  });

  // Tell Telegram where to deliver and what secret to send. `drop_pending_updates` is
  // false on purpose: updates that arrived while we were down are still wanted.
  await withRetry("setWebhook", () =>
    bot.api.setWebhook(url, {
      secret_token: config.TELEGRAM_WEBHOOK_SECRET,
      allowed_updates: [],
      drop_pending_updates: false,
    }),
  );
  const me = await withRetry("getMe", () => bot.api.getMe());
  console.log(
    `[bot] @${me?.username ?? "freshnow"} webhook mode — listening on 127.0.0.1:${config.TELEGRAM_WEBHOOK_PORT}` +
      `${config.TELEGRAM_WEBHOOK_PATH}, registered as ${url} (secret-token verified, ${llmSemaphore.limit} concurrent model calls)`,
  );

  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.once(sig, () => {
      console.log(`[bot] ${sig} — closing the webhook listener…`);
      server.close();
    });
  }
  process.on("unhandledRejection", (reason) => {
    console.error("[bot] unhandled rejection (staying up):", reason);
  });
  // Keep the process alive on the server; nothing else to await.
  await new Promise<void>((resolve) => server.once("close", resolve));
  process.exit(0);
}

// Local demo uses long polling, so clear any webhook first (gotcha G3). If this
// call cannot be made we continue anyway: getWebhookInfo showed no webhook set,
// and polling will surface a real conflict loudly if one ever exists.
await withRetry("deleteWebhook", () => bot.api.deleteWebhook());

// ── Concurrency ──────────────────────────────────────────────────────────────
//
// `bot.start()` processes updates ONE AT A TIME. Every handler here can make a model
// call taking 1-4 seconds, so ten employees reporting at the end of a shift would queue
// behind each other and the tenth would wait the better part of a minute — for a bot
// whose whole purpose is that reporting is quick.
//
// The grammY runner pulls and processes updates concurrently. `sequentialize` keyed by
// CHAT means updates from the SAME person are still handled in order, which this system
// needs: conversation state lives in one `bot_session` row per chat, and two concurrent
// handlers would read it, both act on the stale step, and the last write would win —
// losing a half-finished registration or double-creating tasks from one document.
//
// Different people run in parallel; one person runs in order. The real ceiling is not
// here but at the model, capped by `llmSemaphore` in core (LLM_CONCURRENCY per process, default 2), so a burst
// becomes a short queue rather than a wall of provider 429s.
const runner = run(bot, {
  runner: { fetch: { allowed_updates: [] } },
  // Well below the runner's default of 500: this box has 8 vCPU shared with Postgres,
  // Redis and the worker, and admitting more work than can be served only converts a
  // queue into memory pressure.
  sink: { concurrency: 50 },
});

// getMe is only for the log line, so it must never be able to kill startup. Calling it
// unwrapped did exactly that: a single ECONNRESET — routine on this link — took the
// process down before it ever polled.
const me = await withRetry("getMe", () => bot.api.getMe());
console.log(
  `[bot] @${me?.username ?? "freshnow"} polling concurrently ` +
    `(sink 50, per-chat sequential, ${llmSemaphore.limit} concurrent model calls)`,
);

// Stop cleanly so in-flight updates finish and their offsets are confirmed, rather than
// being redelivered or silently dropped on the next start.
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.once(sig, () => {
    console.log(`[bot] ${sig} — draining in-flight updates…`);
    void runner.stop();
  });
}

// A transient network fault must never take the bot down silently. This link drops
// connections routinely, and an unhandled rejection would exit the process with the
// employees' next messages left unanswered and nobody told why.
process.on("unhandledRejection", (reason) => {
  console.error("[bot] unhandled rejection (staying up):", reason);
});

try {
  await runner.task();
} catch (err) {
  console.error("[bot] runner stopped:", err);
  process.exitCode = 1;
}
