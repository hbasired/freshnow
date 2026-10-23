import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { closeDb, getServiceSql, type AppContext } from "./db.js";
import { DEMO_CEO_ID } from "./meta.js";
import { forgetMediaOf, linkMediaToTask, mediaRetentionSweep, readMedia, storeMedia } from "./media.js";
import { MediaError } from "./media-process.js";
import { MemoryMediaStore, SupabaseMediaStore, useMediaStoreForTests } from "./media-store.js";
import { loadViewer } from "./org.js";
import { checkRateLimit } from "./rate-limit.js";
import { createTask } from "./updates.js";

/**
 * The media module against the real (throwaway) Postgres — never mocked — with an in-memory store
 * standing in for Supabase Storage (the live store is exercised by hand and recorded in TASK-058).
 *
 *   CEO ── SUP (supervisor) ── VMO      ← VMO sends the photos
 *   CEO ── ADM (admin)
 *   CEO ── OUT (employee)               ← sees nothing of VMO's
 */
const ids = { SUP: randomUUID(), VMO: randomUUID(), ADM: randomUUID(), OUT: randomUUID() };
type Who = keyof typeof ids;
const ctx = {} as Record<Who, AppContext & { employeeId: string }>;
let store: MemoryMediaStore;

const GPS = { GPSLatitudeRef: "N", GPSLatitude: "25/1 12/1 1728/100", GPSLongitudeRef: "E", GPSLongitude: "55/1 16/1 1428/100" };
const photo = (w: number, h: number, colour: string): Promise<Buffer> =>
  sharp({ create: { width: w, height: h, channels: 3, background: colour } }).jpeg().withExif({ IFD0: { Make: "TestPhone" }, IFD3: GPS }).toBuffer();
const box = (type: string, ...parts: Buffer[]): Buffer => {
  const body = Buffer.concat(parts);
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + body.length);
  head.write(type, 4, "latin1");
  return Buffer.concat([head, body]);
};
const video = (seconds: number): Buffer => {
  const mvhd = Buffer.alloc(100);
  mvhd.writeUInt32BE(1000, 12);
  mvhd.writeUInt32BE(seconds * 1000, 16);
  return Buffer.concat([
    box("ftyp", Buffer.from("isom\0\0\x02\0isommp41", "latin1")),
    box("moov", box("mvhd", mvhd), box("udta", box("\xa9xyz", Buffer.from("+25.2048+055.2708/", "latin1")))),
    box("mdat", Buffer.alloc(64, seconds)),
  ]);
};

beforeAll(async () => {
  const sql = getServiceSql();
  const person = (id: string, name: string, role: string, manager: string) =>
    sql`insert into employee (id, display_name, status, is_synthetic, access_role, manager_employee_id)
        values (${id}, ${"MEDIA-" + name}, 'active', true, ${role}, ${manager})`;
  await person(ids.SUP, "SUP", "supervisor", DEMO_CEO_ID);
  await person(ids.VMO, "VMO", "vmo", ids.SUP);
  await person(ids.ADM, "ADM", "admin", DEMO_CEO_ID);
  await person(ids.OUT, "OUT", "employee", DEMO_CEO_ID);
  for (const [k, id] of Object.entries(ids)) {
    const v = (await loadViewer(id))!;
    ctx[k as Who] = { employeeId: v.employeeId, isCeo: v.isCeo, accessRole: v.accessRole, department: v.department };
  }
});

afterEach(() => useMediaStoreForTests(undefined));

afterAll(async () => {
  const sql = getServiceSql();
  const all = Object.values(ids);
  await sql`delete from media_link where linked_by = any(${all})`;
  await sql`delete from media_object where uploaded_by = any(${all})`;
  await sql`delete from task where employee_id = any(${all})`;
  await sql`delete from audit_log where actor = any(${all.map((i) => `employee:${i}`)}) or action like 'media.%'`;
  await sql`update employee set manager_employee_id = null where id = any(${all})`;
  await sql`delete from employee where id = any(${all})`;
  await closeDb();
});

const fresh = (): MemoryMediaStore => {
  store = new MemoryMediaStore();
  useMediaStoreForTests(store);
  return store;
};

