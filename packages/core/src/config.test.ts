import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

// A test written against the CONTRACT (what config should do), not the
// implementation. See HONESTY-AND-ACCURACY.md.
const base = {
  DATABASE_URL: "postgresql://freshnow:pw@localhost:5432/freshnow",
} satisfies NodeJS.ProcessEnv;

describe("loadConfig", () => {
  it("parses a minimal valid environment and applies defaults", () => {
    const cfg = loadConfig({ ...base });
    expect(cfg.REDIS_URL).toBe("redis://localhost:6379");
    expect(cfg.TELEGRAM_MODE).toBe("polling");
    expect(cfg.TZ).toBe("Asia/Dubai");
    expect(cfg.GROQ_BASE_URL).toBe("https://api.groq.com/openai/v1");
    expect(cfg.LLM_DAILY_BUDGET_USD).toBe(2);
  });

  it("coerces the CEO Telegram id to bigint (32-bit overflow guard)", () => {
    const cfg = loadConfig({ ...base, CEO_TELEGRAM_USER_ID: "8903000291" });
    expect(cfg.CEO_TELEGRAM_USER_ID).toBe(8903000291n);
  });

  it("throws when DATABASE_URL is missing", () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
  });

  it("throws when DATABASE_URL is not a postgres connection string", () => {
    expect(() => loadConfig({ DATABASE_URL: "mysql://nope" })).toThrow(
      /postgres/,
    );
  });

  it("rejects a non-numeric CEO Telegram id", () => {
    expect(() =>
      loadConfig({ ...base, CEO_TELEGRAM_USER_ID: "not-a-number" }),
    ).toThrow();
  });
});
