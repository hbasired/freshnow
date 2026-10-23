/**
 * Telegram refuses a message longer than 4096 characters ("message is too long") — permanently, so
 * a retry never helps. Privacy notice 3.0 (consent.ts) is longer than that once every part is
 * switched on, and a consent request that can never be delivered would leave everyone on Telegram
 * unable to agree. Both senders — the worker's outbox relay and the bot's own replies — cut long
 * text with this one rule.
 */
export const TELEGRAM_TEXT_LIMIT = 4096;

/**
 * Text cut into messages Telegram accepts: at a blank line between paragraphs where one falls in
 * the second half of a message, else at a line break, and only as a last resort mid-line — never
 * through an emoji (a UTF-16 surrogate pair). JavaScript counts UTF-16 units, which is never fewer
 * than Telegram counts, so a part that fits here fits there. Bounded: every pass takes at least half
 * a message off the rest.
 */
export function telegramParts(text: string, limit: number = TELEGRAM_TEXT_LIMIT): string[] {
  if (text.length <= limit) return [text];
  const parts: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    let cut = window.lastIndexOf("\n\n");
    if (cut < limit / 2) cut = window.lastIndexOf("\n");
    if (cut < limit / 2) {
      cut = limit;
      const c = rest.charCodeAt(cut - 1);
      if (c >= 0xd800 && c <= 0xdbff) cut -= 1;
    }
    parts.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).replace(/^\n+/, "");
  }
  if (rest.length > 0) parts.push(rest);
  return parts;
}
