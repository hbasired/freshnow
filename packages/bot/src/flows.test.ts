import { afterAll, describe, expect, it } from "vitest";
import { closeDb, getServiceSql } from "@freshnow/core";
import { handleText, type FreshCtx } from "./bot.js";

/**
 * Exercises the bot's own text router with a stub context, so the wiring between a
 * message and an action is covered — not just the core functions underneath it.
 *
 * The case that matters most here is the 2026-09-08 incident: a pending "what is the new
 * person's name?" swallowing an unrelated instruction the next morning.
 */

interface Harness {
  ctx: FreshCtx;
  replies: string[];
}

function harness(over: Partial<FreshCtx> = {}): Harness {
  const replies: string[] = [];
  const ctx = {
    session: { step: { kind: "idle" }, stepAt: Date.now() },
    role: "ceo",
    employee: { id: CEO_ID, display_name: "FLOW CEO", status: "active", language: "en" },
    message: { message_id: 1 },
    reply: async (text: string) => {
      replies.push(text);
      return {} as never;
    },
    ...over,
  } as unknown as FreshCtx;
  return { ctx, replies };
}

const CEO_ID = "00000000-0000-0000-0000-0000000000ce";

afterAll(async () => {
  const sql = getServiceSql();
  await sql`delete from invite_code where display_name like 'FLOW-%' or display_name like 'Assign %'`;
  await closeDb();
});

describe("a pending question does not swallow an unrelated instruction", () => {
  it("questions an answer that plainly is not a name, and creates no code", async () => {
    const { ctx, replies } = harness();
    ctx.session.step = { kind: "invite_name" };

    // The exact message from the incident.
    await handleText(ctx, "Assign the tasks to hemanth based on the attached pdf document.");

    // It asked instead of acting.
    expect(replies.join(" ")).toMatch(/does not look like one|something else/i);
    expect(ctx.session.step.kind).toBe("ambiguous");

    // And crucially: no invite code was minted with that sentence as somebody's name.
    const sql = getServiceSql();
    const bad = await sql<{ n: number }[]>`
      select count(*)::int as n from invite_code where display_name like 'Assign the tasks%'`;
    expect(bad[0]!.n).toBe(0);
  });

  it("also questions a name that arrives with a document attached", async () => {
    const { ctx, replies } = harness();
    ctx.session.step = { kind: "invite_name" };
    ctx.session.pendingFiles = [{ fileId: "f1", fileName: "1.pdf", kind: "document" }];

    // "Rashid" alone IS a plausible name — but nobody attaches a PDF to a name.
    await handleText(ctx, "Rashid");

    expect(ctx.session.step.kind).toBe("ambiguous");
    expect(replies.join(" ")).toMatch(/something else/i);
  });

  it("still accepts a real name typed at the prompt", async () => {
    const { ctx, replies } = harness();
    ctx.session.step = { kind: "invite_name" };

    await handleText(ctx, "FLOW-Rashid Ali");

    // Normal path is untouched: a code is issued and the step clears.
    expect(ctx.session.step.kind).toBe("idle");
    expect(replies.join(" ")).toMatch(/invite code/i);

    const sql = getServiceSql();
    const made = await sql<{ n: number }[]>`
      select count(*)::int as n from invite_code where display_name = 'FLOW-Rashid Ali'`;
    expect(made[0]!.n).toBe(1);
  });

  it("tells the person when it let go of a question left too long", async () => {
    const { ctx, replies } = harness();
    // The middleware already expired the step and recorded what it was.
    ctx.expiredStep = "invite_name";
    ctx.session.step = { kind: "idle" };

    await handleText(ctx, "hello");

    // Silent expiry would answer their next message in a context they forgot being in.
    expect(replies.join(" ")).toMatch(/creating an invite code.*let that go/is);
  });
});

