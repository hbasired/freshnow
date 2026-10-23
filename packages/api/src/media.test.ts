import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MemoryMediaStore, closeDb, DEMO_CEO_ID, getServiceSql, useMediaStoreForTests } from "@freshnow/core";
import { buildServer } from "./server.js";

/**
 * Photos over HTTP (TASK-058): upload as multipart, read back, and the refusals. The store is in
 * memory; the cleaning, the database and the permission checks are the real ones.
 */
const app = buildServer(false);
const run = randomUUID().slice(0, 6);
const VMO = randomUUID();
const OUT = randomUUID();
const store = new MemoryMediaStore();

/** Hand-built multipart body (as documents.test.ts), so the test needs nothing beyond Node. */
function multipart(file: { name: string; type: string; bytes: Buffer }) {
  const boundary = "----freshnow" + randomUUID().replace(/-/g, "");
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`),
    file.bytes,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { payload, headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
}

beforeAll(async () => {
  useMediaStoreForTests(store);
  const sql = getServiceSql();
  await sql`insert into employee (id, display_name, status, is_synthetic, access_role, manager_employee_id)
    values (${VMO}, ${`MEDIAAPI-${run}-VMO`}, 'active', true, 'vmo', ${DEMO_CEO_ID}),
           (${OUT}, ${`MEDIAAPI-${run}-OUT`}, 'active', true, 'employee', ${DEMO_CEO_ID})`;
});

afterAll(async () => {
  useMediaStoreForTests(undefined);
  const sql = getServiceSql();
  await sql`delete from media_link where linked_by = any(${[VMO, OUT]})`;
  await sql`delete from media_object where uploaded_by = any(${[VMO, OUT]})`;
  await sql`delete from task where employee_id = any(${[VMO, OUT]})`;
  await sql`delete from audit_log where actor = any(${[`employee:${VMO}`, `employee:${OUT}`]})`;
  await sql`delete from employee where id = any(${[VMO, OUT]})`;
  await app.close();
  await closeDb();
});

const upload = async (viewer: string, bytes: Buffer, type: string, query = "") => {
  const m = multipart({ name: "x", type, bytes });
  return app.inject({ method: "POST", url: `/dashboard/media?viewer=${viewer}${query}`, payload: m.payload, headers: m.headers });
};

describe("POST /dashboard/media, GET /dashboard/media/:id", () => {
  it("stores a photo without its location and gives it back — to the sender, not to a stranger", async () => {
    const input = await sharp({ create: { width: 50, height: 40, channels: 3, background: "#ff7043" } })
      .jpeg()
      .withExif({ IFD3: { GPSLatitudeRef: "N", GPSLatitude: "25/1 12/1 1728/100" } })
      .toBuffer();
    const r = await upload(VMO, input, "image/jpeg", "&capturedAt=2026-10-15T21:00:00%2B04:00");
    expect(r.statusCode).toBe(201);
    const body = r.json() as { id: string; kind: string; width: number; duplicate: boolean };
    expect(body).toMatchObject({ kind: "photo", width: 50, duplicate: false });

    const got = await app.inject({ method: "GET", url: `/dashboard/media/${body.id}?viewer=${VMO}` });
    expect(got.statusCode).toBe(200);
    expect(got.headers["content-type"]).toBe("image/jpeg");
    expect(got.headers["x-content-type-options"]).toBe("nosniff");
    expect((await sharp(got.rawPayload).metadata()).exif).toBeUndefined();
    expect((await app.inject({ method: "GET", url: `/dashboard/media/${body.id}?viewer=${VMO}&variant=thumb` })).statusCode).toBe(200);

    // A stranger is told exactly what an unknown id is told.
    const stranger = await app.inject({ method: "GET", url: `/dashboard/media/${body.id}?viewer=${OUT}` });
    const unknown = await app.inject({ method: "GET", url: `/dashboard/media/${randomUUID()}?viewer=${OUT}` });
    expect(stranger.statusCode).toBe(404);
    expect(stranger.json()).toMatchObject({ error: { code: "not_found", message: unknown.json().error.message } });

    // The same picture again: the same record.
    const again = await upload(VMO, input, "image/jpeg");
    expect(again.statusCode).toBe(200);
    expect((again.json() as { id: string; duplicate: boolean })).toMatchObject({ id: body.id, duplicate: true });
  });

  it("attaches it to the sender's own task when asked", async () => {
    const [t] = await getServiceSql()<{ id: string }[]>`
      insert into task (employee_id, title, status, is_synthetic) values (${VMO}, 'MEDIAAPI refill', 'open', true) returning id`;
    const input = await sharp({ create: { width: 30, height: 30, channels: 3, background: "#5c6bc0" } }).png().toBuffer();
    const r = await upload(VMO, input, "image/png", `&taskId=${t!.id}`);
    expect(r.statusCode).toBe(201);
    expect((r.json() as { linked: boolean; mime: string })).toMatchObject({ linked: true, mime: "image/jpeg" });
  });

  it("refuses what is not a photo or a short video, whatever the declared type says", async () => {
    const pdf = await upload(VMO, Buffer.from("%PDF-1.7 pretending"), "image/jpeg");
    expect(pdf.statusCode).toBe(415);
    expect(pdf.json()).toMatchObject({ error: { code: "media_refused" } });
    const none = await app.inject({ method: "POST", url: `/dashboard/media?viewer=${VMO}`, payload: multipart({ name: "x", type: "image/jpeg", bytes: Buffer.alloc(0) }).payload, headers: { "content-type": "multipart/form-data; boundary=nothing" } });
    expect(none.statusCode).toBeGreaterThanOrEqual(400);
    expect((await app.inject({ method: "GET", url: `/dashboard/media/not-a-uuid?viewer=${VMO}` })).statusCode).toBe(400);
  });
});
