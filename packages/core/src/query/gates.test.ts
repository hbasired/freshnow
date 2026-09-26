import { describe, expect, it } from "vitest";
import { groundingGate, numericSanityGate } from "./gates.js";

describe("numericSanityGate", () => {
  it("passes when every number in the answer appears in the rows", () => {
    expect(numericSanityGate("There are 2 equipment blockers.", [{ n: 2 }]).passed).toBe(true);
  });

  it("fails when a number is invented", () => {
    const r = numericSanityGate("There are 7 equipment blockers.", [{ n: 2 }]);
    expect(r.passed).toBe(false);
    expect(r.missing).toContain("7");
  });

  it("passes when the answer states no numbers", () => {
    expect(numericSanityGate("No matching records.", []).passed).toBe(true);
  });
});

/**
 * The grounding gate: a policy/rule/food-safety claim needs a source record behind it.
 * "Source" means the SQL read a policy-bearing table and got rows.
 */
describe("groundingGate", () => {
  it("passes an ordinary data answer that makes no policy claim", () => {
    const r = groundingGate("There are 3 open blockers, two of them high.", "select count(*) from blocker", 1);
    expect(r.passed).toBe(true);
    expect(r.claims).toEqual([]);
  });

  it("refuses a food-safety claim — no document store exists to ground it", () => {
    const r = groundingGate("The chiller must be kept below 5°C under HACCP.", "select * from blocker", 2);
    expect(r.passed).toBe(false);
    expect(r.claims).toContain("haccp");
    expect(r.sourced).toBe(false);
  });

  it("grounds an SLA claim when the rows came from sla_policy", () => {
    const r = groundingGate("A critical problem must be acknowledged within 15 minutes.", "select severity, minutes from sla_policy", 4);
    expect(r.passed).toBe(true);
    expect(r.sourced).toBe(true);
  });

  it("refuses the same SLA claim when the rows came from somewhere else", () => {
    const r = groundingGate("A critical problem must be acknowledged within 15 minutes.", "select * from blocker", 4);
    expect(r.passed).toBe(false);
  });

  it("refuses a policy claim when the policy table returned no rows", () => {
    const r = groundingGate("The policy says escalation goes to the CEO.", "select * from escalation_policy where false", 0);
    expect(r.passed).toBe(false);
  });

  it("is deterministic: same inputs, same verdict", () => {
    const args: [string, string, number] = ["Compliance requires a log.", "select 1", 1];
    expect(groundingGate(...args)).toEqual(groundingGate(...args));
  });
});
