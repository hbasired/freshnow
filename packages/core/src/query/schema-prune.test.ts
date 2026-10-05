import { describe, expect, it } from "vitest";
import { pruneSchema, TABLE_DOCS } from "./schema-prune.js";

/** The question box is shown the tables a question needs, and the tables they join through. */

describe("schema pruning", () => {
  it("a question about problems gets the blocker table and what it joins through — not voice notes or routing", () => {
    const { tables } = pruneSchema("How many critical problems are open on the chiller?");
    expect(tables).toEqual(expect.arrayContaining(["blocker", "task_update", "employee"]));
    expect(tables).not.toContain("voice_asset");
    expect(tables).not.toContain("routing_rule");
  });

  it("an escalation question pulls in blockers (escalation joins through them)", () => {
    expect(pruneSchema("which ones escalated to level 2?").tables).toEqual(expect.arrayContaining(["escalation", "blocker", "employee"]));
  });

  it("a question that signals nothing gets the everyday four, and never the whole schema", () => {
    const { tables, text } = pruneSchema("hello?");
    expect(tables).toEqual(["employee", "task", "task_update", "blocker"]);
    expect(tables.length).toBeLessThan(Object.keys(TABLE_DOCS).length);
    expect(text).not.toContain("routing_rule(");
  });

  it("names always need the employee table", () => {
    expect(pruneSchema("what did Hemanth say about the voice note?").tables).toEqual(expect.arrayContaining(["employee", "task_update", "voice_asset"]));
  });

  it("is deterministic — same question, same prompt", () => {
    expect(pruneSchema("assignments given today").text).toBe(pruneSchema("assignments given today").text);
  });
});
