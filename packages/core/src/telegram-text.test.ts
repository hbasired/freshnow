import { describe, expect, it } from "vitest";
import { consentNotice } from "./consent.js";
import { TELEGRAM_TEXT_LIMIT, telegramParts } from "./telegram-text.js";

describe("cutting text into messages Telegram accepts", () => {
  it("leaves a message that fits alone", () => {
    expect(telegramParts("hello")).toEqual(["hello"]);
    expect(telegramParts("x".repeat(TELEGRAM_TEXT_LIMIT))).toHaveLength(1);
  });

  it("cuts between paragraphs, loses nothing but the blank lines at the cut, and every part fits", () => {
    const paragraph = (n: number) => `Section ${n}\n${"• a line of the notice.\n".repeat(60).trimEnd()}`;
    const text = Array.from({ length: 6 }, (_, i) => paragraph(i)).join("\n\n");
    const parts = telegramParts(text);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(TELEGRAM_TEXT_LIMIT);
    // Each part begins at a section: the cuts fell on paragraph breaks.
    for (const p of parts) expect(p.startsWith("Section ")).toBe(true);
    expect(parts.join("\n\n")).toBe(text);
  });

  it("falls back to a line break, then to a hard cut that never splits an emoji", () => {
    const lines = Array.from({ length: 400 }, (_, i) => `line ${i} ${"y".repeat(20)}`).join("\n");
    for (const p of telegramParts(lines)) expect(p.length).toBeLessThanOrEqual(TELEGRAM_TEXT_LIMIT);
    // One unbroken run of emoji: a cut at an odd offset would leave half a surrogate pair.
    const emoji = "📄".repeat(3000);
    const parts = telegramParts(emoji, 4095);
    for (const p of parts) {
      expect(p.length).toBeLessThanOrEqual(4095);
      // Half a pair would iterate as a lone surrogate, which is not "📄".
      expect([...p].every((ch) => ch === "📄")).toBe(true);
    }
    expect(parts.join("")).toBe(emoji);
  });

  it("the full notice, with every part switched on, goes in parts that Telegram accepts", () => {
    const everything = {
      BOT_TOKEN: "0:x",
      GROQ_API_KEY: "k",
      OPENROUTER_API_KEY: "k",
      NVIDIA_API_KEY: "k",
      VAPID_PUBLIC_KEY: "p",
      VAPID_PRIVATE_KEY: "q",
      VAPID_SUBJECT: "mailto:x@y.ae",
      SMTP_HOST: "smtp.example.ae",
      TELEVEND_USERNAME: "u",
      SUPABASE_URL: "http://127.0.0.1:54321",
      SUPABASE_SECRET_KEY: "s",
      APP_PIN_PEPPER: "p".repeat(40),
      MEDIA_RETENTION: "on",
      RETENTION_DAYS: "90",
    } as NodeJS.ProcessEnv;
    const text = `📄 FreshNow's privacy notice has changed.\n\n${consentNotice("en", everything)}`;
    expect(text.length).toBeGreaterThan(TELEGRAM_TEXT_LIMIT); // the reason this exists
    const parts = telegramParts(text);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(TELEGRAM_TEXT_LIMIT);
    // Every line of the notice arrives, in order — the cuts only drop blank lines.
    const lines = (s: string) => s.split("\n").filter((l) => l.trim() !== "");
    expect(lines(parts.join("\n"))).toEqual(lines(text));
  });
});
