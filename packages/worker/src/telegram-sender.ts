import { loadConfig } from "@freshnow/core";
import { RateLimitError, type Deliverer } from "./outbox-relay.js";

/** Which Bot API method sends each kind of file, and what the file field is called. */
const FILE_METHODS: Record<string, { method: string; field: string }> = {
  document: { method: "sendDocument", field: "document" },
  photo: { method: "sendPhoto", field: "photo" },
  voice: { method: "sendVoice", field: "voice" },
  video: { method: "sendVideo", field: "video" },
  audio: { method: "sendAudio", field: "audio" },
};

interface OutboxPayload {
  kind?: string;
  text?: string;
  reply_markup?: unknown;
  // Attachment rows carry a Telegram file_id rather than any bytes: the same bot may
  // re-send a file it has already seen, so nothing is downloaded or stored locally.
  fileKind?: string;
  fileId?: string;
  caption?: string;
}

/**
 * The real Telegram delivery function used by the running worker. Not used in
 * tests (a stub deliverer is injected instead). Maps a 429 to RateLimitError so
 * the relay backs off rather than abandons.
 */
/**
 * How long one Telegram call may take. Generous enough for a file upload on a poor
 * connection, short enough that a black-holed socket cannot stall the whole worker.
 */
const SEND_TIMEOUT_MS = 20_000;

export function makeTelegramSender(): Deliverer {
  const c = loadConfig();
  const token = c.BOT_TOKEN;
  if (!token) {
    throw new Error("BOT_TOKEN not set — cannot deliver Telegram messages");
  }
  const base = `https://api.telegram.org/bot${token}`;

  return async ({ chatId, payload }) => {
    const p = payload as OutboxPayload;

    let method = "sendMessage";
    let body: Record<string, unknown>;

    if (p.kind === "attachment" && p.fileId) {
      const spec = FILE_METHODS[p.fileKind ?? "document"] ?? FILE_METHODS.document!;
      method = spec.method;
      body = { chat_id: chatId, [spec.field]: p.fileId, caption: p.caption?.slice(0, 1024) };
    } else {
      body = { chat_id: chatId, text: p.text ?? "", reply_markup: p.reply_markup };
    }

    // Node's fetch has NO default timeout, and this call runs inside the relay's open
    // transaction while holding `for update skip locked` row locks. Telegram refusing
    // connections is fine (fast error, backoff); Telegram or the wifi BLACK-HOLING packets
    // used to hang here forever, which held the transaction open and stopped the worker
    // loop dead — no further delivery, no SLA sweep, no project sweep. Found by audit
    // 2026-09-18; the LLM client already got this right.
    const res = await fetch(`${base}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    if (res.status === 429) {
      const j = (await res.json().catch(() => ({}))) as { parameters?: { retry_after?: number } };
      throw new RateLimitError("Telegram 429", j.parameters?.retry_after);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Telegram ${method} failed ${res.status}: ${text.slice(0, 200)}`);
    }
  };
}
