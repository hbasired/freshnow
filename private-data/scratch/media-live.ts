import "dotenv/config";
import { createRequire } from "node:module";
const sharp = createRequire(new URL("../../packages/core/package.json", import.meta.url))("sharp") as typeof import("sharp");
import { closeDb, getServiceSql, readMedia, storeMedia, DEMO_CEO_ID } from "../../packages/core/src/index.js";
const base = `${process.env.SUPABASE_URL}/storage/v1`;
const key = process.env.SUPABASE_SECRET_KEY!;
const h = { apikey: key, Authorization: `Bearer ${key}` };
// The probe bucket allowed PNG/WebP too; it is empty, so it is recreated with the code's settings.
const del = await fetch(`${base}/bucket/media`, { method: "DELETE", headers: h });
console.log("old bucket removed:", del.status);
const input = await sharp({ create: { width: 1200, height: 900, channels: 3, background: "#ff9800" } })
  .jpeg().withExif({ IFD0: { Make: "LiveCheck" }, IFD3: { GPSLatitudeRef: "N", GPSLatitude: "25/1 12/1 1728/100" } }).toBuffer();
const m = await storeMedia({ bytes: input, uploadedBy: DEMO_CEO_ID, retention: "evidence", isSynthetic: true });
console.log("stored:", m.kind, m.width + "x" + m.height, m.bytes, "bytes, duplicate", m.duplicate);
const back = await readMedia({ employeeId: DEMO_CEO_ID, isCeo: true, accessRole: "ceo" }, m.id);
const meta = await sharp(Buffer.from(back!.bytes)).metadata();
console.log("read back from Supabase Storage:", back!.mime, back!.bytes.length, "bytes | exif:", meta.exif ? "PRESENT" : "none", "| 'LiveCheck' in bytes:", Buffer.from(back!.bytes).includes(Buffer.from("LiveCheck")));
const b = await fetch(`${base}/bucket/media`, { headers: h });
const bucket = await b.json() as { public: boolean; allowed_mime_types: string[]; file_size_limit: number };
console.log("bucket:", JSON.stringify({ public: bucket.public, allowed: bucket.allowed_mime_types, limitMB: bucket.file_size_limit / 1048576 }));
const anon = await fetch(`${base}/object/media/${(await getServiceSql()`select storage_path from media_object where id = ${m.id}`)[0]!.storage_path}`, { headers: { apikey: process.env.SUPABASE_ANON_KEY! } });
console.log("the public key alone, straight at Storage:", anon.status);
// Clean up the check.
const row = (await getServiceSql()<{ storage_path: string; thumb_path: string }[]>`select storage_path, thumb_path from media_object where id = ${m.id}`)[0]!;
await fetch(`${base}/object/media`, { method: "DELETE", headers: { ...h, "content-type": "application/json" }, body: JSON.stringify({ prefixes: [row.storage_path, row.thumb_path] }) });
await getServiceSql()`delete from media_object where id = ${m.id}`;
await getServiceSql()`delete from audit_log where entity = 'media_object' and entity_id = ${m.id}`;
console.log("check removed");
await closeDb();
