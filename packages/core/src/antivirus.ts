import { connect } from "node:net";

/**
 * Antivirus — every file a person attaches is scanned by ClamAV before anything reads it.
 *
 * ClamAV is the open-source antivirus engine (GPL, Cisco Talos). Its daemon, clamd, listens on
 * TCP and scans a byte stream sent with the INSTREAM command: the command, then chunks each
 * prefixed with a 4-byte big-endian length, then a zero-length chunk; it answers
 * "stream: OK" or "stream: <signature> FOUND" (docs.clamav.net, ClamD Protocol). Speaking that
 * protocol directly needs no npm package — the file never touches the disk here either.
 *
 * Where it sits: document-security.ts calls it after the cheap checks (size, dangerous names,
 * true type) and before anything parses the file, for dashboard uploads and Telegram documents
 * alike. It is one layer, not the defence: OWASP's file-upload guidance treats antivirus as a
 * secondary control because new or modified malware can evade signatures — which is why the
 * structural checks, the sandboxed parser and "never forward a flagged file" stay in place.
 *
 * Off / on / required:
 *   - CLAMAV_HOST unset          → not scanned (the demo's default; production refuses it, rule R6)
 *   - CLAMAV_HOST set, reachable → scanned; a FOUND is refused and audited
 *   - CLAMAV_HOST set, down      → refused ("could not be checked"): fail closed. Someone configured
 *                                  a scanner; a file that slipped past it while it was down would be
 *                                  a silent gap.
 */

export interface ScanResult {
  status: "clean" | "infected" | "error" | "off";
  /** The signature name, when infected — e.g. "Win.Trojan.Agent-123". */
  signature?: string;
  detail?: string;
}

export interface AntivirusConfig {
  host: string;
  port: number;
  timeoutMs: number;
}

export function antivirusConfig(env: NodeJS.ProcessEnv = process.env): AntivirusConfig | null {
  if (!env.CLAMAV_HOST) return null;
  const port = Number(env.CLAMAV_PORT ?? 3310);
  const timeoutMs = Number(env.CLAMAV_TIMEOUT_MS ?? 30_000);
  return { host: env.CLAMAV_HOST, port: Number.isInteger(port) ? port : 3310, timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : 30_000 };
}

const CHUNK = 64 * 1024;

/** Send one z-framed command (plus an optional INSTREAM body) and return clamd's reply. */
function talk(cfg: AntivirusConfig, command: string, body?: Uint8Array): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: cfg.host, port: cfg.port });
    let reply = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`clamd did not answer within ${cfg.timeoutMs} ms`));
    }, cfg.timeoutMs);
    const done = (err?: Error) => {
      clearTimeout(timer);
      socket.destroy();
      if (err) reject(err);
      else resolve(reply.replace(/\0+$/, "").trim());
    };
    socket.on("error", (e) => done(e));
    socket.on("data", (d) => {
      reply += d.toString("utf8");
      if (reply.includes("\0")) done();
    });
    socket.on("end", () => done());
    socket.on("connect", () => {
      socket.write(`z${command}\0`);
      if (body) {
        for (let i = 0; i < body.length; i += CHUNK) {
          const part = body.subarray(i, Math.min(i + CHUNK, body.length));
          const len = Buffer.alloc(4);
          len.writeUInt32BE(part.length, 0);
          socket.write(len);
          socket.write(part);
        }
        socket.write(Buffer.alloc(4)); // a zero-length chunk ends the stream
      }
    });
  });
}

/** Scan bytes. Never throws: a scanner problem is a result the caller decides on. */
export async function scanBytes(bytes: Uint8Array, env: NodeJS.ProcessEnv = process.env): Promise<ScanResult> {
  const cfg = antivirusConfig(env);
  if (!cfg) return { status: "off" };
  try {
    const reply = await talk(cfg, "INSTREAM", bytes);
    // "stream: OK" | "stream: Eicar-Signature FOUND" | "INSTREAM size limit exceeded. ERROR"
    if (/:\s*OK$/.test(reply)) return { status: "clean" };
    const found = /:\s*(.+?)\s+FOUND$/.exec(reply);
    if (found) return { status: "infected", signature: found[1]!.slice(0, 120) };
    return { status: "error", detail: reply.slice(0, 200) || "no reply" };
  } catch (e) {
    return { status: "error", detail: e instanceof Error ? e.message : String(e) };
  }
}

/** For /health and the Compliance page: is a scanner configured, and does it answer? */
export async function antivirusStatus(env: NodeJS.ProcessEnv = process.env): Promise<{ configured: boolean; reachable: boolean; detail?: string }> {
  const cfg = antivirusConfig(env);
  if (!cfg) return { configured: false, reachable: false };
  try {
    const pong = await talk({ ...cfg, timeoutMs: Math.min(cfg.timeoutMs, 3000) }, "PING");
    return { configured: true, reachable: pong === "PONG", ...(pong === "PONG" ? {} : { detail: pong }) };
  } catch (e) {
    return { configured: true, reachable: false, detail: e instanceof Error ? e.message : String(e) };
  }
}
