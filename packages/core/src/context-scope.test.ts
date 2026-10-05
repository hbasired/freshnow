import { describe, expect, it } from "vitest";
import { CONTEXT_LIMITS, relevantPeople } from "./context-scope.js";

/**
 * A model call gets the people a text could be about — not the whole directory. These are the
 * selection rules, on a directory far larger than the cap.
 */

const big = Array.from({ length: 300 }, (_, i) => ({ id: `p${i}`, display_name: `Person ${String(i).padStart(3, "0")} Filler` }));
const dir = [...big, { id: "z1", display_name: "Zainab Rahman" }, { id: "z2", display_name: "Rashid Al Maktoum" }, { id: "z3", display_name: "Ahmed Khan" }, { id: "z4", display_name: "Ahmed Ali" }];

describe("relevant people", () => {
  it("a small directory is passed whole — nothing to gain by cutting it", () => {
    const r = relevantPeople("anything", dir.slice(0, 10));
    expect(r).toMatchObject({ total: 10, truncated: false });
    expect(r.people).toHaveLength(10);
  });

  it("a large one is capped, and everyone the text names is kept — even names that sort last", () => {
    const r = relevantPeople("Zainab: count the crates. Rashid: fix van 2.", dir);
    expect(r.people).toHaveLength(CONTEXT_LIMITS.colleagues);
    expect(r.truncated).toBe(true);
    expect(r.total).toBe(304);
    expect(r.people.slice(0, 2).map((p) => p.id).sort()).toEqual(["z1", "z2"]);
  });

  it("the person named in full comes before a namesake", () => {
    const r = relevantPeople("Ahmed Khan to restock", dir);
    expect(r.people[0]!.id).toBe("z3");
    expect(r.people.map((p) => p.id)).toContain("z4"); // the other Ahmed stays in view, so the name check can see both
  });

  it("is deterministic", () => {
    expect(relevantPeople("Rashid", dir).people).toEqual(relevantPeople("Rashid", dir).people);
  });
});
