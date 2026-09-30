import { scanBytes } from "./antivirus.js";
import { logAudit } from "./audit.js";

/**
 * File-level safety gate for anything a person attaches.
 *
 * ── The threat model, stated honestly ──────────────────────────────────────────
 *
 * This process NEVER executes a document. Text is extracted by PDF.js with the canvas
 * module mocked; there is no viewer, no JavaScript engine for PDF actions, no shell-out.
 * So embedded JavaScript in a PDF cannot run *here*. Claiming otherwise would be
 * security theatre.
 *
 * The three risks that are real for this system:
 *
 *   A. WE BECOME THE DELIVERY MECHANISM. If the CEO taps "also send the file", we hand a
 *      document to an employee who opens it on a phone, where a viewer WILL act on
 *      /OpenAction, /Launch and embedded JavaScript. A file we merely stored is inert; a
 *      file we forwarded is distributed. This is the risk that actually matters.
 *
 *   B. PROMPT INJECTION. The extracted text is fed to a model that proposes who does what.
 *      Text is the attack surface, not the file structure. Handled in `injection.ts`.
 *
 *   C. RESOURCE EXHAUSTION. A crafted PDF can expand enormously, or carry tens of
 *      thousands of pages, and starve Postgres on a shared box.
 *
 * Antivirus: since TASK-051 every file is also scanned by ClamAV (antivirus.ts) when
 * CLAMAV_HOST is set — a signature match is refused, and a scanner that cannot be reached
 * refuses the file rather than letting it through. Signatures catch KNOWN malware only, so
 * the structural indicators below still decide what may be forwarded, and PDF text is
 * extracted in a sandboxed worker (pdf-sandbox.ts). Unset (the demo default), files are not
 * virus-scanned; production refuses to start that way (compliance rule R6).
 */

/** Hard caps. Every one is a bound on work this box will do for one message (rule 4). */
export const MAX_FILE_BYTES = 15 * 1024 * 1024; // 15 MB — Telegram bot download limit is 20
export const MAX_PDF_PAGES = 50;
export const MAX_TEXT_CHARS = 40_000;

export type Verdict = "safe" | "suspicious" | "blocked";

export interface SafetyReport {
  verdict: Verdict;
  /** Plain-language reasons, safe to show a non-technical person. */
  reasons: string[];
  /** Structural indicators found, for the audit trail. */
  indicators: string[];
  /** May the text be extracted and read? */
  mayRead: boolean;
  /** May the file itself be passed on to another person? */
  mayForward: boolean;
  detectedType: string | null;
}

/**
 * File signatures. The declared MIME type and the extension both come from the sender and
 * are trivially wrong — a `.pdf` that is really a ZIP is the oldest trick there is — so
 * the bytes decide.
 */
const SIGNATURES: { type: string; magic: number[]; offset?: number }[] = [
  { type: "application/pdf", magic: [0x25, 0x50, 0x44, 0x46] }, // %PDF
  { type: "image/jpeg", magic: [0xff, 0xd8, 0xff] },
  { type: "image/png", magic: [0x89, 0x50, 0x4e, 0x47] },
  { type: "application/zip", magic: [0x50, 0x4b, 0x03, 0x04] }, // also docx/xlsx
  { type: "application/x-rar", magic: [0x52, 0x61, 0x72, 0x21] },
  { type: "application/x-7z", magic: [0x37, 0x7a, 0xbc, 0xaf] },
  { type: "application/x-msdownload", magic: [0x4d, 0x5a] }, // MZ — Windows executable
  { type: "application/x-elf", magic: [0x7f, 0x45, 0x4c, 0x46] }, // ELF — Linux executable
  { type: "application/x-mach-o", magic: [0xcf, 0xfa, 0xed, 0xfe] },
  { type: "application/gzip", magic: [0x1f, 0x8b] },
];

/** Formats we will never accept, whatever they claim to be. */
const EXECUTABLE_TYPES = new Set([
  "application/x-msdownload",
  "application/x-elf",
  "application/x-mach-o",
]);

/**
 * Extensions that make a file EXECUTE when opened, and which have no magic bytes at all.
 *
 * A `.bat`, `.js`, `.ps1` or `.sh` is plain text — there is no signature to detect, so
 * every signature-based check returns "unknown format" and, before this list existed,
 * `verdict: safe` with `mayForward: true`. That is the single most dangerous outcome this
 * module can produce: we would have handed a working payload to an employee's phone with
 * our own name on it. These are exactly the attachments real phishing uses.
 *
 * Matched on the extension precisely BECAUSE content inspection cannot help here.
 */
const DANGEROUS_EXTENSIONS =
  /\.(exe|com|scr|pif|bat|cmd|ps1|psm1|vbs|vbe|js|jse|wsf|wsh|hta|jar|msi|msp|reg|lnk|scf|inf|sh|bash|zsh|py|pl|rb|app|dmg|deb|rpm|apk)$/i;

