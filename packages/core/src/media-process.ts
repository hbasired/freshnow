import { createHash } from "node:crypto";
import sharp from "sharp";

/**
 * Photos and short videos from phones, made safe to keep (TASK-058). Pure functions: bytes in,
 * cleaned bytes out — no database, no storage.
 *
 * What "safe" means here: a phone writes where and when a picture was taken, and by which device,
 * into the file. None of that is evidence of the work, and the location is personal data (PDPL,
 * data minimisation). So:
 *   - a photo is decoded and re-encoded — sharp keeps NO metadata by default (EXIF incl. GPS, ICC,
 *     XMP, IPTC; checked against sharp's output docs and a test that writes a GPS block first);
 *   - a video is not re-encoded (no ffmpeg on a shared server); the MP4 boxes that carry location
 *     and device tags are renamed "free" and zeroed in place.
 * The type is decided by the file's first bytes, never by the name or the declared type.
 */

export type SniffedType = "image/jpeg" | "image/png" | "image/webp" | "video/mp4" | "image/heic" | "unknown";

/** Bounds on what is accepted; the bucket also refuses anything over 50 MiB. */
export const MEDIA_LIMITS = {
  photoBytes: 25 * 1024 * 1024,
  videoBytes: 50 * 1024 * 1024,
  /** The plan's "short video" for evidence (a dispenser clip). */
  videoMs: 15_000,
  /** Longest edge kept for a photo — enough to read a counter or a receipt. */
  maxEdge: 2048,
  thumbEdge: 320,
  /** About 8000 × 6000; a decompression bomb is refused before decoding. */
  maxPixels: 50_000_000,
} as const;

/** A refusal the uploader can act on; `status` is the HTTP code an API answers with. */
export class MediaError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "MediaError";
  }
}

const HEIF_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "heim", "heis", "mif1", "msf1"]);
const MP4_BRANDS = new Set(["isom", "iso2", "iso4", "iso5", "iso6", "mp41", "mp42", "avc1", "M4V ", "3gp4", "3gp5", "3gp6", "3g2a", "MSNV", "dash"]);

/** What the bytes are, by their signature. */
export function sniff(b: Uint8Array): SniffedType {
  const ascii = (from: number, to: number): string => Buffer.from(b.subarray(from, to)).toString("latin1");
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 8 && ascii(0, 8) === "\x89PNG\r\n\x1a\n") return "image/png";
  if (b.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  if (b.length >= 12 && ascii(4, 8) === "ftyp") {
    const brand = ascii(8, 12);
    if (HEIF_BRANDS.has(brand)) return "image/heic";
    if (MP4_BRANDS.has(brand)) return "video/mp4";
  }
  return "unknown";
}

export function sha256(b: Uint8Array): string {
  return createHash("sha256").update(b).digest("hex");
}

export interface CleanPhoto {
  bytes: Buffer;
  thumb: Buffer;
  width: number;
  height: number;
  mime: "image/jpeg";
}

/**
 * Decode, turn upright (the EXIF orientation is applied before EXIF is dropped), shrink to
 * MEDIA_LIMITS.maxEdge, and re-encode as JPEG with no metadata; plus a small thumbnail.
 */
export async function cleanPhoto(input: Uint8Array): Promise<CleanPhoto> {
  if (input.length > MEDIA_LIMITS.photoBytes) throw new MediaError("That photo is too large (25 MB at most).", 413);
  try {
    const base = sharp(input, { failOn: "error", limitInputPixels: MEDIA_LIMITS.maxPixels }).rotate();
    const full = await base
      .clone()
      .resize({ width: MEDIA_LIMITS.maxEdge, height: MEDIA_LIMITS.maxEdge, fit: "inside", withoutEnlargement: true })
      .flatten({ background: "#ffffff" })
      .jpeg({ quality: 82, mozjpeg: true })
      .toBuffer({ resolveWithObject: true });
    const thumb = await base
      .clone()
      .resize({ width: MEDIA_LIMITS.thumbEdge, height: MEDIA_LIMITS.thumbEdge, fit: "inside", withoutEnlargement: true })
      .flatten({ background: "#ffffff" })
      .jpeg({ quality: 70 })
      .toBuffer();
    return { bytes: full.data, thumb, width: full.info.width, height: full.info.height, mime: "image/jpeg" };
  } catch (err) {
    if (err instanceof MediaError) throw err;
    throw new MediaError("That photo could not be read — it may be damaged. Please take it again.", 422);
  }
}

