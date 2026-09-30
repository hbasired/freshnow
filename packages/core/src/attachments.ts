import { logAudit } from "./audit.js";
import { getServiceSql } from "./db.js";
import { inspectFile, MAX_FILE_BYTES, type SafetyReport } from "./document-security.js";

/**
 * Files that arrive with an assignment or a status report.
 *
 * We keep Telegram's `file_id` and the metadata, never the bytes — Telegram accepts a
 * file_id where an upload is expected, so forwarding a spec sheet to the person doing
 * the job is a reference pass. Nothing about the document is inferred by a model; a
 * file is evidence attached to a record, not an input to a decision.
 */

/** A file as Telegram described it, before we know what it belongs to. */
export interface IncomingFile {
  fileId: string;
  fileUniqueId?: string | null;
  fileName?: string | null;
  mimeType?: string | null;
  fileSize?: number | null;
  kind: "document" | "photo" | "voice" | "video" | "audio";
  caption?: string | null;
  /**
   * Set by the file gate when the bytes were checked (gateIncomingDocument). `false` = the file
   * may be read but must never reach another person — saveAttachments will not store it.
   */
  mayForward?: boolean;
}

export interface StoredAttachment extends IncomingFile {
  id: string;
}

/** Bounded: a single message cannot drag an unlimited number of files into the DB. */
export const MAX_ATTACHMENTS = 10;

/**
 * The file gate for a document someone sends to be held and passed on (TASK-051).
 *
 * Attachments travel by Telegram file_id — the bytes never come here — which used to mean a
 * document sent "for Rashid" reached Rashid without any check at all: no virus scan, no look at
 * what it really is. So a document is now fetched ONCE when it arrives and put through the same
 * gate as a document to be read (size, dangerous names, true type, ClamAV, structure). Refused
 * files are never held. Files that may be read but not passed on are held with
 * `mayForward: false`, and saveAttachments drops them.
 *
 * Photos are not fetched: Telegram re-encodes a photo into a new JPEG on its servers, so what
 * we forward is Telegram's image, not the sender's file [believed]. A picture sent "as a file"
 * arrives as a document and goes through this gate.
 */
export type GateResult =
  | { hold: true; file: IncomingFile; report: SafetyReport }
  | { hold: false; reason: "too_large" | "download_failed" | "refused"; report?: SafetyReport; detail?: string };

export async function gateIncomingDocument(p: {
  file: IncomingFile;
  uploadedBy: string;
  /** How to fetch the bytes — injected, so the gate knows nothing about Telegram. */
  download: () => Promise<Uint8Array>;
}): Promise<GateResult> {
  if (p.file.fileSize != null && p.file.fileSize > MAX_FILE_BYTES) return { hold: false, reason: "too_large" };
  let bytes: Uint8Array;
  try {
    bytes = await p.download();
  } catch (err) {
    // Fail closed: a file that could not be checked is not held. Re-sending is one tap.
    return { hold: false, reason: "download_failed", detail: err instanceof Error ? err.message : String(err) };
  }
  const report = await inspectFile({ bytes, declaredName: p.file.fileName, declaredMime: p.file.mimeType, uploadedBy: p.uploadedBy });
  if (!report.mayRead) return { hold: false, reason: "refused", report };
  return { hold: true, file: { ...p.file, mayForward: report.mayForward }, report };
}

export async function saveAttachments(p: {
  files: readonly IncomingFile[];
  uploadedBy: string;
  assignmentId?: string | null;
  taskId?: string | null;
  taskUpdateId?: string | null;
  correlationId?: string;
}): Promise<StoredAttachment[]> {
  // The last line of defence for every path that attaches held files (reports, assignments,
  // document plans): a file the gate said must not be passed on is not stored, so nothing can
  // later forward it.
  const withheld = p.files.filter((f) => f.mayForward === false);
  if (withheld.length) {
    await logAudit({
      correlationId: p.correlationId,
      actor: `employee:${p.uploadedBy}`,
      action: "attachment.withheld",
      entity: p.assignmentId ? "assignment" : p.taskUpdateId ? "task_update" : "task",
      entityId: p.assignmentId ?? p.taskUpdateId ?? p.taskId ?? undefined,
      detail: { count: withheld.length, names: withheld.map((f) => f.fileName ?? f.kind) },
    });
  }
  const files = p.files.filter((f) => f.mayForward !== false).slice(0, MAX_ATTACHMENTS);
  if (files.length === 0) return [];
  const sql = getServiceSql();
  const out: StoredAttachment[] = [];

  for (const f of files) {
    const rows = await sql<{ id: string }[]>`
      insert into attachment
        (assignment_id, task_id, task_update_id, uploaded_by,
         file_id, file_unique_id, file_name, mime_type, file_size, kind, caption)
      values (${p.assignmentId ?? null}, ${p.taskId ?? null}, ${p.taskUpdateId ?? null},
              ${p.uploadedBy}, ${f.fileId}, ${f.fileUniqueId ?? null}, ${f.fileName ?? null},
              ${f.mimeType ?? null}, ${f.fileSize ?? null}, ${f.kind}, ${f.caption ?? null})
      returning id`;
    out.push({ ...f, id: rows[0]!.id });
  }

  await logAudit({
    correlationId: p.correlationId,
    actor: `employee:${p.uploadedBy}`,
    action: "attachment.stored",
    entity: p.assignmentId ? "assignment" : p.taskUpdateId ? "task_update" : "task",
    entityId: p.assignmentId ?? p.taskUpdateId ?? p.taskId ?? undefined,
    // Names only — never the content, and never a file path on this machine.
    detail: { count: out.length, names: out.map((f) => f.fileName ?? f.kind) },
  });

  return out;
}

export async function listAttachmentsForAssignment(assignmentId: string): Promise<StoredAttachment[]> {
  const sql = getServiceSql();
  const rows = await sql<
    {
      id: string;
      file_id: string;
      file_unique_id: string | null;
      file_name: string | null;
      mime_type: string | null;
      file_size: number | null;
      kind: StoredAttachment["kind"];
      caption: string | null;
    }[]
  >`select id, file_id, file_unique_id, file_name, mime_type, file_size, kind, caption
      from attachment where assignment_id = ${assignmentId} order by created_at`;
  return rows.map((r) => ({
    id: r.id,
    fileId: r.file_id,
    fileUniqueId: r.file_unique_id,
    fileName: r.file_name,
    mimeType: r.mime_type,
    fileSize: r.file_size,
    kind: r.kind,
    caption: r.caption,
  }));
}

/** A one-line description for a Telegram message or a dashboard cell. */
export function describeAttachment(f: Pick<StoredAttachment, "kind" | "fileName" | "fileSize">): string {
  const icon = f.kind === "photo" ? "🖼" : f.kind === "voice" || f.kind === "audio" ? "🎧" : "📄";
  const size = f.fileSize ? ` (${Math.round(f.fileSize / 1024)} KB)` : "";
  return `${icon} ${f.fileName ?? f.kind}${size}`;
}
