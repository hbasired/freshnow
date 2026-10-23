/**
 * Where cleaned photos and videos are kept: Supabase Storage (TASK-058, user decision 2026-10-15),
 * in one private bucket. The API reaches it with SUPABASE_SECRET_KEY — a key that also unlocks the
 * Data API — so this client is deliberately narrow, like the Televend connector: it calls only the
 * Storage object and bucket endpoints, only in the media bucket, and only for paths of the two
 * shapes the media module writes (content-addressed). Anything else is refused before a request.
 *
 * Request shapes are those of the official client (@supabase/storage-js 2.116, read 2026-10-15) and
 * were checked live against storage-api v1.82.1: POST/GET /object/{bucket}/{path}, DELETE
 * /object/{bucket} with { prefixes }, POST /bucket.
 */

export interface MediaStore {
  put(path: string, bytes: Uint8Array, contentType: string): Promise<void>;
  /** Null when there is no such object. */
  get(path: string): Promise<Uint8Array | null>;
  remove(paths: readonly string[]): Promise<void>;
}

export const MEDIA_BUCKET = "media";

/** `2026/10/<sha256>.jpg|mp4` for the file, `thumbs/<sha256>.jpg` for its thumbnail. */
const PATH_SHAPE = /^(?:\d{4}\/\d{2}\/[0-9a-f]{64}\.(?:jpg|mp4)|thumbs\/[0-9a-f]{64}\.jpg)$/;

export class MediaStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MediaStoreError";
  }
}

function checkedPath(path: string): string {
  if (!PATH_SHAPE.test(path)) throw new MediaStoreError(`refused: "${path}" is not a media path`);
  return path;
}

type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: Uint8Array | string; signal?: AbortSignal }) => Promise<{
  status: number;
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
}>;

/** How long a write (up to 50 MiB, over the box's own network) and a read may take before they are given up. */
const STORE_PUT_TIMEOUT_MS = 60_000;
const STORE_READ_TIMEOUT_MS = 30_000;

export class SupabaseMediaStore implements MediaStore {
  private bucketReady: Promise<void> | null = null;
  private readonly base: string;

  constructor(
    supabaseUrl: string,
    private readonly key: string,
    private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike,
  ) {
    const u = new URL(supabaseUrl);
    if (u.protocol !== "https:" && !["127.0.0.1", "localhost", "::1"].includes(u.hostname)) {
      throw new MediaStoreError("SUPABASE_URL must be https outside this machine");
    }
    this.base = `${u.origin}/storage/v1`;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { apikey: this.key, Authorization: `Bearer ${this.key}`, ...extra };
  }

  /** The bucket is made on first use: private, 50 MiB, the four kinds the media module writes. */
  private ensureBucket(): Promise<void> {
    this.bucketReady ??= (async () => {
      const r = await this.fetchImpl(`${this.base}/bucket`, {
        method: "POST",
        headers: this.headers({ "content-type": "application/json" }),
        body: JSON.stringify({
          id: MEDIA_BUCKET,
          name: MEDIA_BUCKET,
          public: false,
          file_size_limit: 50 * 1024 * 1024,
          allowed_mime_types: ["image/jpeg", "video/mp4"],
        }),
        signal: AbortSignal.timeout(STORE_READ_TIMEOUT_MS),
      });
      // 200 created; an existing bucket answers 400/409 "already exists" — both mean ready.
      if (r.status !== 200 && !/already exists|Duplicate/i.test(await r.text())) {
        throw new MediaStoreError(`storage bucket could not be prepared (HTTP ${r.status})`);
      }
    })().catch((err: unknown) => {
      // Any failure — a refused connection while Storage starts, a timeout, a bad answer — is tried again on the next upload,
      // never remembered for the life of the process (review of the fixes, 20 Oct).
      this.bucketReady = null;
      throw err;
    });
    return this.bucketReady;
  }

