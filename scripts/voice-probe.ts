import "dotenv/config";
import { readFileSync } from "node:fs";
import { closeDb, transcribeAudio } from "../packages/core/src/index.js";

// Verifies the voice plumbing end to end: auth, multipart upload, endpoint, response.
const path = process.argv[2] ?? "/tmp/test-voice.ogg";
const bytes = new Uint8Array(readFileSync(path));
console.log(`uploading ${bytes.byteLength} bytes from ${path}`);
const t = await transcribeAudio(bytes, "voice.ogg", {});
console.log("transcript:", JSON.stringify(t.text));
console.log("language  :", t.language);
await closeDb();