export function detectFileType(bytes: Uint8Array): string | null {
  for (const sig of SIGNATURES) {
    const at = sig.offset ?? 0;
    if (bytes.length < at + sig.magic.length) continue;
    if (sig.magic.every((b, i) => bytes[at + i] === b)) return sig.type;
  }
  return null;
}

/**
 * PDF structures that make a document *do things* when opened. None of them run here;
 * all of them run in the employee's PDF viewer if we forward the file.
 *
 * Matched on the raw bytes rather than a parsed tree, deliberately: a parser can be
 * evaded by a malformed file, and this check must not itself depend on parsing something
 * hostile. Crude and unbypassable beats elegant and evadable.
 */
const PDF_INDICATORS: { token: string; label: string; blocking: boolean }[] = [
  { token: "/JavaScript", label: "embedded JavaScript", blocking: true },
  { token: "/JS", label: "embedded JavaScript", blocking: true },
  { token: "/Launch", label: "an action that launches another program", blocking: true },
  { token: "/EmbeddedFile", label: "another file hidden inside it", blocking: true },
  { token: "/OpenAction", label: "something that runs as soon as it is opened", blocking: true },
  { token: "/AA", label: "automatic actions", blocking: true },
  { token: "/RichMedia", label: "embedded media that can execute", blocking: true },
  { token: "/XFA", label: "an XFA form", blocking: false },
  { token: "/URI", label: "external links", blocking: false },
  { token: "/Encrypt", label: "encryption", blocking: false },
];

/**
 * Inspect a file before anything else touches it.
 *
 * Order matters: size, then true type, then structure. Each check is cheap and refuses
 * early, so a hostile file never reaches the expensive parser.
 */
export async function inspectFile(p: {
  bytes: Uint8Array;
  declaredName?: string | null;
  declaredMime?: string | null;
  uploadedBy?: string;
  correlationId?: string;
}): Promise<SafetyReport> {
  const reasons: string[] = [];
  const indicators: string[] = [];

  // ── Size ────────────────────────────────────────────────────────────────────
  if (p.bytes.length === 0) {
    return report("blocked", ["The file is empty."], [], null, p);
  }
  if (p.bytes.length > MAX_FILE_BYTES) {
    return report(
      "blocked",
      [`The file is ${Math.round(p.bytes.length / 1024 / 1024)} MB. The limit is ${MAX_FILE_BYTES / 1024 / 1024} MB.`],
      ["oversize"],
      null,
      p,
    );
  }

  // ── Name-based refusal, BEFORE type detection ───────────────────────────────
  // Script formats are plain text with no signature, so byte inspection can never catch
  // them. The extension is the only signal that exists, and refusing on it is right:
  // nothing this system does needs an executable attachment.
  if (DANGEROUS_EXTENSIONS.test(p.declaredName ?? "")) {
    return report(
      "blocked",
      ["That file type can run programs, so I will not accept it."],
      ["dangerous-extension"],
      null,
      p,
    );
  }

  // ── True type, from the bytes ───────────────────────────────────────────────
  const detected = detectFileType(p.bytes);

  if (detected && EXECUTABLE_TYPES.has(detected)) {
    return report("blocked", ["That is a program, not a document."], ["executable"], detected, p);
  }

  // A mismatch between what it claims and what it is, is itself the signal.
  const claimsPdf =
    (p.declaredMime ?? "").includes("pdf") || /\.pdf$/i.test(p.declaredName ?? "");
  if (claimsPdf && detected !== "application/pdf") {
    return report(
      "blocked",
      [`That says it is a PDF but the file is ${detected ?? "an unrecognised format"}.`],
      ["type-mismatch"],
      detected,
      p,
    );
  }

  // ── Antivirus (ClamAV), before anything parses the file ─────────────────────
  const scan = await scanBytes(p.bytes);
  if (scan.status === "infected") {
    return report(
      "blocked",
      ["The virus scanner found malware in this file, so it was refused."],
      [`malware:${scan.signature ?? "unknown"}`],
      detected,
      p,
      "security.malware_blocked",
    );
  }
  if (scan.status === "error") {
    // Fail closed: a scanner was configured, so an unscanned file is not "probably fine".
    return report(
      "blocked",
      ["The virus scanner could not check this file right now, so it was not accepted. Try again in a minute."],
      ["antivirus-unavailable"],
      detected,
      p,
      "security.scan_failed",
    );
  }
  if (scan.status === "clean") indicators.push("virus-scanned");

  // ── Structure, for PDFs ─────────────────────────────────────────────────────
  if (detected === "application/pdf") {
    // Only the head and tail are scanned: indicators live in the catalog and the
    // trailer, and scanning 15 MB as a string for every upload is wasted work.
    const head = latin1(p.bytes.subarray(0, Math.min(p.bytes.length, 200_000)));
    const tail = latin1(p.bytes.subarray(Math.max(0, p.bytes.length - 100_000)));
    const text = head + tail;

    let blocking = false;
    for (const ind of PDF_INDICATORS) {
      // Word-boundary-ish match so /JS does not fire on /JSName.
      const re = new RegExp(ind.token.replace("/", "\\/") + "(?![A-Za-z])");
      if (re.test(text)) {
        indicators.push(ind.token);
        if (ind.blocking) {
          blocking = true;
          if (!reasons.includes(ind.label)) reasons.push(ind.label);
        }
      }
    }

    if (blocking) {
      // Readable but never forwardable: extracting text runs nothing, while passing the
      // file to somebody's phone hands the active content to a viewer that will obey it.
      return report("suspicious", reasons, indicators, detected, p);
    }
  }

  if (detected === "application/zip") {
    return report(
      "blocked",
      ["Archives and Office documents are not accepted — send a PDF or plain text."],
      ["archive"],
      detected,
      p,
    );
  }

  // An unidentifiable file must not default to forwardable. Plain text formats have no
  // magic bytes and are legitimate, so those are recognised by name; anything else whose
  // type we cannot establish is readable but not passed on — we should not vouch for a
  // file to somebody's phone when we cannot say what it is.
  if (detected === null && !/\.(txt|md|csv|json|log)$/i.test(p.declaredName ?? "")) {
    return report(
      "suspicious",
      ["a format I could not identify"],
      ["unknown-format"],
      null,
      p,
    );
  }

  return report("safe", reasons, indicators, detected, p);
}

