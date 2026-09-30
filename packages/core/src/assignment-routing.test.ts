import { describe, expect, it } from "vitest";
import { groundResolution, type ModelResolution } from "./context.js";
import type { ContextPerson, ContextTask } from "./context.js";
import { groundDocumentTasks, type ModelDocumentTask } from "./documents.js";

/**
 * WHO gets the work — after the model has read the message or document, before anything is
 * assigned. The model's answer is fed in directly (no model call), so these are the routing
 * rules themselves: the name as WRITTEN must fit exactly one person, whatever the model picked.
 * A wrong assignment reaches a real phone; asking again costs one tap.
 */

const colleagues: ContextPerson[] = [
  { id: "a1", display_name: "Ahmed Khan", department: "warehouse" },
  { id: "a2", display_name: "Ahmed Ali", department: "delivery" },
  { id: "r1", display_name: "Rashid Al Maktoum", department: "production" },
  { id: "p1", display_name: "Priya Nair", department: "vending" },
  { id: "k1", display_name: "Khalid Mansour", department: "delivery" },
] as ContextPerson[];
const tasks: ContextTask[] = [];
const idx = (id: string) => colleagues.findIndex((c) => c.id === id) + 1;

const model = (items: { title: string; pick: string | null; namedAs: string | null }[]): ModelResolution => ({
  intent: "assignment",
  timeframe: "current",
  task_index: 0,
  new_task_title: items[0]?.title ?? null,
  assignee_index: items[0]?.pick ? idx(items[0].pick) : 0,
  named_as: items[0]?.namedAs ?? null,
  items: items.map((i) => ({ task_index: 0, new_task_title: i.title, assignee_index: i.pick ? idx(i.pick) : 0, named_as: i.namedAs })),
  reason: "test",
});

describe("a chat message: 'ask … to …'", () => {
  it("a unique name is assigned to that person", () => {
    const r = groundResolution(model([{ title: "Fix van 2", pick: "r1", namedAs: "Rashid" }]), { tasks, colleagues });
    expect(r.items[0]!.assignee?.id).toBe("r1");
  });

  it("the written name wins when the model points at someone else", () => {
    const r = groundResolution(model([{ title: "Fix van 2", pick: "p1", namedAs: "Rashid" }]), { tasks, colleagues });
    expect(r.items[0]!.assignee?.id).toBe("r1");
  });

  it("two Ahmeds: nothing is assigned; both are offered", () => {
    const r = groundResolution(model([{ title: "Count stock", pick: "a1", namedAs: "Ahmed" }]), { tasks, colleagues });
    expect(r.items[0]!.assignee).toBeNull();
    expect(r.items[0]!.candidates.map((c) => c.id)).toEqual(["a1", "a2"]);
  });

  it("the full name settles it", () => {
    const r = groundResolution(model([{ title: "Count stock", pick: "a1", namedAs: "Ahmed Ali" }]), { tasks, colleagues });
    expect(r.items[0]!.assignee?.id).toBe("a2");
  });

  it("'Ali' is Ahmed Ali, not Khalid — whole words, not letters inside a name", () => {
    const r = groundResolution(model([{ title: "Load the van", pick: "k1", namedAs: "Ali" }]), { tasks, colleagues });
    expect(r.items[0]!.assignee?.id).toBe("a2");
  });

  it("a name in another script is only a suggestion to confirm, never assigned on its own", () => {
    const r = groundResolution(model([{ title: "Fix van 2", pick: "r1", namedAs: "राशिद" }]), { tasks, colleagues });
    expect(r.items[0]!.assignee).toBeNull();
    expect(r.items[0]!.suggestedAssignee?.id).toBe("r1");
  });

  it("the model naming someone when no name was written is not enough either", () => {
    const r = groundResolution(model([{ title: "Fix van 2", pick: "r1", namedAs: null }]), { tasks, colleagues });
    expect(r.items[0]!.assignee).toBeNull();
    expect(r.items[0]!.suggestedAssignee?.id).toBe("r1");
  });

  it("several people in one message: each item is checked on its own — a clear one is not held up by an unclear one", () => {
    const r = groundResolution(
      model([
        { title: "Fix van 2", pick: "r1", namedAs: "Rashid" },
        { title: "Restock Marina", pick: "a1", namedAs: "Ahmed" },
        { title: "Clean chiller", pick: "p1", namedAs: "Priya" },
      ]),
      { tasks, colleagues },
    );
    expect(r.items.map((i) => i.assignee?.id ?? null)).toEqual(["r1", null, "p1"]);
    expect(r.items[1]!.candidates).toHaveLength(2);
  });

  it("an index outside the list is nobody, never the last person", () => {
    const out = model([{ title: "Fix van 2", pick: null, namedAs: "Vikram" }]);
    out.items![0]!.assignee_index = 99;
    const r = groundResolution(out, { tasks, colleagues });
    expect(r.items[0]!.assignee).toBeNull();
    expect(r.items[0]!.suggestedAssignee).toBeNull();
  });
});

describe("a document read into tasks", () => {
  const t = (title: string, pick: string | null, named_as: string | null): ModelDocumentTask => ({ title, detail: null, assignee_index: pick ? idx(pick) : 0, named_as });

  it("owners are decided by the written name, and the CEO is told how each was found", () => {
    const { tasks: out, overridden } = groundDocumentTasks(
      [t("Fix van 2", "p1", "Rashid"), t("Count stock", "a1", "Ahmed"), t("Clean chiller", "p1", "Pria"), t("Audit fridge", null, "Vikram")],
      colleagues,
    );
    expect(out.map((x) => x.assignee?.id ?? null)).toEqual(["r1", null, "p1", null]);
    expect(out.map((x) => x.matchedBy)).toEqual(["name", null, "ai", null]);
    expect(out[1]!.candidates.map((c) => c.id)).toEqual(["a1", "a2"]);
    expect(out[3]!.namedAs).toBe("Vikram");
    expect(overridden).toBe(1); // the model said Priya for "Rashid"; the name won
  });
});
