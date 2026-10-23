import { randomUUID } from "node:crypto";
import { scanBytes } from "./antivirus.js";
import { logAudit } from "./audit.js";
import { getServiceSql, withContext, type AppContext, type Tx } from "./db.js";
import { QueueFullError, mediaStoreSemaphore } from "./concurrency.js";
import { MediaError, cleanMp4, cleanPhoto, sha256, sniff } from "./media-process.js";
import { mediaStore } from "./media-store.js";

/**
 * Photos and short videos (TASK-058): accept, clean, store, read back — and let go when their time
 * is up. The order is the point: scan the bytes as they arrived, clean them (no location, no device
 * tags), name them by their cleaned content, store them, and only then record them. A read is
 * checked under row-level security before a byte is fetched from Storage.
 */

/**
 * How long each kind is kept, in days — the plan's proposals (§11), [assumed] until FreshNow decides
 * (A-T58.1). Each can be changed with MEDIA_RETENTION_<CLASS>_DAYS.
 */
export const MEDIA_RETENTION_DEFAULT_DAYS = { evidence: 180, video: 30, receipt: 1825, chat: 365 } as const;
export type RetentionClass = keyof typeof MEDIA_RETENTION_DEFAULT_DAYS;
export const RETENTION_CLASSES = Object.keys(MEDIA_RETENTION_DEFAULT_DAYS) as RetentionClass[];

export function mediaRetentionDays(env: NodeJS.ProcessEnv = process.env): Record<RetentionClass, number> {
  const out = { ...MEDIA_RETENTION_DEFAULT_DAYS } as Record<RetentionClass, number>;
  for (const c of RETENTION_CLASSES) {
    const v = Number(env[`MEDIA_RETENTION_${c.toUpperCase()}_DAYS`]);
    if (Number.isInteger(v) && v >= 1 && v <= 3650) out[c] = v;
  }
  return out;
}

export interface StoredMedia {
  id: string;
  kind: "photo" | "video";
  mime: "image/jpeg" | "video/mp4";
  bytes: number;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  /** The class it is kept under — decided here, from what it is (D212), not by the sender. */
  retention: RetentionClass;
  /** This person had already sent the same picture; this is their record of it. */
  duplicate: boolean;
}

/** What a sender may ask for. A video is always a video; "chat" is set by the chat module itself. */
export type RequestedRetention = "evidence" | "receipt" | "chat";

const MONTH = (d: Date): string => `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, "0")}`;

/**
 * At most this many photos are decoded at once in one process: sharp works off-thread, and a burst of
 * full-size decodes would otherwise crowd Postgres out of the box's CPU and memory (TASK-058 review).
 */
const MAX_DECODES = 2;
let decoding = 0;
const waitingToDecode: Array<() => void> = [];
/** Photos waiting for a decoder beyond this are refused as busy: a queue with no end is memory with no end. */
const MAX_WAITING_DECODES = 20;
async function oneAtATime<T>(fn: () => Promise<T>): Promise<T> {
  if (decoding >= MAX_DECODES && waitingToDecode.length >= MAX_WAITING_DECODES) {
    throw new MediaError("Too many photos are being processed right now. Please send it again in a minute.", 503);
  }
  // A loop: a woken waiter looks again before it takes a place (review 2026-10-17, live-updates-media#8).
  while (decoding >= MAX_DECODES) await new Promise<void>((go) => waitingToDecode.push(go));
  decoding++;
  try {
    return await fn();
  } finally {
    decoding--;
    waitingToDecode.shift()?.();
  }
}

