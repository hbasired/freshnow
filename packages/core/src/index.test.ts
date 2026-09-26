import { describe, expect, it } from "vitest";
import { IS_DEMO, PROJECT_NAME, botRole, resolveRole } from "./index.js";

describe("resolveRole", () => {
  it("returns 'ceo' only for the configured CEO id", () => {
    const ceo = 123456789n;
    expect(resolveRole(ceo, ceo)).toBe("ceo");
    expect(resolveRole(987654321n, ceo)).toBe("employee");
  });

  it("handles Telegram ids beyond 32-bit range without truncation", () => {
    // Both are > 2^31 and differ only in the last digit — a 32-bit compare would break.
    const big = 7_600_000_123_456_789n;
    const other = 7_600_000_123_456_790n;
    expect(resolveRole(big, big)).toBe("ceo");
    expect(resolveRole(other, big)).toBe("employee");
  });

  it("botRole: the configured id is CEO with or without a row; the row's role decides the rest", () => {
    expect(botRole(true, undefined)).toBe("ceo"); // config CEO before their row exists
    expect(botRole(true, "employee")).toBe("ceo"); // config wins over a stale row
    expect(botRole(false, "ceo")).toBe("ceo"); // a CEO made on the dashboard is the CEO here too
    expect(botRole(false, "manager")).toBe("manager");
    expect(botRole(false, "lead")).toBe("manager"); // lead's extra reach is decided by canAssignTo, not the menu
    expect(botRole(false, "employee")).toBe("employee");
    expect(botRole(false, null)).toBe("employee"); // unlinked
  });

  it("exposes demo metadata", () => {
    expect(IS_DEMO).toBe(true);
    expect(PROJECT_NAME).toContain("FreshNow");
  });
});