export interface CleanVideo {
  bytes: Buffer;
  durationMs: number | null;
  /** The boxes neutralised, as paths ("/moov/udta") — kept in the record of what was removed. */
  neutralised: string[];
}

/** XMP inside an MP4 (where some apps keep GPS): a "uuid" box with this id. */
const XMP_UUID = Buffer.from("be7acfcb97a942e89c71999491e3afac", "hex");

/**
 * Walk the MP4's boxes; neutralise every udta and meta box (and XMP) at the top level, in moov and
 * in each trak; read the duration from mvhd. The file keeps its exact length, so every offset stays
 * valid and nothing needs re-encoding.
 */
export function cleanMp4(input: Uint8Array): CleanVideo {
  if (input.length > MEDIA_LIMITS.videoBytes) throw new MediaError("That video is too large (50 MB at most).", 413);
  const b = Buffer.from(input); // a copy: the caller's bytes are not changed
  const neutralised: string[] = [];
  let durationMs: number | null = null;
  let timescale: number | null = null;
  // A fragmented MP4 (MediaRecorder, DASH) says 0 in mvhd: its length is in moov/mvex/mehd, in the
  // movie's timescale (TASK-058 review — a 20 s fragmented clip read as 0 ms passed the 15 s rule).
  let fragmentDuration: number | null = null;
  const damaged = (): MediaError => new MediaError("That video file is damaged or cut short. Please record it again.", 422);

  const walk = (start: number, end: number, path: string, depth: number): void => {
    if (depth > 4) return; // moov → trak is as deep as location lives; bounded either way
    let p = start;
    while (p + 8 <= end) {
      let size = b.readUInt32BE(p);
      const type = b.toString("latin1", p + 4, p + 8);
      let header = 8;
      if (size === 1) {
        if (p + 16 > end) throw damaged();
        const big = b.readBigUInt64BE(p + 8);
        if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw damaged();
        size = Number(big);
        header = 16;
      } else if (size === 0) {
        size = end - p; // "to the end of the file"
      }
      if (size < header || p + size > end) throw damaged();
      const here = `${path}/${type}`;
      const isXmp = type === "uuid" && size >= header + 16 && b.subarray(p + header, p + header + 16).equals(XMP_UUID);
      if (type === "udta" || type === "meta" || isXmp) {
        // Players skip "free" boxes; zeroing the payload removes the data itself, not just its name.
        b.write("free", p + 4, "latin1");
        b.fill(0, p + header, p + size);
        neutralised.push(here);
      } else if (type === "moov" || type === "trak" || type === "mvex") {
        walk(p + header, p + size, here, depth + 1);
      } else if (type === "mvhd") {
        const m = readMvhd(b, p + header, p + size);
        if (m) {
          timescale = m.timescale;
          durationMs = m.durationMs;
        }
      } else if (type === "mehd") {
        fragmentDuration = readMehd(b, p + header, p + size) ?? fragmentDuration;
      }
      p += size;
    }
  };
  walk(0, b.length, "", 0);
  if ((durationMs === null || durationMs <= 0) && fragmentDuration !== null && timescale) {
    durationMs = Math.round((fragmentDuration * 1000) / timescale);
  }
  // A length of 0 is not a length: an unknown duration is refused, never taken as "short enough".
  return { bytes: b, durationMs: durationMs !== null && durationMs > 0 ? durationMs : null, neutralised };
}

/** mvhd: version(1) flags(3), then 32- or 64-bit times, timescale, duration. */
function readMvhd(b: Buffer, off: number, end: number): { timescale: number; durationMs: number | null } | null {
  if (off + 4 > end) return null;
  const version = b[off];
  const timescaleAt = off + 4 + (version === 1 ? 16 : 8);
  if (timescaleAt + (version === 1 ? 12 : 8) > end) return null;
  const timescale = b.readUInt32BE(timescaleAt);
  const duration = version === 1 ? Number(b.readBigUInt64BE(timescaleAt + 4)) : b.readUInt32BE(timescaleAt + 4);
  return timescale > 0 ? { timescale, durationMs: Math.round((duration * 1000) / timescale) } : null;
}

/** mehd: version(1) flags(3), then fragment_duration — 32 bits (version 0) or 64 (version 1). */
function readMehd(b: Buffer, off: number, end: number): number | null {
  if (off + 4 > end) return null;
  const version = b[off];
  if (off + 4 + (version === 1 ? 8 : 4) > end) return null;
  return version === 1 ? Number(b.readBigUInt64BE(off + 4)) : b.readUInt32BE(off + 4);
}
