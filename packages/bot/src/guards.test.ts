import { describe, expect, it } from "vitest";
import { looksLikeName, STEP_TTL_MS, isStepStale } from "./guards.js";

/**
 * Guards for the failure of 2026-09-08: an unanswered `/invite` from the previous
 * evening was still waiting for a name, so the next morning's message —
 * "Assign the tasks to hemanth based on the attached pdf document." — became the name
 * on an invite code (gotcha G31).
 *
 * Two independent defences, tested independently: the question expires, and an answer
 * that plainly is not a name is questioned rather than accepted.
 */
describe("does this answer plausibly name a person", () => {
  it("accepts the names people actually type", () => {
    for (const n of ["Hemanth", "Rashid Ali", "Priya Nair", "Ahmed", "Mary Jane Watson"]) {
      expect(looksLikeName(n), n).toBe(true);
    }
  });

  it("rejects the message that caused the bug", () => {
    expect(looksLikeName("Assign the tasks to hemanth based on the attached pdf document.")).toBe(
      false,
    );
  });

  it("rejects instructions, sentences and anything with punctuation or digits", () => {
    for (const s of [
      "send this to Rashid",
      "please check the van 2 chiller",
      "tell Priya to restock the machine",
      "Hemanth, do the demo",
      "employee 3",
      "hemanth@example.com",
      "I need a code for the new driver we hired yesterday",
      "",
    ]) {
      expect(looksLikeName(s), s).toBe(false);
    }
  });

  it("errs towards asking rather than towards minting a wrong code", () => {
    // A long single token is not obviously a name; one extra tap is the cheap outcome.
    expect(looksLikeName("x".repeat(60))).toBe(false);
  });
});

describe("a half-finished question expires", () => {
  it("keeps a question live while it is fresh", () => {
    expect(isStepStale("invite_name", Date.now() - 60_000)).toBe(false);
  });

  it("lets go of a question left overnight", () => {
    // The actual gap in the incident was ~18 hours.
    expect(isStepStale("invite_name", Date.now() - 18 * 3600_000)).toBe(true);
  });

  it("expires exactly at the TTL boundary, not before", () => {
    expect(isStepStale("invite_name", Date.now() - (STEP_TTL_MS - 1000))).toBe(false);
    expect(isStepStale("invite_name", Date.now() - (STEP_TTL_MS + 1000))).toBe(true);
  });

  it("treats a missing timestamp as stale", () => {
    // Sessions written before this field existed must not stay live forever.
    expect(isStepStale("invite_name", undefined)).toBe(true);
  });

  it("never expires the idle step", () => {
    expect(isStepStale("idle", undefined)).toBe(false);
  });
});