export async function storeMedia(p: {
  bytes: Uint8Array;
  uploadedBy: string;
  retention?: RequestedRetention;
  /** When the phone says it was taken — sent by the app, never read from the file. */
  capturedAt?: Date | null;
  correlationId?: string;
  isSynthetic?: boolean;
}): Promise<StoredMedia> {
  const store = mediaStore();
  if (!store) throw new MediaError("Photos and videos cannot be stored here yet: media storage is not set up.", 503);
  const correlationId = p.correlationId ?? randomUUID();
  const sql = getServiceSql();

  // Every attempt that costs work is counted against the sender's hourly limit — a refusal and a
  // re-send as much as a stored file (rate-limit.ts, LIMITS.media). Faults of ours (503) are not.
  const refuse = async (message: string, status: number, reason: string): Promise<never> => {
    await logAudit({ correlationId, actor: `employee:${p.uploadedBy}`, action: "media.refused", entity: "employee", entityId: p.uploadedBy, detail: { reason, status } });
    throw new MediaError(message, status);
  };

  // A phone's clock can be wrong, but not by decades: a time Postgres would refuse, or a picture "taken"
  // tomorrow, is refused before any work (review 2026-10-17, live-updates-media#1).
  if (p.capturedAt && (Number.isNaN(p.capturedAt.getTime()) || p.capturedAt.getTime() < Date.UTC(2000, 0, 1) || p.capturedAt.getTime() > Date.now() + 86_400_000)) {
    return refuse("The time the photo says it was taken is not believable — check the phone's clock.", 400, "captured_at");
  }
  const type = sniff(p.bytes);
  if (type === "image/heic") return refuse("HEIC photos are not accepted — please send a JPEG.", 415, "heic");
  if (type === "unknown") return refuse("Only photos (JPEG, PNG or WebP) and MP4 videos are accepted.", 415, "type");
  const kind = type === "video/mp4" ? "video" : "photo";

  // The bytes as they arrived, before anything decodes them. A configured scanner that cannot be
  // reached refuses the file (fail closed, as attachments do): a gap in a scanner someone set up
  // must not be silent.
  const scan = await scanBytes(p.bytes);
  if (scan.status === "infected") {
    await logAudit({ correlationId, actor: `employee:${p.uploadedBy}`, action: "media.refused_infected", entity: "employee", entityId: p.uploadedBy, detail: { signature: scan.signature } });
    throw new MediaError("That file was refused by the virus check.", 422);
  }
  if (scan.status === "error") throw new MediaError("The file could not be checked for viruses just now. Please try again in a minute.", 503);

  let cleaned: Buffer;
  let thumb: Buffer | null = null;
  let width: number | null = null;
  let height: number | null = null;
  let durationMs: number | null = null;
  let stripped: Record<string, unknown>;
  try {
    if (kind === "photo") {
      const c = await oneAtATime(() => cleanPhoto(p.bytes));
      cleaned = c.bytes;
      thumb = c.thumb;
      width = c.width;
      height = c.height;
      stripped = { metadata: "all (re-encoded)" };
    } else {
      const c = cleanMp4(p.bytes);
      if (c.durationMs === null) return refuse("That video has no readable length — please record it again.", 422, "no_duration");
      if (c.durationMs > 15_000) return refuse("Videos may be 15 seconds at most.", 413, "too_long");
      cleaned = c.bytes;
      durationMs = c.durationMs;
      stripped = { mp4_boxes: c.neutralised };
    }
  } catch (err) {
    if (err instanceof MediaError && err.status !== 503) return refuse(err.message, err.status, "unreadable");
    throw err;
  }

  // How long it is kept follows from what it is: a video is a video (30 days by default), whatever the
  // sender asked; a photo is evidence unless it is a receipt; "chat" only from the chat module.
  const retention: RetentionClass = kind === "video" ? "video" : p.retention === "receipt" ? "receipt" : p.retention === "chat" ? "chat" : "evidence";
  const now = new Date();
  const until = new Date(now.getTime() + mediaRetentionDays()[retention] * 86_400_000);
  const hash = sha256(cleaned);

  const ext = kind === "photo" ? "jpg" : "mp4";
  const mime = kind === "photo" ? "image/jpeg" : "video/mp4";
  const periods = mediaRetentionDays();
  type Mine = { id: string; kind: "photo" | "video"; mime: "image/jpeg" | "video/mp4"; bytes: number; width: number | null; height: number | null; duration_ms: number | null; retention_class: RetentionClass };
  // Bytes this upload put into Storage — taken back if its record is never written (review #1).
  const put: string[] = [];
  let outcome:
    | { mine: Mine; longer: boolean }
    | { id: string; inserted: boolean; shared: boolean };
  try {
    outcome = await mediaStoreSemaphore.run(() => sql.begin(async (tx) => {
      // One upload or removal of these bytes at a time: a removal deciding they are unneeded while an
      // upload decides they are shared would leave the new record pointing at nothing (review
      // 2026-10-17, live-updates-media#2). mediaRetentionSweep and forgetMediaOf take the same lock.
      await tx`select pg_advisory_xact_lock(hashtextextended(${`media:${hash}`}, 0))`;
      // This person sent the same picture before: their record, kept at least as long as now asked.
      const mine = (await tx<Mine[]>`
        select id, kind, mime, bytes, width, height, duration_ms, retention_class
          from media_object where sha256 = ${hash} and uploaded_by = ${p.uploadedBy}`)[0];
      if (mine) {
        // Kept as whichever class keeps it longer under today's periods; asking for less never shortens it.
        const longer = periods[retention] > periods[mine.retention_class];
        if (longer) {
          await tx`update media_object set retention_class = ${retention},
                         retention_until = uploaded_at + make_interval(days => ${periods[retention]}) where id = ${mine.id}`;
        }
        return { mine, longer };
      }
      // Someone else already sent these exact bytes: they are stored once, and this person gets a record
      // of their own pointing at them — never the other person's record, which they may not be allowed to see.
      const shared = (await tx<{ storage_path: string; thumb_path: string | null }[]>`
        select storage_path, thumb_path from media_object where sha256 = ${hash} limit 1`)[0];
      const path = shared?.storage_path ?? `${MONTH(now)}/${hash}.${ext}`;
      const thumbPath = shared ? shared.thumb_path : thumb ? `thumbs/${hash}.jpg` : null;
      if (!shared) {
        await store.put(path, cleaned, mime);
        put.push(path);
        if (thumb && thumbPath) {
          await store.put(thumbPath, thumb, "image/jpeg");
          put.push(thumbPath);
        }
      }
      const [row] = await tx<{ id: string }[]>`
        insert into media_object (sha256, kind, mime, bytes, width, height, duration_ms, storage_path, thumb_path, uploaded_by,
          captured_at, uploaded_at, retention_class, retention_until, scan_status, stripped, is_synthetic, correlation_id)
        values (${hash}, ${kind}, ${mime}, ${cleaned.length}, ${width}, ${height}, ${durationMs}, ${path}, ${thumbPath}, ${p.uploadedBy},
          ${p.capturedAt ?? null}, ${now}, ${retention}, ${until}, ${scan.status === "clean" ? "clean" : "not_scanned"},
          ${tx.json(stripped as never)}, ${p.isSynthetic ?? false}, ${correlationId})
        on conflict (uploaded_by, sha256) do nothing
        returning id`;
      const id = row?.id ?? (await tx<{ id: string }[]>`select id from media_object where sha256 = ${hash} and uploaded_by = ${p.uploadedBy}`)[0]!.id;
      return { id, inserted: Boolean(row), shared: Boolean(shared) };
    }));
  } catch (err) {
    if (put.length > 0) await store.remove(put).catch(() => {});
    if (err instanceof QueueFullError) {
      throw new MediaError("Too many photos and videos are being sent right now. Please send it again in a minute.", 503);
    }
    throw err;
  }

  if ("mine" in outcome) {
    const { mine, longer } = outcome;
    await logAudit({ correlationId, actor: `employee:${p.uploadedBy}`, action: "media.duplicate", entity: "media_object", entityId: mine.id, detail: { retention: longer ? retention : mine.retention_class, extended: longer } });
    return { id: mine.id, kind: mine.kind, mime: mine.mime, bytes: mine.bytes, width: mine.width, height: mine.height, durationMs: mine.duration_ms, retention: longer ? retention : mine.retention_class, duplicate: true };
  }
  const { id, inserted, shared } = outcome;
  await logAudit({
    correlationId,
    actor: `employee:${p.uploadedBy}`,
    action: inserted ? "media.stored" : "media.duplicate",
    entity: "media_object",
    entityId: id,
    detail: { kind, bytes: cleaned.length, retention, scanned: scan.status === "clean", stripped, sharedBytes: shared },
  });
  return { id, kind, mime, bytes: cleaned.length, width, height, durationMs, retention, duplicate: !inserted };
}