function latin1(b: Uint8Array): string {
  // latin1 maps every byte to a character, so binary never throws or silently drops
  // sequences the way UTF-8 decoding would — which an attacker could use to hide a token.
  return Buffer.from(b).toString("latin1");
}

async function report(
  verdict: Verdict,
  reasons: string[],
  indicators: string[],
  detectedType: string | null,
  p: { uploadedBy?: string; declaredName?: string | null; correlationId?: string },
  /** A security event gets its own action, so it can be counted apart from ordinary refusals. */
  action?: "security.malware_blocked" | "security.scan_failed",
): Promise<SafetyReport> {
  const out: SafetyReport = {
    verdict,
    reasons,
    indicators,
    detectedType,
    mayRead: verdict !== "blocked",
    // Only a clean file is ever passed to another person.
    mayForward: verdict === "safe",
  };

  if (verdict !== "safe") {
    await logAudit({
      correlationId: p.correlationId,
      actor: p.uploadedBy ? `employee:${p.uploadedBy}` : "system",
      action: action ?? (verdict === "blocked" ? "document.blocked" : "document.flagged"),
      entity: "attachment",
      // The filename is attacker-controlled, so it is truncated and never interpolated
      // into anything that executes.
      detail: {
        fileName: (p.declaredName ?? "unnamed").slice(0, 120),
        detectedType,
        indicators,
        reasons,
      },
    });
  }
  return out;
}

/**
 * A filename is attacker-controlled text. It is shown to people and stored, so strip
 * anything that could traverse a path, be read as a control character, or reverse the
 * apparent extension (the classic right-to-left-override trick: "invoice‮fdp.exe").
 */
export function safeFileName(name: string | null | undefined): string {
  if (!name) return "document";
  return (
    name
      .replace(/[‪-‮⁦-⁩]/g, "") // bidirectional overrides
      // eslint-disable-next-line no-control-regex
      .replace(/[ -]/g, "") // control characters
      .replace(/[/\\]/g, "_") // path separators
      .replace(/\.{2,}/g, ".") // ../ traversal
      .trim()
      .slice(0, 100) || "document"
  );
}

/**
 * Escape text that will be interpolated into a Telegram `parse_mode: "Markdown"` message.
 *
 * Filenames and model-extracted titles are attacker- or document-controlled. An odd
 * number of `_` or `*` makes Telegram reject the whole message with a 400, so a file
 * named `q3_report.pdf` silently produced NO reply at all — the CEO would see the bot
 * simply stop responding, with the cause invisible.
 */
export function escapeMarkdown(text: string): string {
  return text.replace(/([_*`[\]])/g, "\\$1");
}

/** One line for the CEO explaining why a file was refused or flagged. */
export function explainVerdict(r: SafetyReport, fileName: string): string {
  const name = escapeMarkdown(safeFileName(fileName));
  if (r.verdict === "blocked") {
    return `🚫 I did not accept *${name}*.\n\n${r.reasons.join(" ")}`;
  }
  if (r.verdict === "suspicious") {
    return (
      `⚠️ *${name}* contains ${r.reasons.join(", ")}.\n\n` +
      `I can still read the text out of it — nothing in a document runs on this server. ` +
      `But I will *not* pass the file itself to anyone, because it would run on their phone.`
    );
  }
  return "";
}
