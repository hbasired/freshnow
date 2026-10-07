import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  assignTask,
  canAssignTo,
  checkRateLimit,
  decodeTextFile,
  documentSemaphore,
  extractPdfText,
  inspectFile,
  listEmployees,
  MAX_DOC_TASKS,
  planDocumentTasks,
  planningDirectory,
  safeFileName,
} from "@freshnow/core";
import { forbid, resolveViewer } from "../viewer.js";

/**
 * A work document, uploaded in the browser, becomes tasks for the right people.
 *
 * Same pipeline as a PDF sent to the bot, in the same order, for the same reasons:
 * the safety gate runs on the BYTES before any parser touches them (the declared name
 * and MIME type come from the sender and are trivially wrong); extraction runs inside the
 * narrow document semaphore so two uploads cannot starve everyone's status messages; the
 * plan is a PROPOSAL the person confirms — the model never assigns anything by itself.
 *
 * One honest difference from the bot: the file is not forwarded to anyone. Attachments in
 * this system are Telegram file ids, and a browser upload has none. Forwarding would mean
 * the worker uploading bytes to Telegram and storing the returned id — planned, not built,
 * and the response says so rather than leaving a missing file to be discovered.
 */

const PDF = /\.pdf$/i;

const ApplyBody = z.object({
  fileName: z.string().min(1).max(200),
  tasks: z
    .array(
      z.object({
        assignedTo: z.string().uuid(),
        title: z.string().min(3).max(200),
        detail: z.string().max(600).nullable().optional(),
      }),
    )
    .min(1)
    .max(MAX_DOC_TASKS),
});

export function registerDocumentRoutes(app: FastifyInstance): void {
  app.post("/dashboard/documents/plan", async (req, reply) => {
    const viewer = await resolveViewer(req);
    if (viewer.accessRole === "employee") {
      return forbid(req, reply, "Only somebody who assigns work can turn a document into tasks");
    }
    const actor = viewer.employeeId;
    const corr = req.correlationId;
    const refuse = (status: number, code: string, message: string) =>
      reply.code(status).send({ error: { code, message, correlationId: corr } });

    // Cap the expensive path before spending a parse and a model call on it.
    const rl = await checkRateLimit({ key: "document", employeeId: actor });
    if (!rl.allowed) return refuse(429, "rate_limited", rl.message);

    const part = await req.file();
    if (!part) return refuse(400, "no_file", "Attach a PDF or text file");
    const bytes = new Uint8Array(await part.toBuffer());
    const instructionField = part.fields["instruction"];
    const instruction =
      instructionField && !Array.isArray(instructionField) && instructionField.type === "field"
        ? String(instructionField.value).slice(0, 500)
        : null;
    const fileName = safeFileName(part.filename || "document");

    const safety = await inspectFile({
      bytes,
      declaredName: part.filename,
      declaredMime: part.mimetype,
      uploadedBy: actor,
      correlationId: corr,
    });
    if (!safety.mayRead) return refuse(422, "file_rejected", safety.reasons.join(" "));

    const doc = await documentSemaphore.run(() =>
      part.mimetype.includes("pdf") || PDF.test(part.filename ?? "")
        ? extractPdfText(bytes)
        : Promise.resolve(decodeTextFile(bytes)),
    );
    if (!doc.text.trim()) {
      // A scanned page has no text layer — a "needs a human" answer, never "no work found".
      return refuse(422, "no_text", "No text could be found in that file — it may be a scan or an image.");
    }

    // The whole (bounded) directory; the planner offers the model only the relevant people.
    const plan = await planDocumentTasks({
      text: doc.text,
      colleagues: await planningDirectory(actor),
      instruction,
      uploadedBy: actor,
      correlationId: corr,
    });

    return {
      fileName,
      pages: doc.pages,
      truncated: doc.truncated,
      safety: { verdict: safety.verdict, reasons: safety.reasons, mayForward: safety.mayForward },
      injection: { suspicious: plan.injection.suspicious, labels: plan.injection.labels },
      summary: plan.summary,
      needsOwner: plan.needsOwner,
      tasks: plan.tasks.map((t) => ({
        title: t.title,
        detail: t.detail,
        assigneeId: t.assignee?.id ?? null,
        assigneeName: t.assignee?.display_name ?? null,
        namedAs: t.namedAs,
        // "name" = the written name fits exactly this person; "ai" = only the model's reading.
        matchedBy: t.matchedBy,
        // The written name fits several people: the CEO chooses (people-match.ts).
        candidates: t.candidates.map((c) => ({ id: c.id, name: c.display_name })),
      })),
      // Stated up front rather than discovered.
      fileForwarded: false,
    };
  });

  app.post("/dashboard/documents/apply", async (req, reply) => {
    const body = ApplyBody.parse(req.body);
    const viewer = await resolveViewer(req);
    const actor = viewer.employeeId;
    // Every row is checked before any is written, so a batch is all-or-nothing on
    // permission: no half-assigned document.
    for (const t of body.tasks) {
      if (!(await canAssignTo(viewer, t.assignedTo))) {
        return forbid(req, reply, "One of these tasks is for somebody outside your team");
      }
    }

    const rl = await checkRateLimit({ key: "assignment", employeeId: actor });
    if (!rl.allowed) {
      return reply.code(429).send({ error: { code: "rate_limited", message: rl.message, correlationId: req.correlationId } });
    }

    const assigned = [];
    for (const t of body.tasks) {
      const provenance = `(from document: ${body.fileName})`;
      const res = await assignTask({
        assignedBy: actor,
        assignedTo: t.assignedTo,
        title: t.title,
        note: t.detail ? `${t.detail}\n\n${provenance}` : provenance,
        correlationId: req.correlationId,
        origin: "document",
      });
      assigned.push({ taskId: res.taskId, assignmentId: res.assignmentId, assignedTo: t.assignedTo, queued: res.delivered });
    }
    return reply.code(201).send({ assigned, fileForwarded: false });
  });
}
