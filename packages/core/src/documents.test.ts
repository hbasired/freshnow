import { afterAll, describe, expect, it } from "vitest";
import { closeDb } from "./db.js";
import {
  decodeTextFile,
  formatDocumentPlan,
  MAX_DOC_TASKS,
  planDocumentTasks,
  type DocumentPlan,
} from "./documents.js";
import type { ContextPerson } from "./context.js";

const people: ContextPerson[] = [
  { id: "11111111-1111-1111-1111-111111111111", display_name: "Hemanth", department: "production" },
  { id: "22222222-2222-2222-2222-222222222222", display_name: "Rashid", department: "delivery" },
  { id: "33333333-3333-3333-3333-333333333333", display_name: "Priya", department: "warehouse" },
];

afterAll(async () => {
  await closeDb();
});

describe("reading a work document", () => {
  it("decodes a plain-text attachment without a parser", () => {
    const bytes = new TextEncoder().encode("  Fix the chiller\nRestock Marina  ");
    const doc = decodeTextFile(bytes);
    expect(doc.text).toBe("Fix the chiller\nRestock Marina");
    expect(doc.truncated).toBe(false);
  });

  it("splits a numbered list into separate tasks, all owned by the named person", async () => {
    // This is the real document from 2026-09-08, which the old code turned into ONE task
    // called "Assign tasks from PDF" with the raw PDF stapled to it.
    const text = `Assign Hemanth the following tasks:
1. He needs to build the complete finalized DEMO platform for status logging and task
assigning, and also report back about his previous tasks.
2. And he needs to go to warehouse and the details of the employees and production systems.
3. Check what is working in the warehouse and what can be due for maintenance.
4. Need to enter all the in the database and then automize alerts in the dashboard.`;

    const plan = await planDocumentTasks({ text, colleagues: people });

    // Four numbered items, some carrying two jobs — several separate tasks either way.
    expect(plan.tasks.length).toBeGreaterThanOrEqual(4);
    expect(plan.tasks.length).toBeLessThanOrEqual(MAX_DOC_TASKS);
    // The heading names Hemanth once and it governs every item beneath it.
    expect(plan.tasks.every((t) => t.assignee?.display_name === "Hemanth")).toBe(true);
    expect(plan.needsOwner).toBe(false);
    // Titles are the work, never the instruction wrapper. ("task assigning" legitimately
    // appears INSIDE one title — it is what the platform being built has to do — so the
    // thing to assert is that no title restates "assign <person> the following".)
    expect(plan.tasks.some((t) => /^assign\s+hemanth/i.test(t.title))).toBe(false);
    expect(plan.tasks.some((t) => /the following tasks/i.test(t.title))).toBe(false);
    // And each title reads as a job, not as a person's name.
    expect(plan.tasks.every((t) => t.title.length > 8)).toBe(true);
  });

  it("routes tasks to different people when the document names them", async () => {
    const text = `Work for this week:
- Rashid: fix the van 2 chiller before Thursday.
- Priya: restock the Marina vending machine.
- Hemanth: prepare the demo presentation.`;

    const plan = await planDocumentTasks({ text, colleagues: people });

    const owners = plan.tasks.map((t) => t.assignee?.display_name).sort();
    expect(owners).toEqual(["Hemanth", "Priya", "Rashid"]);
    expect(plan.needsOwner).toBe(false);
  });

  it("refuses to invent a person the directory does not contain", async () => {
    const text = "Ask Bartholomew Fitzgerald to recalibrate the filling head on line 3.";

    const plan = await planDocumentTasks({ text, colleagues: people });

    // The name is real in the document and absent from the company. The only honest
    // outcome is "I need you to say who" — never the nearest-looking colleague.
    expect(plan.tasks.length).toBeGreaterThanOrEqual(1);
    expect(plan.tasks[0]!.assignee).toBeNull();
    expect(plan.needsOwner).toBe(true);
  });

  it("shows unowned tasks as needing a decision when formatted", () => {
    const plan: DocumentPlan = {
      tasks: [
        { title: "Fix the chiller", detail: null, assignee: people[1]!, namedAs: "Rashid", matchedBy: "name", candidates: [] },
        { title: "Recalibrate line 3", detail: null, assignee: null, namedAs: null, matchedBy: null, candidates: [] },
      ],
      summary: "Weekly jobs",
      needsOwner: true,
      injection: { suspicious: false, labels: [], cleaned: "", removedInvisible: 0 },
    };
    const out = formatDocumentPlan(plan, "week.pdf");
    expect(out).toContain("Fix the chiller");
    expect(out).toContain("Rashid");
    // The gap is visible to the CEO rather than quietly assigned to somebody.
    expect(out).toContain("tap to say who");
  });

  it("names every candidate when the written name fits several people, and flags the model's guesses", () => {
    const [a, b] = [{ ...people[0]!, display_name: "Ahmed Khan" }, { ...people[1]!, display_name: "Ahmed Ali" }];
    const plan: DocumentPlan = {
      tasks: [
        { title: "Count stock", detail: null, assignee: null, namedAs: "Ahmed", matchedBy: null, candidates: [a, b] },
        { title: "Clean van 2", detail: null, assignee: people[1]!, namedAs: "Rasheed", matchedBy: "ai", candidates: [] },
      ],
      summary: "",
      needsOwner: true,
      injection: { suspicious: false, labels: [], cleaned: "", removedInvisible: 0 },
    };
    const out = formatDocumentPlan(plan, "week.pdf");
    expect(out).toContain('"Ahmed" could be Ahmed Khan or Ahmed Ali');
    expect(out).toContain('my guess for "Rasheed"');
  });
});