describe("the storage client (review 20 Oct, 059-fixes#3, #4)", () => {
  type Init = { method?: string; headers?: Record<string, string>; body?: Uint8Array | string; signal?: AbortSignal };
  const answer = (status: number, body: string) => ({ status, arrayBuffer: async () => new ArrayBuffer(0), text: async () => body });
  const P = `2026/10/${"a".repeat(64)}.jpg`;
  const storeWith = (reply: (url: string, init?: Init) => ReturnType<typeof answer>, seen: Init[] = []) =>
    new SupabaseMediaStore("http://127.0.0.1:54321", "test-key", async (url, init) => {
      seen.push(init ?? {});
      return url.endsWith("/bucket") ? answer(200, "{}") : reply(url, init);
    });

  it("reads a missing object as 'no such file' — and a missing bucket as the outage it is", async () => {
    expect(await storeWith(() => answer(400, JSON.stringify({ statusCode: "404", error: "not_found", message: "Object not found" }))).get(P)).toBeNull();
    expect(await storeWith(() => answer(404, "")).get(P)).toBeNull();
    await expect(storeWith(() => answer(400, JSON.stringify({ statusCode: "404", error: "Bucket not found", message: "Bucket not found" }))).get(P)).rejects.toThrow(
      /no media bucket/,
    );
    await expect(storeWith(() => answer(404, JSON.stringify({ error: "Bucket not found" }))).get(P)).rejects.toThrow(/no media bucket/);
    await expect(storeWith(() => answer(400, JSON.stringify({ error: "InvalidKey", message: "Invalid key" }))).get(P)).rejects.toThrow(/refused the read/);
  });

  it("tries the bucket again on the next upload after it failed — never remembers a failure for the life of the API", async () => {
    let bucketCalls = 0;
    const store = new SupabaseMediaStore("http://127.0.0.1:54321", "test-key", async (url) => {
      if (url.endsWith("/bucket")) {
        bucketCalls++;
        if (bucketCalls === 1) throw new Error("connect ECONNREFUSED");
        return answer(200, "{}");
      }
      return answer(200, "{}");
    });
    await expect(store.put(P, new Uint8Array([1]), "image/jpeg")).rejects.toThrow(/ECONNREFUSED/);
    await store.put(P, new Uint8Array([1]), "image/jpeg");
    expect(bucketCalls).toBe(2);
  });

  it("gives every read and write a deadline, so an upload never holds its database connection on a storage that hangs", async () => {
    const seen: Init[] = [];
    const store = storeWith(() => answer(200, "{}"), seen);
    await store.put(P, new Uint8Array([1, 2, 3]), "image/jpeg");
    await store.get(P);
    const objectCalls = seen.filter((x) => x.method !== "POST" || x.body instanceof Uint8Array);
    expect(objectCalls.length).toBeGreaterThanOrEqual(2);
    expect(objectCalls.every((x) => x.signal instanceof AbortSignal)).toBe(true);
  });
});

describe("storing a photo", () => {
  it("keeps the cleaned picture — no location — once, however many times it is sent", async () => {
    fresh();
    const input = await photo(80, 60, "#1e88e5");
    const a = await storeMedia({ bytes: input, uploadedBy: ids.VMO, capturedAt: new Date("2026-10-15T21:00:00+04:00") });
    expect(a).toMatchObject({ kind: "photo", mime: "image/jpeg", width: 80, height: 60, duplicate: false });
    const [row] = await getServiceSql()<{ storage_path: string; thumb_path: string; retention_class: string; scan_status: string; stripped: unknown; days: number }[]>`
      select storage_path, thumb_path, retention_class, scan_status, stripped,
             round(extract(epoch from retention_until - uploaded_at) / 86400)::int as days
      from media_object where id = ${a.id}`;
    expect(row).toMatchObject({ retention_class: "evidence", scan_status: "not_scanned", days: 180 });
    const kept = store.objects.get(row!.storage_path)!;
    expect((await sharp(kept.bytes).metadata()).exif).toBeUndefined(); // the GPS block is gone
    expect(store.objects.has(row!.thumb_path)).toBe(true);
    const again = await storeMedia({ bytes: input, uploadedBy: ids.VMO });
    expect(again).toMatchObject({ id: a.id, duplicate: true });
    expect(store.objects.size).toBe(2); // one picture, one thumbnail
  });

  it("refuses what it cannot keep safely, in words the sender can act on", async () => {
    fresh();
    const heic = box("ftyp", Buffer.from("heic\0\0\0\0mif1heic", "latin1"));
    await expect(storeMedia({ bytes: heic, uploadedBy: ids.VMO })).rejects.toThrow(/send a JPEG/);
    await expect(storeMedia({ bytes: Buffer.from("%PDF-1.7"), uploadedBy: ids.VMO })).rejects.toMatchObject({ status: 415 });
    await expect(storeMedia({ bytes: video(16), uploadedBy: ids.VMO })).rejects.toThrow(/15 seconds at most/);
    useMediaStoreForTests(null);
    await expect(storeMedia({ bytes: await photo(8, 8, "#000"), uploadedBy: ids.VMO })).rejects.toMatchObject({ status: 503 });
    expect(store.objects.size).toBe(0);
  });
});

