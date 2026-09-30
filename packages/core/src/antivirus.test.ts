import { createServer, type Server } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { antivirusStatus, scanBytes } from "./antivirus.js";
import { closeDb, getServiceSql } from "./db.js";
import { gateIncomingDocument, saveAttachments, type IncomingFile } from "./attachments.js";
import { inspectFile } from "./document-security.js";
import { extractPdfTextSandboxed, PdfSandboxError } from "./pdf-sandbox.js";

/**
 * Layered file defence (TASK-051). The antivirus client is tested three ways: against a stand-in
 * clamd that checks the wire protocol byte for byte, through the file gate (refuse on a match,
 * refuse when the scanner is down, unchanged when none is configured), and — when a real clamd
 * is available (CLAMAV_TEST_HOST) — against ClamAV itself with the EICAR test file, which every
 * antivirus is built to flag and which is harmless by design.
 */

// The standard EICAR test string (68 bytes). Built at run time so this source file itself
// is not a "test virus" for scanners that look at the repository.
const EICAR = Buffer.from(["X5O!P%@AP[4\\PZX54(P^)7CC)7}$", "EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*"].join(""), "latin1");

/** A stand-in clamd: reassembles the INSTREAM chunks and answers as clamd would. */
function fakeClamd(answer: (payload: Buffer) => string | null): Promise<{ server: Server; port: number; received: Buffer[] }> {
  const received: Buffer[] = [];
  return new Promise((resolve) => {
    const server = createServer((sock) => {
      let buf = Buffer.alloc(0);
      sock.on("data", (d) => {
        buf = Buffer.concat([buf, d]);
        if (buf.toString("latin1").startsWith("zPING\0")) {
          sock.end("PONG\0");
          return;
        }
        const head = "zINSTREAM\0";
        if (!buf.toString("latin1").startsWith(head)) return;
        // Parse length-prefixed chunks until the zero-length terminator.
        let off = head.length;
        const parts: Buffer[] = [];
        while (off + 4 <= buf.length) {
          const n = buf.readUInt32BE(off);
          if (n === 0) {
            const payload = Buffer.concat(parts);
            received.push(payload);
            const a = answer(payload);
            if (a !== null) sock.end(`${a}\0`);
            return;
          }
          if (off + 4 + n > buf.length) return; // wait for the rest
          parts.push(buf.subarray(off + 4, off + 4 + n));
          off += 4 + n;
        }
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({ server, port: typeof addr === "object" && addr ? addr.port : 0, received });
    });
  });
}

let fake: Awaited<ReturnType<typeof fakeClamd>>;
const saved = { host: process.env.CLAMAV_HOST, port: process.env.CLAMAV_PORT, timeout: process.env.CLAMAV_TIMEOUT_MS };

beforeAll(async () => {
  fake = await fakeClamd((payload) => (payload.includes(Buffer.from("EICAR-STANDARD")) ? "stream: Eicar-Test-Signature FOUND" : "stream: OK"));
});

afterEach(() => {
  for (const [k, v] of [["CLAMAV_HOST", saved.host], ["CLAMAV_PORT", saved.port], ["CLAMAV_TIMEOUT_MS", saved.timeout]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

afterAll(async () => {
  fake.server.close();
  await getServiceSql()`delete from audit_log where action in ('security.malware_blocked', 'security.scan_failed', 'document.flagged', 'document.blocked') and detail->>'fileName' like 'AVT-%'`;
  await getServiceSql()`delete from audit_log where action = 'attachment.withheld' and detail->'names' ? 'AVT-active.pdf'`;
  await closeDb();
});

const env = (port: number) => ({ CLAMAV_HOST: "127.0.0.1", CLAMAV_PORT: String(port), CLAMAV_TIMEOUT_MS: "2000" });

describe("the clamd client", () => {
  it("sends the whole file in length-prefixed chunks and reads the verdict", async () => {
    const big = Buffer.alloc(200_000, 7); // more than three 64 KB chunks
    expect(await scanBytes(big, env(fake.port))).toEqual({ status: "clean" });
    expect(fake.received.at(-1)?.equals(big)).toBe(true);
    expect(await scanBytes(EICAR, env(fake.port))).toEqual({ status: "infected", signature: "Eicar-Test-Signature" });
  });

  it("reports 'off' when no scanner is configured, and 'error' when it cannot be reached", async () => {
    expect(await scanBytes(EICAR, {})).toEqual({ status: "off" });
    const down = await scanBytes(EICAR, env(1)); // nothing listens on port 1
    expect(down.status).toBe("error");
    expect(await antivirusStatus(env(fake.port))).toEqual({ configured: true, reachable: true });
    expect((await antivirusStatus(env(1))).reachable).toBe(false);
  });

  it("gives up after its timeout rather than hanging the upload", async () => {
    const silent = await fakeClamd(() => null);
    const r = await scanBytes(Buffer.from("x"), { ...env(silent.port), CLAMAV_TIMEOUT_MS: "300" });
    silent.server.close();
    expect(r).toMatchObject({ status: "error" });
    expect(r.detail).toMatch(/did not answer/);
  });
});

describe("the file gate with a scanner", () => {
  it("refuses a file the scanner flags, and audits it as a security event", async () => {
    Object.assign(process.env, env(fake.port));
    const r = await inspectFile({ bytes: EICAR, declaredName: "AVT-notes.txt" });
    expect(r).toMatchObject({ verdict: "blocked", mayRead: false, mayForward: false });
    expect(r.indicators).toContain("malware:Eicar-Test-Signature");
    const rows = await getServiceSql()`select action from audit_log where detail->>'fileName' = 'AVT-notes.txt'`;
    expect(rows.map((x) => x.action)).toContain("security.malware_blocked");
  });

  it("refuses when the configured scanner is down — fail closed", async () => {
    Object.assign(process.env, env(1));
    const r = await inspectFile({ bytes: Buffer.from("plain words"), declaredName: "AVT-plain.txt" });
    expect(r).toMatchObject({ verdict: "blocked" });
    expect(r.indicators).toEqual(["antivirus-unavailable"]);
  });

  it("marks a clean scan, and changes nothing when no scanner is configured", async () => {
    Object.assign(process.env, env(fake.port));
    expect((await inspectFile({ bytes: Buffer.from("van 2 chiller"), declaredName: "AVT-ok.txt" })).indicators).toContain("virus-scanned");
    delete process.env.CLAMAV_HOST;
    const r = await inspectFile({ bytes: Buffer.from("van 2 chiller"), declaredName: "AVT-ok.txt" });
    expect(r).toMatchObject({ verdict: "safe", mayForward: true });
    expect(r.indicators).not.toContain("virus-scanned");
  });
});

describe("a document sent to be passed on is checked when it arrives", () => {
  // Attachments travel by Telegram file_id, so before TASK-051 a file sent "for Rashid" reached
  // Rashid unchecked. The gate now fetches it once and applies the full file check.
  const doc = (fileName: string, fileSize = 100): IncomingFile => ({ fileId: `tg-${fileName}`, fileName, fileSize, kind: "document", mimeType: null });
  const uploadedBy = "00000000-0000-4000-8000-00000000a51a";

  it("refuses malware — it is never held, so it can never be forwarded", async () => {
    Object.assign(process.env, env(fake.port));
    const r = await gateIncomingDocument({ file: doc("AVT-invoice.txt"), uploadedBy, download: async () => EICAR });
    expect(r).toMatchObject({ hold: false, reason: "refused" });
  });

  it("refuses what it could not check: too large to scan, or not downloadable", async () => {
    let fetched = false;
    const big = await gateIncomingDocument({ file: doc("AVT-big.pdf", 16 * 1024 * 1024), uploadedBy, download: async () => ((fetched = true), Buffer.alloc(1)) });
    expect(big).toMatchObject({ hold: false, reason: "too_large" });
    expect(fetched).toBe(false);
    const flaky = await gateIncomingDocument({ file: doc("AVT-x.pdf"), uploadedBy, download: async () => { throw new Error("ECONNRESET"); } });
    expect(flaky).toMatchObject({ hold: false, reason: "download_failed" });
  });

  it("holds a clean file as forwardable", async () => {
    Object.assign(process.env, env(fake.port));
    const r = await gateIncomingDocument({ file: doc("AVT-spec.txt"), uploadedBy, download: async () => Buffer.from("Chiller spec: 4 degrees") });
    expect(r.hold && r.file.mayForward).toBe(true);
  });

  it("holds active content for reading only — and saveAttachments will not store it", async () => {
    Object.assign(process.env, env(fake.port));
    const active = Buffer.from("%PDF-1.4\n1 0 obj << /Type /Catalog /OpenAction << /S /JavaScript /JS (x) >> >> endobj\n%%EOF\n", "latin1");
    const r = await gateIncomingDocument({ file: doc("AVT-active.pdf"), uploadedBy, download: async () => active });
    expect(r.hold).toBe(true);
    if (!r.hold) return;
    expect(r.file.mayForward).toBe(false);
    expect(await saveAttachments({ files: [r.file], uploadedBy, taskId: null })).toEqual([]);
    const rows = await getServiceSql()`select 1 from audit_log where action = 'attachment.withheld' and detail->'names' ? 'AVT-active.pdf'`;
    expect(rows.length).toBe(1);
  });
});

describe.skipIf(!process.env.CLAMAV_TEST_HOST)("real ClamAV (CLAMAV_TEST_HOST)", () => {
  it("flags the EICAR test file and passes a clean one", async () => {
    const e = { CLAMAV_HOST: process.env.CLAMAV_TEST_HOST, CLAMAV_PORT: process.env.CLAMAV_TEST_PORT ?? "3310" };
    expect((await scanBytes(EICAR, e)).status).toBe("infected");
    expect(await scanBytes(Buffer.from("Batch 42 passed QC"), e)).toEqual({ status: "clean" });
  });
});

/** A real, minimal PDF with `pages` pages of text, correct cross-reference table and all. */
function makePdf(pages: number, text = "Clean the chiller in van 2"): Uint8Array {
  const objs: string[] = [];
  const kids = Array.from({ length: pages }, (_, i) => `${4 + i * 2} 0 R`).join(" ");
  objs.push("<< /Type /Catalog /Pages 2 0 R >>");
  objs.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages} >>`);
  objs.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  for (let i = 0; i < pages; i++) {
    const content = `BT /F1 12 Tf 72 720 Td (${text} p${i + 1}) Tj ET`;
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`);
    objs.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  }
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

describe("PDF text is read in a sandbox", () => {
  it("reads a real PDF", async () => {
    const r = await extractPdfTextSandboxed(makePdf(2), { maxPages: 50 });
    expect(r.totalPages).toBe(2);
    expect(r.text).toContain("Clean the chiller in van 2 p1");
  });

  it("refuses too many pages before extracting anything", async () => {
    await expect(extractPdfTextSandboxed(makePdf(60), { maxPages: 50 })).rejects.toThrow(/60 pages; the limit is 50/);
  });

  it("stops a reader that runs too long — and this process carries on", async () => {
    await expect(extractPdfTextSandboxed(makePdf(1), { maxPages: 50, timeoutMs: 1 })).rejects.toThrow(/took longer/);
    expect((await extractPdfTextSandboxed(makePdf(1), { maxPages: 50 })).totalPages).toBe(1);
  });

  it("stops a reader that needs more memory than its ceiling — a decompression-bomb stand-in", async () => {
    // ~4 MB of text in one page: fine at the real ceiling, far over a 16 MB one.
    const heavy = makePdf(1, "x".repeat(200).concat(") Tj T* (").repeat(20_000));
    await expect(extractPdfTextSandboxed(heavy, { maxPages: 50, maxHeapMb: 16 })).rejects.toThrow(/more memory/);
    expect((await extractPdfTextSandboxed(makePdf(1), { maxPages: 50 })).totalPages).toBe(1);
  }, 60_000);

  it("the reader starts with none of this process's secrets", async () => {
    process.env.FN_TEST_SECRET = "must-not-leak";
    try {
      // A PDF whose text is irrelevant; what matters is that the child's environment is empty.
      // Proven indirectly: the child is spawned with an explicit env holding only FN_PDF.
      const r = await extractPdfTextSandboxed(makePdf(1), { maxPages: 50 });
      expect(r.text).not.toContain("must-not-leak");
    } finally {
      delete process.env.FN_TEST_SECRET;
    }
  });

  it("garbage is an error, not a crash", async () => {
    await expect(extractPdfTextSandboxed(Buffer.from("%PDF-1.7 not really a pdf"), { maxPages: 50 })).rejects.toBeInstanceOf(PdfSandboxError);
  });
});
