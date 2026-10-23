import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { MEDIA_LIMITS, MediaError, checkRateLimit, linkMediaToTask, readMedia, storeMedia } from "@freshnow/core";
import { forbid, resolveViewer } from "../viewer.js";

/**
 * Photos and short videos over HTTP (TASK-058). Under /dashboard/*, so the auth hook guards both
 * routes (D71). Uploads are cleaned in core (no location, no device tags) before they are stored;
 * a read is checked under the viewer's row-level security before a byte leaves Supabase Storage,
 * and a file the viewer may not see answers exactly like one that does not exist.
 */

const UploadQuery = z.object({
  // What the sender may ask: a photo kept as evidence or as a receipt. A video is always kept as a
  // video, and "chat" is the chat module's own (core decides, D212).
  retention: z.enum(["evidence", "receipt"]).optional(),
  /** When the phone says it was taken (ISO 8601 with offset); never read from the file. */
  capturedAt: z.string().datetime({ offset: true }).optional(),
  /** Attach it to this task — one the sender may see. */
  taskId: z.string().uuid().optional(),
});
const IdParams = z.object({ id: z.string().uuid() });
const ReadQuery = z.object({ variant: z.enum(["full", "thumb"]).optional() });

/** Uploads each person has in progress — at most two at a time. */
const uploadsInFlight = new Map<string, number>();
const MAX_UPLOADS_IN_FLIGHT = 2;

export function registerMediaRoutes(app: FastifyInstance): void {
  /** Send one photo or short video, as multipart field "file". Anyone active, for their own work. */
  app.post("/dashboard/media", async (req, reply) => {
    const viewer = await resolveViewer(req);
    if (viewer.status !== "active") return forbid(req, reply, "Your account is not active");
    const q = UploadQuery.parse(req.query);
    const refuse = (status: number, code: string, message: string) =>
      reply.code(status).send({ error: { code, message, correlationId: req.correlationId } });

    const rl = await checkRateLimit({ key: "media", employeeId: viewer.employeeId });
    if (!rl.allowed) return refuse(429, "rate_limited", rl.message);
    // The hourly limit counts finished attempts, so uploads sent in parallel all passed it at once and
    // each buffered up to 50 MB (review 2026-10-17, live-updates-media#6): a person sends two at a time.
    const inFlight = uploadsInFlight.get(viewer.employeeId) ?? 0;
    if (inFlight >= MAX_UPLOADS_IN_FLIGHT) return refuse(429, "busy", "Wait for your other photos to finish sending.");
    uploadsInFlight.set(viewer.employeeId, inFlight + 1);
    const receive = async () => {
      // Above the 15 MB document cap set for the whole server: a 15-second video is bigger.
      const part = await req.file({ limits: { files: 1, fileSize: MEDIA_LIMITS.videoBytes } });
      if (!part) return refuse(400, "no_file", "Attach a photo or a video");
      let bytes: Uint8Array;
      try {
        bytes = new Uint8Array(await part.toBuffer());
      } catch (err) {
        if ((err as { code?: string }).code === "FST_REQ_FILE_TOO_LARGE") return refuse(413, "too_large", "That file is too large (50 MB at most).");
        throw err;
      }
      try {
        const m = await storeMedia({
          bytes,
          uploadedBy: viewer.employeeId,
          ...(q.retention ? { retention: q.retention } : {}),
          capturedAt: q.capturedAt ? new Date(q.capturedAt) : null,
          correlationId: req.correlationId,
        });
        const linked = q.taskId
          ? (await linkMediaToTask({ viewer, mediaId: m.id, taskId: q.taskId, correlationId: req.correlationId })).linked
          : false;
        return reply.code(m.duplicate ? 200 : 201).send({ ...m, linked });
      } catch (err) {
        if (err instanceof MediaError) return refuse(err.status, "media_refused", err.message);
        throw err;
      }
    };
    try {
      return await receive();
    } finally {
      const left = (uploadsInFlight.get(viewer.employeeId) ?? 1) - 1;
      if (left > 0) uploadsInFlight.set(viewer.employeeId, left);
      else uploadsInFlight.delete(viewer.employeeId);
    }
  });

  /** A file this viewer may see; its small preview with ?variant=thumb. */
  app.get("/dashboard/media/:id", async (req, reply) => {
    const { id } = IdParams.parse(req.params);
    const { variant } = ReadQuery.parse(req.query);
    const viewer = await resolveViewer(req);
    const m = await readMedia(viewer, id, variant ?? "full");
    if (!m) return reply.code(404).send({ error: { code: "not_found", message: "No such file", correlationId: req.correlationId } });
    return reply
      .header("content-type", m.mime)
      .header("cache-control", "private, max-age=300")
      .header("x-content-type-options", "nosniff")
      .header("content-disposition", "inline")
      .send(Buffer.from(m.bytes));
  });
}