describe("storing a short video", () => {
  it("keeps it unchanged in length, without its location, with its duration", async () => {
    fresh();
    const v = await storeMedia({ bytes: video(9), uploadedBy: ids.VMO });
    expect(v).toMatchObject({ kind: "video", mime: "video/mp4", durationMs: 9000 });
    const [row] = await getServiceSql()<{ storage_path: string; stripped: { mp4_boxes: string[] }; retention_class: string }[]>`
      select storage_path, stripped, retention_class from media_object where id = ${v.id}`;
    expect(row?.stripped.mp4_boxes).toEqual(["/moov/udta"]);
    expect(row?.retention_class).toBe("video");
    expect(Buffer.from(store.objects.get(row!.storage_path)!.bytes).includes(Buffer.from("+25.2048", "latin1"))).toBe(false);
  });
});

describe("who may see a file", () => {
  it("the sender, the people who lead them, Admin and the CEO — nobody else", async () => {
    fresh();
    const m = await storeMedia({ bytes: await photo(40, 40, "#43a047"), uploadedBy: ids.VMO });
    const sees = async (c: AppContext): Promise<boolean> => (await readMedia(c, m.id)) !== null;
    expect(await sees(ctx.VMO)).toBe(true);
    expect(await sees(ctx.SUP)).toBe(true);
    expect(await sees(ctx.ADM)).toBe(true);
    expect(await sees({ employeeId: DEMO_CEO_ID, isCeo: true, accessRole: "ceo" })).toBe(true);
    expect(await sees(ctx.OUT)).toBe(false);
    const thumb = await readMedia(ctx.VMO, m.id, "thumb");
    expect(thumb?.mime).toBe("image/jpeg");
  });

  it("a file is attached to a task only when the sender may see both", async () => {
    fresh();
    const m = await storeMedia({ bytes: await photo(30, 30, "#8e24aa"), uploadedBy: ids.VMO });
    const own = await createTask(ids.VMO, "MEDIA refill 793", true);
    const theirs = await createTask(ids.OUT, "MEDIA not VMO's", true);
    expect((await linkMediaToTask({ viewer: ctx.VMO, mediaId: m.id, taskId: own })).linked).toBe(true);
    expect((await linkMediaToTask({ viewer: ctx.VMO, mediaId: m.id, taskId: theirs })).linked).toBe(false);
    expect((await linkMediaToTask({ viewer: ctx.OUT, mediaId: m.id, taskId: theirs })).linked).toBe(false); // OUT cannot see the file
  });
});

describe("letting go of files", () => {
  it("does nothing until MEDIA_RETENTION=on; then removes only files past their time — bytes, then record", async () => {
    fresh();
    const old = await storeMedia({ bytes: await photo(20, 20, "#f4511e"), uploadedBy: ids.VMO });
    const keep = await storeMedia({ bytes: await photo(21, 21, "#00897b"), uploadedBy: ids.VMO });
    // Due by its class's period (evidence, 180 days): the sweep works due dates out from the upload time.
    await getServiceSql()`update media_object set uploaded_at = now() - interval '181 days' where id = ${old.id}`;
    expect(await mediaRetentionSweep({ env: {} })).toMatchObject({ enabled: false, removed: 0 });
    const before = store.objects.size;
    const r = await mediaRetentionSweep({ env: { MEDIA_RETENTION: "on" } });
    expect(r).toMatchObject({ enabled: true, removed: 1 });
    expect(store.objects.size).toBe(before - 2); // the picture and its thumbnail
    const left = await getServiceSql()<{ id: string }[]>`select id from media_object where id = any(${[old.id, keep.id]})`;
    expect(left.map((x) => x.id)).toEqual([keep.id]);
  });
});

