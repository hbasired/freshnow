import { afterAll, describe, expect, it } from "vitest";
import { saveAttachments, listAttachmentsForAssignment, describeAttachment } from "./attachments.js";
import { closeDb, getServiceSql } from "./db.js";
import { assignTask, createTask } from "./updates.js";

async function makeEmployee(name: string): Promise<string> {
  const sql = getServiceSql();
  const rows = await sql<{ id: string }[]>`
    insert into employee (display_name, status, is_synthetic)
    values (${name}, 'active', true) returning id`;
  return rows[0]!.id;
}

afterAll(async () => {
  const sql = getServiceSql();
  const mine = `select id from employee where display_name like 'ATT-%'`;
  await sql`delete from notification_outbox
              where idempotency_key like 'attachment-%'
                 or idempotency_key like 'task.assigned:%'`;
  await sql.unsafe(`delete from attachment where uploaded_by in (${mine})`);
  await sql.unsafe(`delete from assignment where assigned_to in (${mine})`);
  await sql.unsafe(`delete from task_update where employee_id in (${mine})`);
  await sql.unsafe(`delete from task where employee_id in (${mine})`);
  await sql.unsafe(`delete from employee where id in (${mine})`);
  await closeDb();
});

describe("attachments", () => {
  it("stores the file reference and metadata, never a local path", async () => {
    const who = await makeEmployee("ATT-uploader");
    const taskId = await createTask(who, "ATT task", true);

    const saved = await saveAttachments({
      files: [
        {
          fileId: "BQACAgUAAx0-EXAMPLE",
          fileUniqueId: "AgADuQ",
          fileName: "chiller-spec.pdf",
          mimeType: "application/pdf",
          fileSize: 20480,
          kind: "document",
        },
      ],
      uploadedBy: who,
      taskId,
    });

    expect(saved).toHaveLength(1);
    const sql = getServiceSql();
    const rows = await sql<{ file_id: string; file_name: string; kind: string }[]>`
      select file_id, file_name, kind from attachment where id = ${saved[0]!.id}`;
    expect(rows[0]!.file_id).toBe("BQACAgUAAx0-EXAMPLE");
    expect(rows[0]!.file_name).toBe("chiller-spec.pdf");
    expect(rows[0]!.kind).toBe("document");
  });

  it("caps how many files one message can bring in", async () => {
    const who = await makeEmployee("ATT-flood");
    const many = Array.from({ length: 25 }, (_, i) => ({
      fileId: `flood-${i}`,
      kind: "document" as const,
    }));
    const saved = await saveAttachments({ files: many, uploadedBy: who });
    // Bounded (CLAUDE.md rule 4): a model or a client cannot drive unbounded writes.
    expect(saved.length).toBeLessThanOrEqual(10);
  });

  it("attaches files to an assignment and queues each one for delivery", async () => {
    const ceo = await makeEmployee("ATT-ceo");
    const worker = await makeEmployee("ATT-worker");

    const res = await assignTask({
      assignedBy: ceo,
      assignedTo: worker,
      title: "Fix the van 2 chiller",
      attachments: [
        { fileId: "file-a", fileName: "spec.pdf", kind: "document" },
        { fileId: "file-b", fileName: null, kind: "photo" },
      ],
    });

    expect(res.attachments).toBe(2);
    const stored = await listAttachmentsForAssignment(res.assignmentId);
    expect(stored.map((f) => f.fileId).sort()).toEqual(["file-a", "file-b"]);

    // Each file is its own outbox row, so one failing file cannot block the
    // instruction, and a retry cannot double-send.
    const sql = getServiceSql();
    const queued = await sql<{ idempotency_key: string }[]>`
      select idempotency_key from notification_outbox
      where idempotency_key = any(${stored.map((f) => `attachment-${f.id}`)})`;
    expect(queued).toHaveLength(2);
  });

  it("describes a file for a human without exposing where it lives", () => {
    const line = describeAttachment({ kind: "document", fileName: "spec.pdf", fileSize: 20480 });
    expect(line).toContain("spec.pdf");
    expect(line).toContain("20 KB");
    expect(line).not.toContain("/");
  });
});