  async put(path: string, bytes: Uint8Array, contentType: string): Promise<void> {
    await this.ensureBucket();
    // Content-addressed: the same path always holds the same bytes, so replacing is harmless.
    // Bounded: an upload runs inside a database transaction (media.ts), which must not wait on a storage that hangs (review, 20 Oct).
    const r = await this.fetchImpl(`${this.base}/object/${MEDIA_BUCKET}/${checkedPath(path)}`, {
      method: "POST",
      headers: this.headers({ "content-type": contentType, "x-upsert": "true", "cache-control": "max-age=31536000" }),
      body: bytes,
      signal: AbortSignal.timeout(STORE_PUT_TIMEOUT_MS),
    });
    if (r.status !== 200) throw new MediaStoreError(`storage refused the upload (HTTP ${r.status})`);
  }

  async get(path: string): Promise<Uint8Array | null> {
    const r = await this.fetchImpl(`${this.base}/object/${MEDIA_BUCKET}/${checkedPath(path)}`, {
      headers: this.headers(),
      signal: AbortSignal.timeout(STORE_READ_TIMEOUT_MS),
    });
    if (r.status === 200) return new Uint8Array(await r.arrayBuffer());
    if (r.status === 400 || r.status === 404) {
      // "No such file" only when storage says the OBJECT is missing ("not_found", NoSuchKey). A missing bucket — storage-api
      // says "Bucket not found" with the same status — is an outage to report, never "no such file" (review 2026-10-17,
      // live-updates-media#11; and 20 Oct: the first fix still read both as missing).
      const body = await r.text().catch(() => "");
      let j: { error?: unknown; code?: unknown; message?: unknown } = {};
      try {
        j = JSON.parse(body) as typeof j;
      } catch {
        /* not JSON */
      }
      const said = `${String(j.error ?? "")} ${String(j.code ?? "")} ${String(j.message ?? "")} ${body}`;
      if (/bucket/i.test(said)) throw new MediaStoreError(`storage has no media bucket (HTTP ${r.status}: ${body.slice(0, 120)})`);
      if (j.error === "not_found" || j.code === "NoSuchKey" || /object not found/i.test(String(j.message ?? "")) || (r.status === 404 && body.trim() === "")) return null;
      throw new MediaStoreError(`storage refused the read (HTTP ${r.status}: ${body.slice(0, 120)})`);
    }
    throw new MediaStoreError(`storage could not read the file (HTTP ${r.status})`);
  }

  async remove(paths: readonly string[]): Promise<void> {
    if (paths.length === 0) return;
    const r = await this.fetchImpl(`${this.base}/object/${MEDIA_BUCKET}`, {
      method: "DELETE",
      headers: this.headers({ "content-type": "application/json" }),
      body: JSON.stringify({ prefixes: paths.map(checkedPath) }),
    });
    if (r.status !== 200) throw new MediaStoreError(`storage could not delete (HTTP ${r.status})`);
  }
}

/** For tests: the same contract, in memory. */
export class MemoryMediaStore implements MediaStore {
  readonly objects = new Map<string, { bytes: Uint8Array; contentType: string }>();
  async put(path: string, bytes: Uint8Array, contentType: string): Promise<void> {
    this.objects.set(checkedPath(path), { bytes, contentType });
  }
  async get(path: string): Promise<Uint8Array | null> {
    return this.objects.get(checkedPath(path))?.bytes ?? null;
  }
  async remove(paths: readonly string[]): Promise<void> {
    for (const p of paths) this.objects.delete(checkedPath(p));
  }
}

let override: MediaStore | null | undefined;
let configured: { key: string; store: MediaStore } | undefined;

/** Whether photos and videos can be stored at all — the privacy notice names them only then. */
export function mediaStoreConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.SUPABASE_URL && env.SUPABASE_SECRET_KEY);
}

/** The store this process uses: Supabase Storage when configured, else none (media refused). */
export function mediaStore(env: NodeJS.ProcessEnv = process.env): MediaStore | null {
  if (override !== undefined) return override;
  if (!mediaStoreConfigured(env)) return null;
  const url = env.SUPABASE_URL!;
  const key = env.SUPABASE_SECRET_KEY!;
  if (configured?.key !== `${url}|${key}`) configured = { key: `${url}|${key}`, store: new SupabaseMediaStore(url, key) };
  return configured.store;
}

/** Tests choose the store; undefined goes back to the environment. */
export function useMediaStoreForTests(store: MediaStore | null | undefined): void {
  override = store;
}