describe("whose record a picture is (D212)", () => {
  it("two people sending the same picture each get their own record; the bytes are stored once and stay while either needs them", async () => {
    fresh();
    const bytes = await photo(31, 31, "#6d4c41");
    const a = await storeMedia({ bytes, uploadedBy: ids.VMO });
    const sizeAfterFirst = store.objects.size;
    const b = await storeMedia({ bytes, uploadedBy: ids.OUT });
    expect(b.id).not.toBe(a.id);
    expect(b.duplicate).toBe(false); // new for OUT — nothing tells OUT that VMO sent it too
    expect(store.objects.size).toBe(sizeAfterFirst); // stored once
    expect(await readMedia(ctx.OUT, b.id)).not.toBeNull(); // OUT reads their own record …
    expect(await readMedia(ctx.OUT, a.id)).toBeNull(); // … and still not VMO's
    // VMO's record goes; the bytes stay, because OUT's record needs them.
    await getServiceSql()`update media_object set uploaded_at = now() - interval '181 days' where id = ${a.id}`;
    await mediaRetentionSweep({ env: { MEDIA_RETENTION: "on" } });
    expect(store.objects.size).toBe(sizeAfterFirst);
    expect(await readMedia(ctx.OUT, b.id)).not.toBeNull();
  });

  it("how long a file is kept follows from what it is; a re-send asking for longer keeps it longer", async () => {
    fresh();
    const days = async (id: string) =>
      (await getServiceSql()<{ d: number; c: string }[]>`
        select round(extract(epoch from retention_until - uploaded_at) / 86400)::int as d, retention_class as c from media_object where id = ${id}`)[0]!;
    const v = await storeMedia({ bytes: video(5), uploadedBy: ids.VMO, retention: "receipt" });
    expect(v.retention).toBe("video"); // a video is a video, whatever was asked
    expect(await days(v.id)).toEqual({ d: 30, c: "video" });
    const bytes = await photo(33, 33, "#5e35b1");
    const ev = await storeMedia({ bytes, uploadedBy: ids.VMO });
    expect(await days(ev.id)).toEqual({ d: 180, c: "evidence" });
    const again = await storeMedia({ bytes, uploadedBy: ids.VMO, retention: "receipt" });
    expect(again).toMatchObject({ id: ev.id, duplicate: true, retention: "receipt" });
    expect(await days(ev.id)).toEqual({ d: 1825, c: "receipt" });
    const back = await storeMedia({ bytes, uploadedBy: ids.VMO }); // asking for less never shortens it
    expect(back.retention).toBe("receipt");
  });

  it("refusals and re-sends count against the sender's hourly limit; attaching is audited", async () => {
    fresh();
    const before = (await checkRateLimit({ key: "media", employeeId: ids.SUP })).used;
    await expect(storeMedia({ bytes: Buffer.from("%PDF-1.7"), uploadedBy: ids.SUP })).rejects.toMatchObject({ status: 415 });
    await expect(storeMedia({ bytes: video(16), uploadedBy: ids.SUP })).rejects.toMatchObject({ status: 413 });
    const m = await storeMedia({ bytes: await photo(34, 34, "#00acc1"), uploadedBy: ids.SUP });
    await storeMedia({ bytes: await photo(34, 34, "#00acc1"), uploadedBy: ids.SUP });
    expect((await checkRateLimit({ key: "media", employeeId: ids.SUP })).used).toBe(before + 4);

    const t = await createTask(ids.SUP, "MEDIA linked 790", true);
    expect((await linkMediaToTask({ viewer: ctx.SUP, mediaId: m.id, taskId: t })).linked).toBe(true);
    const [row] = await getServiceSql()<{ n: number }[]>`
      select count(*)::int as n from audit_log where action = 'media.linked' and entity_id = ${t} and detail ->> 'mediaId' = ${m.id}`;
    expect(row!.n).toBe(1);
  });
});

