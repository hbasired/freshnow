import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

/**
 * PDF text extraction in a sandbox: a separate, short-lived Node process with a memory ceiling,
 * a time limit, and no inherited environment — torn down after every file.
 *
 * Why. The PDF parser (PDF.js, bundled by unpdf) is the most complex code that ever touches an
 * attacker's bytes in this system. Two things can go wrong inside it:
 *   - a parser bug an attacker can steer — PDF.js had one (CVE-2024-4367: JavaScript execution
 *     through font handling when `isEvalSupported` is on, fixed in 4.2.67). We pass
 *     `isEvalSupported: false`, the advisory's workaround, whichever version is bundled;
 *   - a resource bomb — a small file that expands to gigabytes, or loops for minutes.
 * In the api or bot process either would take the whole service down, next to every key and
 * the database connection. In the child the damage is capped: `--max-old-space-size` aborts it
 * at the ceiling, a timer kills it, and it was started with an EMPTY environment — no API keys,
 * no database URL, no bot token for an exploit to steal.
 *
 * Why a process and not a worker thread: tested on 2026-09-30 (Node 22.22), worker_threads'
 * `resourceLimits.maxOldGenerationSizeMb` did NOT stop a worker allocating 18 million objects
 * under a 16 MB limit, while `node --max-old-space-size=32` aborted in 187 ms. A limit that is
 * not enforced is not a limit (G128).
 *
 * What this is not: an operating-system jail. The child runs as the same user and could touch
 * the filesystem if an exploit got that far. Production can put the parser in its own container
 * with no network and a read-only filesystem (TASK-051, recorded as not built).
 */

export const PDF_SANDBOX = {
  /** V8 old-space ceiling for one extraction, in MB. A 15 MB legitimate PDF needs far less. */
  maxHeapMb: 256,
  timeoutMs: 20_000,
  /** Bound on what the child may send back (the caller keeps 20 000 characters anyway). */
  maxOutputBytes: 8 * 1024 * 1024,
} as const;

export class PdfSandboxError extends Error {}

function unpdfModuleUrl(): string {
  // The ESM build, resolved from here, so the child imports exactly the copy this package uses.
  const cjs = createRequire(import.meta.url).resolve("unpdf");
  return pathToFileURL(cjs.replace(/index\.cjs$/, "index.mjs")).href;
}

// The child (ES module, run with -e). Reads the PDF from stdin, writes ONE JSON object to stdout.
// PDF.js logs warnings with console.*; those are sent to stderr so they cannot corrupt the answer.
const CHILD_SOURCE = `
const say = (...a) => process.stderr.write(a.map(String).join(" ") + "\\n");
console.log = console.info = console.warn = console.error = console.debug = say;
const cfg = JSON.parse(process.env.FN_PDF);
const out = (o) => process.stdout.write(JSON.stringify(o));
const chunks = [];
for await (const c of process.stdin) chunks.push(c);
try {
  const { extractText, getDocumentProxy } = await import(cfg.unpdf);
  const pdf = await getDocumentProxy(new Uint8Array(Buffer.concat(chunks)), {
    isEvalSupported: false,   // CVE-2024-4367 workaround
    disableFontFace: true,
    useSystemFonts: false,
  });
  if (pdf.numPages > cfg.maxPages) {
    out({ error: "document has " + pdf.numPages + " pages; the limit is " + cfg.maxPages });
  } else {
    const { totalPages, text } = await extractText(pdf, { mergePages: true });
    out({ totalPages, text: Array.isArray(text) ? text.join("\\n") : text });
  }
} catch (e) {
  out({ error: String((e && e.message) || e).slice(0, 300) });
}
`;

type ChildAnswer = { error?: string; totalPages?: number; text?: string };

function parseAnswer(stdout: Buffer): ChildAnswer | null {
  try {
    const v: unknown = JSON.parse(stdout.toString("utf8"));
    return v && typeof v === "object" ? (v as ChildAnswer) : null;
  } catch {
    return null; // no answer — the caller reports it
  }
}

/** Extract all text from a PDF inside the sandbox. Rejects with PdfSandboxError on any failure. */
export function extractPdfTextSandboxed(
  bytes: Uint8Array,
  opts: { maxPages: number; timeoutMs?: number; maxHeapMb?: number },
): Promise<{ totalPages: number; text: string }> {
  const timeoutMs = opts.timeoutMs ?? PDF_SANDBOX.timeoutMs;
  const heap = opts.maxHeapMb ?? PDF_SANDBOX.maxHeapMb;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [`--max-old-space-size=${heap}`, "--input-type=module", "-e", CHILD_SOURCE], {
      // Nothing of ours: only the two values the parser needs (and what Windows needs to start a process).
      env: {
        FN_PDF: JSON.stringify({ unpdf: unpdfModuleUrl(), maxPages: opts.maxPages }),
        ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = Buffer.alloc(0);
    let stderr = "";
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child.exitCode === null) child.kill("SIGKILL");
      fn();
    };
    const timer = setTimeout(
      () => finish(() => reject(new PdfSandboxError(`reading the PDF took longer than ${Math.round(timeoutMs / 1000)} s, so it was stopped`))),
      timeoutMs,
    );
    child.stdout.on("data", (d: Buffer) => {
      stdout = Buffer.concat([stdout, d]);
      if (stdout.length > PDF_SANDBOX.maxOutputBytes) finish(() => reject(new PdfSandboxError("the PDF produced more text than any real document should, so it was stopped")));
    });
    child.stderr.on("data", (d: Buffer) => {
      if (stderr.length < 4000) stderr += d.toString("utf8");
    });
    child.on("error", (e) => finish(() => reject(new PdfSandboxError(`the PDF reader could not start: ${e.message}`))));
    child.on("close", (code, signal) =>
      finish(() => {
        if (/heap limit|heap out of memory/i.test(stderr) || code === 134) {
          reject(new PdfSandboxError("the PDF needed more memory than any real document should, so it was stopped"));
          return;
        }
        const m = parseAnswer(stdout);
        if (!m) reject(new PdfSandboxError(`the PDF reader stopped without an answer (exit ${code ?? signal})`));
        else if (m.error) reject(new PdfSandboxError(m.error));
        else resolve({ totalPages: m.totalPages ?? 0, text: m.text ?? "" });
      }),
    );
    child.stdin.on("error", () => {
      /* the child may exit before reading everything (e.g. killed) — the close handler reports it */
    });
    child.stdin.end(Buffer.from(bytes));
  });
}
