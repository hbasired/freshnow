import "dotenv/config";
const base = `${process.env.SUPABASE_URL}/storage/v1`;
const key = process.env.SUPABASE_SECRET_KEY!;
const h = { apikey: key, Authorization: `Bearer ${key}` };
const show = async (label: string, r: Response) => console.log(label, r.status, (await r.text()).slice(0, 160).replace(key, "<key>"));
await show("create bucket:", await fetch(`${base}/bucket`, { method: "POST", headers: { ...h, "content-type": "application/json" },
  body: JSON.stringify({ id: "media", name: "media", public: false, file_size_limit: 52428800, allowed_mime_types: ["image/jpeg", "image/png", "image/webp", "video/mp4"] }) }));
const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
await show("upload:", await fetch(`${base}/object/media/probe/test.jpg`, { method: "POST", headers: { ...h, "content-type": "image/jpeg", "x-upsert": "true", "cache-control": "max-age=3600" }, body: bytes }));
const g = await fetch(`${base}/object/media/probe/test.jpg`, { headers: h });
console.log("download:", g.status, "bytes", (await g.arrayBuffer()).byteLength);
const anon = await fetch(`${base}/object/media/probe/test.jpg`, { headers: { apikey: process.env.SUPABASE_ANON_KEY! } });
console.log("download with the public key only:", anon.status);
await show("delete:", await fetch(`${base}/object/media`, { method: "DELETE", headers: { ...h, "content-type": "application/json" }, body: JSON.stringify({ prefixes: ["probe/test.jpg"] }) }));