describe("when the data controller decides (A-T58.1)", () => {
  it("a period decided later applies to files already kept, longer or shorter — before anything is deleted", async () => {
    fresh();
    const v = await storeMedia({ bytes: video(4), uploadedBy: ids.VMO });
    const due = async () =>
      (await getServiceSql()<{ d: number }[]>`
        select round(extract(epoch from retention_until - uploaded_at) / 86400)::int as d from media_object where id = ${v.id}`)[0]!.d;
    expect(await due()).toBe(30);
    // Videos to be kept 90 days: the existing video is re-dated, and nothing is deleted while it is off.
    const r = await mediaRetentionSweep({ env: { MEDIA_RETENTION_VIDEO_DAYS: "90" } });
    expect(r).toMatchObject({ enabled: false, removed: 0 });
    expect(r.redated).toBeGreaterThanOrEqual(1);
    expect(await due()).toBe(90);
    // A 40-day-old video under that decision is not due — under the old default it would have gone.
    await getServiceSql()`update media_object set uploaded_at = now() - interval '40 days' where id = ${v.id}`;
    await mediaRetentionSweep({ env: { MEDIA_RETENTION: "on", MEDIA_RETENTION_VIDEO_DAYS: "90" } });
    expect((await getServiceSql()`select 1 from media_object where id = ${v.id}`).length).toBe(1);
  });

  it("a picture attached to new work keeps from that day, not from its first upload (review 2026-10-17, live-updates-media#7)", async () => {
    fresh();
    const sql = getServiceSql();
    const m = await storeMedia({ bytes: await photo(32, 24, "#2a6"), uploadedBy: ids.VMO });
    await sql`update media_object set uploaded_at = now() - interval '170 days' where id = ${m.id}`;
    const [t] = await sql<{ id: string }[]>`insert into task (employee_id, title, status, is_synthetic) values (${ids.VMO}, 'MEDIA relink', 'open', true) returning id`;
    expect((await linkMediaToTask({ viewer: ctx.VMO, mediaId: m.id, taskId: t!.id })).linked).toBe(true);
    await mediaRetentionSweep({ env: {} });
    const [r] = await sql<{ left: number }[]>`
      select round(extract(epoch from retention_until - now()) / 86400)::int as left from media_object where id = ${m.id}`;
    // Kept the full evidence period from the attachment — not the ten days its upload date leaves.
    expect(r!.left).toBeGreaterThan(30);
  });

  it("refuses a picture whose taken-at time cannot be true, before any work (review live-updates-media#1)", async () => {
    fresh();
    const bytes = await photo(16, 16, "#a62");
    await expect(storeMedia({ bytes, uploadedBy: ids.VMO, capturedAt: new Date("1900-01-01T00:00:00Z") })).rejects.toMatchObject({ status: 400 });
    await expect(storeMedia({ bytes, uploadedBy: ids.VMO, capturedAt: new Date(Date.now() + 3 * 86_400_000) })).rejects.toMatchObject({ status: 400 });
    expect(store.objects.size).toBe(0);
  });
});

describe("a demo reset (scripts/reset-employee.ts)", () => {
  it("removes a person's own files — bytes, then records — and the links onto their tasks; refuses without a store", async () => {
    fresh();
    const mine = await storeMedia({ bytes: await photo(22, 22, "#3949ab"), uploadedBy: ids.VMO });
    const theirs = await storeMedia({ bytes: await photo(23, 23, "#c0ca33"), uploadedBy: ids.SUP });
    const task = await createTask(ids.VMO, "MEDIA reset 791", true);
    expect((await linkMediaToTask({ viewer: ctx.SUP, mediaId: theirs.id, taskId: task })).linked).toBe(true);

    // Without a store nothing is touched: a record removed while its bytes stay would be lost for good.
    useMediaStoreForTests(null);
    await expect(forgetMediaOf(ids.VMO)).rejects.toMatchObject({ status: 503 });
    expect((await getServiceSql()`select 1 from media_link where entity_id = ${task}`).length).toBe(1);

    useMediaStoreForTests(store);
    const sql = getServiceSql();
    // Earlier tests in this file left more of the VMO's files; all of them go.
    const [owned] = await sql<{ n: number }[]>`select count(*)::int as n from media_object where uploaded_by = ${ids.VMO}`;
    const before = store.objects.size;
    const r = await forgetMediaOf(ids.VMO);
    expect(r.removed).toBe(owned!.n);
    expect(r.unlinked).toBeGreaterThanOrEqual(1);
    expect(store.objects.size).toBe(before - 2); // this store held the VMO's picture and thumbnail; the supervisor's stay
    const left = await sql<{ id: string }[]>`select id from media_object where id = any(${[mine.id, theirs.id]})`;
    expect(left.map((x) => x.id)).toEqual([theirs.id]);
    expect((await sql`select 1 from media_object where uploaded_by = ${ids.VMO}`).length).toBe(0);
    expect((await sql`select 1 from media_link where entity_id = ${task}`).length).toBe(0);
  });
});

it("a refusal is a MediaError with an HTTP status", () => {
  expect(new MediaError("x", 415)).toMatchObject({ name: "MediaError", status: 415 });
});
