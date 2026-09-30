import { describe, expect, it } from "vitest";
import { dueShortcuts } from "./dates";

/**
 * The due-date chips, against the UAE working week (Monday–Friday): "end of week" is the
 * coming Friday, "next Monday" is never today, and no date is offered twice. The weekdays
 * below were checked with `date -d`, not derived from the code.
 */
const on = (today: string) => Object.fromEntries(dueShortcuts(today).map((s) => [s.label, s.date]));

describe("due-date shortcuts follow the UAE week", () => {
  it("a Wednesday offers today, tomorrow, Friday and next Monday", () => {
    expect(on("2026-09-30")).toEqual({
      Today: "2026-09-30",
      Tomorrow: "2026-10-01",
      "Friday · end of week": "2026-10-02",
      "Next Monday": "2026-10-05",
    });
  });

  it("on a Thursday, Friday is tomorrow and is offered once", () => {
    expect(on("2026-10-01")).toEqual({ Today: "2026-10-01", Tomorrow: "2026-10-02", "Next Monday": "2026-10-05" });
  });

  it("on a Friday, end of week is today and is offered once", () => {
    expect(on("2026-10-02")).toEqual({ Today: "2026-10-02", Tomorrow: "2026-10-03", "Next Monday": "2026-10-05" });
  });

  it("at the weekend, Friday is the next working week's", () => {
    expect(on("2026-10-03")["Friday · end of week"]).toBe("2026-10-09"); // Saturday
    expect(on("2026-10-04")["Friday · end of week"]).toBe("2026-10-09"); // Sunday
    expect(on("2026-10-04")["Next Monday"]).toBeUndefined(); // Sunday: Monday is Tomorrow
    expect(on("2026-10-04").Tomorrow).toBe("2026-10-05");
  });

  it("on a Monday, next Monday is a week away, not today", () => {
    expect(on("2026-10-05")["Next Monday"]).toBe("2026-10-12");
    expect(on("2026-10-05")["Friday · end of week"]).toBe("2026-10-09");
  });
});
