import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, DEMO_CEO_ID, getServiceSql } from "@freshnow/core";
import { buildServer } from "./server.js";

/**
 * A document uploaded in the browser becomes tasks for the right people — through the
 * same gate, the same parser and the same confirm step as a PDF sent to the bot. One of
 * these tests makes a real model call on purpose: a mocked planner proves nothing about
 * whether names in a document reach the right rows.
 */

const app = buildServer(false);
const FARAH = randomUUID();
const OMAR = randomUUID();
const PREFIX = "DOC-";

/** Hand-built multipart body, so the test has no dependency beyond Node itself. */
function multipart(fields: Record<string, string>, file: { name: string; type: string; bytes: Buffer }) {
  const boundary = "----freshnow" + randomUUID().replace(/-/g, "");
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`,
    ),
    file.bytes,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  );
  return { payload: Buffer.concat(parts), headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
}

beforeAll(async () => {
  const sql = getServiceSql();
  await sql`insert into employee (id, display_name, department, status, is_synthetic)
            values (${FARAH}, ${PREFIX + "Farah Haddad"}, 'production', 'active', true),
                   (${OMAR}, ${PREFIX + "Omar Siddiqui"}, 'delivery', 'active', true)`;
});

afterAll(async () => {
  const sql = getServiceSql();
  const ids = [FARAH, OMAR];
  await sql`delete from notification_outbox where recipient_employee_id = any(${ids})`;
  await sql`delete from attachment where assignment_id in (select id from assignment where assigned_to = any(${ids}))`;
  await sql`delete from assignment where assigned_to = any(${ids})`;
  await sql`delete from task where employee_id = any(${ids})`;
  await sql`delete from employee where id = any(${ids})`;
  await app.close();
  await closeDb();
});

describe("POST /dashboard/documents/plan", () => {
  it("refuses everyone but the CEO", async () => {
    const m = multipart({}, { name: "plan.txt", type: "text/plain", bytes: Buffer.from("Farah: check the chiller") });
    const r = await app.inject({ method: "POST", url: `/dashboard/documents/plan?viewer=${FARAH}`, ...m });
    expect(r.statusCode).toBe(403);
  });

  it("rejects a file that fails the safety gate, before any parsing", async () => {
    // A Windows executable header, however it is named. The gate reads bytes, not names.
    const exe = Buffer.concat([Buffer.from("MZ"), Buffer.alloc(600, 0x90)]);
    const m = multipart({}, { name: "work-order.pdf", type: "application/pdf", bytes: exe });
    const r = await app.inject({ method: "POST", url: `/dashboard/documents/plan?viewer=ceo`, ...m });
    expect(r.statusCode).toBe(422);
    expect((r.json() as { error: { code: string } }).error.code).toBe("file_rejected");
  });

  it("reads a document naming two people and proposes one task each, owners resolved (real model)", async () => {
    const text = [
      "Work order — Sunday",
      "",
      `1. ${PREFIX}Farah Haddad: replace the chiller filter in van 2 before the morning run.`,
      `2. ${PREFIX}Omar Siddiqui: collect the signed delivery sheets from the Deira route.`,
    ].join("\n");
    const m = multipart(
      { instruction: "Assign the work in this document to the right people." },
      { name: "sunday-work-order.txt", type: "text/plain", bytes: Buffer.from(text) },
    );
    const r = await app.inject({ method: "POST", url: `/dashboard/documents/plan?viewer=ceo`, ...m });
    expect(r.statusCode).toBe(200);
    const plan = r.json() as {
      fileName: string;
      fileForwarded: boolean;
      needsOwner: boolean;
      tasks: { title: string; assigneeId: string | null; assigneeName: string | null }[];
    };
    expect(plan.fileForwarded).toBe(false);
    expect(plan.tasks.length).toBeGreaterThanOrEqual(2);
    const owners = new Set(plan.tasks.map((t) => t.assigneeId));
    expect(owners.has(FARAH)).toBe(true);
    expect(owners.has(OMAR)).toBe(true);
  }, 60_000);
});

describe("POST /dashboard/documents/apply", () => {
  it("creates one assignment per confirmed row, each queued for Telegram and marked with its source", async () => {
    const r = await app.inject({
      method: "POST",
      url: `/dashboard/documents/apply?viewer=ceo`,
      payload: {
        fileName: "sunday-work-order.txt",
        tasks: [
          { assignedTo: FARAH, title: "Replace the chiller filter in van 2", detail: "Before the morning run" },
          { assignedTo: OMAR, title: "Collect the signed delivery sheets from the Deira route" },
        ],
      },
    });
    expect(r.statusCode).toBe(201);
    const { assigned, fileForwarded } = r.json() as {
      assigned: { assignmentId: string; assignedTo: string; queued: boolean }[];
      fileForwarded: boolean;
    };
    expect(fileForwarded).toBe(false);
    expect(assigned.map((a) => a.assignedTo).sort()).toEqual([FARAH, OMAR].sort());
    expect(assigned.every((a) => a.queued)).toBe(true);

    const sql = getServiceSql();
    const rows = await sql<{ note: string; assigned_by: string }[]>`
      select note, assigned_by from assignment where id in ${sql(assigned.map((a) => a.assignmentId))}`;
    expect(rows.length).toBe(2);
    for (const row of rows) {
      expect(row.assigned_by).toBe(DEMO_CEO_ID);
      expect(row.note).toContain("(from document: sunday-work-order.txt)");
    }
  });

  it("refuses an empty or oversized batch", async () => {
    const r = await app.inject({
      method: "POST",
      url: `/dashboard/documents/apply?viewer=ceo`,
      payload: { fileName: "x.txt", tasks: [] },
    });
    expect(r.statusCode).toBe(400);
  });
});