/**
 * Of these stored paths, the ones no remaining record needs — the bytes that may go. A picture two
 * people sent is stored once; it stays while either record does.
 */
async function unneededPaths(q: Tx, paths: string[], leaving: string[]): Promise<string[]> {
  if (paths.length === 0) return [];
  const still = await q<{ storage_path: string; thumb_path: string | null }[]>`
    select storage_path, thumb_path from media_object
     where (storage_path = any(${paths}) or thumb_path = any(${paths})) and not (id = any(${leaving}))`;
  const keep = new Set(still.flatMap((s) => [s.storage_path, ...(s.thumb_path ? [s.thumb_path] : [])]));
  return [...new Set(paths)].filter((x) => !keep.has(x));
}

/** The bytes of a file this viewer may see — null when they may not, or it is gone. */
export async function readMedia(
  viewer: AppContext,
  id: string,
  variant: "full" | "thumb" = "full",
): Promise<{ bytes: Uint8Array; mime: string } | null> {
  const store = mediaStore();
  if (!store) throw new MediaError("Media storage is not set up.", 503);
  const rows = await withContext(viewer, (sql) => sql<{ storage_path: string; thumb_path: string | null; mime: string }[]>`
    select storage_path, thumb_path, mime from media_object where id = ${id}`, { readOnly: true });
  const r = rows[0];
  if (!r) return null;
  const path = variant === "thumb" ? r.thumb_path : r.storage_path;
  if (!path) return null;
  const bytes = await store.get(path);
  return bytes ? { bytes, mime: variant === "thumb" ? "image/jpeg" : r.mime } : null;
}