describe("a dropped document plan creates nothing", () => {
  it("abandons the proposal when the CEO types instead of tapping", async () => {
    const { ctx, replies } = harness();
    ctx.session.step = {
      kind: "confirm_doc_tasks",
      plan: {
        fileName: "1.pdf",
        mayForward: true,
        sendFile: false,
        tasks: [{ title: "Service the line", detail: null, assigneeId: null, assigneeName: null }],
      },
    };

    await handleText(ctx, "actually never mind");

    expect(replies.join(" ")).toMatch(/nothing was created/i);
    expect(ctx.session.step.kind).not.toBe("confirm_doc_tasks");
  });
});

describe("a document attached by the CEO is always read", () => {
  it("reads the document even when the caption resolves to smalltalk", async () => {
    // The 2026-09-08 failure: "analyse and assign the task accordingly" carries no object
    // and no name, so the resolver returned `smalltalk` and the PDF was never opened. The
    // presence of the document is a FACT, so the branch is now taken before any model call.
    const { ctx, replies } = harness();
    ctx.session.pendingFiles = [
      { fileId: "flow-pdf", fileUniqueId: "u1", fileName: "1.pdf", mimeType: "application/pdf", kind: "document" },
    ];

    await handleText(ctx, "analyse and assign the task accordingly");

    // It tried to READ it. (The download then fails in the test env, which is the point
    // of the next assertion: it says so instead of going silent.)
    expect(replies.join(" ")).toMatch(/Reading 1\.pdf/i);
    // What it must NOT do is answer with the smalltalk brush-off.
    expect(replies.join(" ")).not.toMatch(/Noted\. Send \/start/i);
  });

  it("says plainly when the file cannot be downloaded, and keeps it held", async () => {
    const { ctx, replies } = harness();
    ctx.session.pendingFiles = [
      { fileId: "does-not-exist", fileUniqueId: "u2", fileName: "x.pdf", mimeType: "application/pdf", kind: "document" },
    ];

    await handleText(ctx, "assign these");

    expect(replies.join(" ")).toMatch(/could not download/i);
    // Held, so retrying costs one message rather than a re-upload.
    expect(ctx.session.pendingFiles).toHaveLength(1);
  });

  it("does not take the document path for an employee", async () => {
    const { ctx, replies } = harness({ role: "employee" });
    ctx.session.pendingFiles = [
      { fileId: "emp-pdf", fileUniqueId: "u3", fileName: "photo.pdf", mimeType: "application/pdf", kind: "document" },
    ];

    await handleText(ctx, "here is the damaged part");

    // An employee attaching a file is reporting, not assigning work to people.
    expect(replies.join(" ")).not.toMatch(/Reading/i);
  });

  it("does not take the document path for a photo, which has no text", async () => {
    const { ctx, replies } = harness();
    ctx.session.pendingFiles = [
      { fileId: "img", fileUniqueId: "u4", fileName: null, mimeType: "image/jpeg", kind: "photo" },
    ];

    await handleText(ctx, "assign this to someone");

    expect(replies.join(" ")).not.toMatch(/Reading/i);
  });

  it("lets a question through untouched even with a document pending", async () => {
    const { ctx, replies } = harness();
    ctx.session.pendingFiles = [
      { fileId: "q-pdf", fileUniqueId: "u5", fileName: "1.pdf", mimeType: "application/pdf", kind: "document" },
    ];

    await handleText(ctx, "how many blockers are open?");

    // A question is answered, not treated as an instruction about the file.
    expect(replies.join(" ")).not.toMatch(/Reading 1\.pdf/i);
  });
});

describe("a held file cannot trap the conversation", () => {
  it("releases the file when a plan is dropped by typing", async () => {
    const { ctx } = harness();
    ctx.session.pendingFiles = [
      { fileId: "trap", fileUniqueId: "u6", fileName: "1.pdf", mimeType: "application/pdf", kind: "document" },
    ];
    ctx.session.step = {
      kind: "confirm_doc_tasks",
      plan: { fileName: "1.pdf", sendFile: false, mayForward: true, tasks: [] },
    };

    await handleText(ctx, "never mind");

    // Without this the next message re-plans the same document, forever.
    expect(ctx.session.pendingFiles).toBeUndefined();
  });
});
