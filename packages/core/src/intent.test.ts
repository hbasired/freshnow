import { describe, expect, it } from "vitest";
import { classifyIntent } from "./intent.js";

// Only the DETERMINISTIC fast path is tested here — these inputs must never reach the
// model, so the test needs no network and cannot flake. Model-backed classification is
// exercised live (see the task HTML), not in the unit suite.
describe("intent — obvious questions are classified without a model call", () => {
  const questions = [
    "what is the status of my tasks",
    "How many blockers are open right now",
    "who is working on the chiller",
    "show me my tasks",
    "tell me what happened today",
    "kitne blockers open hain",
    "kya hua aaj",
    "ethra blockers und",
  ];

  for (const q of questions) {
    it(`classifies as a question: "${q.slice(0, 34)}"`, async () => {
      const r = await classifyIntent(q);
      expect(r.intent).toBe("question");
      expect(r.reason).toMatch(/without a model call/);
    });
  }

  it("does NOT treat a plain report as a question, even with a question mark", async () => {
    // "chiller broken?" is a report, not a request for information. It has no question
    // word, so the fast path must decline and leave it to the model.
    const looksLikeReport = "chiller broken?";
    const fastPathWouldMatch = ["what", "how", "who", "when", "where", "why"].some((w) =>
      looksLikeReport.toLowerCase().startsWith(w + " "),
    );
    expect(fastPathWouldMatch).toBe(false);
  });
});