/**
 * Attach a file to a task. Both must be visible to the person attaching (their own task, or one of
 * someone they lead), checked under their row-level security.
 */
export async function linkMediaToTask(p: {
  viewer: AppContext & { employeeId: string };
  mediaId: string;
  taskId: string;
  role?: "evidence" | "receipt" | "other";
  correlationId?: string;
}): Promise<{ linked: boolean }> {
  const visible = await withContext(p.viewer, (sql) => sql<{ media: boolean; task: boolean }[]>`
    select exists (select 1 from media_object where id = ${p.mediaId}) as media,
           exists (select 1 from task where id = ${p.taskId}) as task`, { readOnly: true });
  if (!visible[0]?.media || !visible[0].task) return { linked: false };
  const role = p.role ?? "evidence";
  const r = await getServiceSql()`
    insert into media_link (media_id, entity_type, entity_id, role, linked_by, correlation_id)
    values (${p.mediaId}, 'task', ${p.taskId}, ${role}, ${p.viewer.employeeId}, ${p.correlationId ?? null})
    on conflict do nothing`;
  // Which evidence was attached to which task, by whom — kept after the link itself is gone.
  if (r.count > 0) {
    await logAudit({
      correlationId: p.correlationId ?? randomUUID(),
      actor: `employee:${p.viewer.employeeId}`,
      action: "media.linked",
      entity: "task",
      entityId: p.taskId,
      detail: { mediaId: p.mediaId, role },
    });
  }
  return { linked: r.count > 0 };
}

/**
 * Let go of files whose time is up: the bytes in Storage first, then the record (so a failure leaves
 * a record pointing at nothing, which the next sweep retries — never a file nobody knows about).
 * Bounded per run.
 *
 * Off until MEDIA_RETENTION=on, like the text sweep's RETENTION_DAYS: how long evidence is kept is
 * the data controller's decision, not a developer default (A-T58.1). Every file still records its
 * due date from the defaults, so switching it on acts at once.
 */
export async function mediaRetentionSweep(
  p: { now?: Date; limit?: number; correlationId?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<{ enabled: boolean; removed: number; redated: number }> {
  const env = p.env ?? process.env;
  const sql = getServiceSql();
  // Due dates follow the periods as they are NOW, not as they were when each file arrived: when the
  // data controller decides (A-T58.1), the decision applies to every file already kept — longer or
  // shorter — before anything is deleted against it (TASK-058 review). Done even while deletion is
  // off, so what the export says a file is kept until is always the current rule.
  const days = mediaRetentionDays(env);
  // The clock runs from the last time the file was attached to something, not only from its upload: a
  // picture sent again and attached to new work is new evidence (review 2026-10-17, live-updates-media#7).
  const redated = await sql`
    update media_object m
       set retention_until = greatest(m.uploaded_at, coalesce((select max(l.linked_at) from media_link l where l.media_id = m.id), m.uploaded_at))
                             + make_interval(days => d.days)
      from (values ('evidence', ${days.evidence}::int), ('video', ${days.video}::int),
                   ('receipt', ${days.receipt}::int), ('chat', ${days.chat}::int)) as d (class, days)
     where d.class = m.retention_class
       and m.retention_until is distinct from
           greatest(m.uploaded_at, coalesce((select max(l.linked_at) from media_link l where l.media_id = m.id), m.uploaded_at))
           + make_interval(days => d.days)`;
  if (env.MEDIA_RETENTION !== "on") return { enabled: false, removed: 0, redated: redated.count };
  const store = mediaStore();
  if (!store) return { enabled: true, removed: 0, redated: redated.count };
  const candidates = await sql<{ sha256: string }[]>`
    select sha256 from media_object
    where retention_until <= ${p.now ?? new Date()}
    order by retention_until limit ${p.limit ?? 200}`;
  if (candidates.length === 0) return { enabled: true, removed: 0, redated: redated.count };
  const due = await sql.begin(async (tx) => {
    // The same lock as an upload of these bytes (storeMedia): nothing is shared and removed at once.
    for (const h of [...new Set(candidates.map((c) => c.sha256))].sort()) await tx`select pg_advisory_xact_lock(hashtextextended(${`media:${h}`}, 0))`;
    // Under the lock, look again: a file sent again a moment ago may be kept longer now.
    const rows = await tx<{ id: string; storage_path: string; thumb_path: string | null }[]>`
      select id, storage_path, thumb_path from media_object
       where sha256 = any(${candidates.map((c) => c.sha256)}) and retention_until <= ${p.now ?? new Date()}`;
    const ids = rows.map((d) => d.id);
    // Bytes go only when no other record needs them (the same picture sent by someone else, kept longer).
    await store.remove(await unneededPaths(tx, rows.flatMap((d) => [d.storage_path, ...(d.thumb_path ? [d.thumb_path] : [])]), ids));
    await tx`delete from media_object where id = any(${ids})`;
    return rows;
  });
  const ids = due.map((d) => d.id);
  await logAudit({
    correlationId: p.correlationId ?? randomUUID(),
    actor: "system",
    action: "media.retention_removed",
    entity: "media_object",
    detail: { removed: due.length, ids: ids.slice(0, 50) },
  });
  return { enabled: true, removed: due.length, redated: redated.count };
}

/**
 * A person's own photos and videos go — bytes first, then the records — and so does every link
 * they made or that attaches a file to one of their tasks. For scripts/reset-employee.ts: clearing a
 * demo run, NOT erasing a person (erasure anonymises and keeps the evidence, A-T58.2). Nothing in this
 * schema cascades to employee, so without this a reset of anyone who ever sent a photo failed on a
 * foreign key. When the store is not configured the records are left alone and this refuses: a record
 * removed while its bytes stay would be a file nobody can find again, and nobody would ever delete.
 */
export async function forgetMediaOf(employeeId: string, p: { correlationId?: string } = {}): Promise<{ removed: number; unlinked: number }> {
  const sql = getServiceSql();
  const own = await sql<{ id: string; storage_path: string; thumb_path: string | null }[]>`
    select id, storage_path, thumb_path from media_object where uploaded_by = ${employeeId}`;
  const store = own.length > 0 ? mediaStore() : null;
  if (own.length > 0 && !store) {
    throw new MediaError(`${own.length} photo(s) or video(s) cannot be removed: the media store is not configured.`, 503);
  }
  const unlinked = await sql`
    delete from media_link
     where linked_by = ${employeeId}
        or (entity_type = 'task' and entity_id in (select id from task where employee_id = ${employeeId}))`;
  if (store) {
    const ids = own.map((m) => m.id);
    await sql.begin(async (tx) => {
      // The same lock as an upload of these bytes (storeMedia), so a picture someone sends right now is
      // not left pointing at bytes removed under it.
      const hashes = (await tx<{ sha256: string }[]>`select sha256 from media_object where id = any(${ids})`).map((r) => r.sha256);
      for (const h of [...new Set(hashes)].sort()) await tx`select pg_advisory_xact_lock(hashtextextended(${`media:${h}`}, 0))`;
      // A picture someone else also sent stays for them: only bytes no remaining record needs go.
      await store.remove(await unneededPaths(tx, own.flatMap((m) => [m.storage_path, ...(m.thumb_path ? [m.thumb_path] : [])]), ids));
      await tx`delete from media_object where id = any(${ids})`;
    });
  }
  if (own.length > 0 || unlinked.count > 0) {
    await logAudit({
      correlationId: p.correlationId ?? randomUUID(),
      actor: "system",
      action: "media.forgotten",
      entity: "employee",
      entityId: employeeId,
      detail: { removed: own.length, unlinked: unlinked.count, ids: own.slice(0, 50).map((m) => m.id) },
    });
  }
  return { removed: own.length, unlinked: unlinked.count };
}
