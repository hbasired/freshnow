import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { MEDIA_LIMITS, MediaError, cleanMp4, cleanPhoto, sha256, sniff } from "./media-process.js";

/**
 * Making phone media safe to keep (TASK-058). The fixtures are built here, byte by byte or by sharp,
 * so the tests know exactly what went in: a photo that DOES carry a GPS block, an MP4 that DOES carry
 * a location atom — and then check that it is gone.
 */

const photo = (width: number, height: number, exif?: Record<string, Record<string, string>>): Promise<Buffer> => {
  const s = sharp({ create: { width, height, channels: 3, background: { r: 200, g: 120, b: 40 } } }).jpeg();
  return (exif ? s.withExif(exif) : s).toBuffer();
};
const GPS = { GPSLatitudeRef: "N", GPSLatitude: "25/1 12/1 1728/100", GPSLongitudeRef: "E", GPSLongitude: "55/1 16/1 1428/100" };
// The GPS IFD pointer is TIFF tag 0x8825, in either byte order.
const hasGpsPointer = (exif: Buffer | undefined): boolean =>
  !!exif && (exif.includes(Buffer.from([0x88, 0x25])) || exif.includes(Buffer.from([0x25, 0x88])));

/** An ISO-BMFF box: 32-bit size, 4-char type, body. */
const box = (type: string, ...parts: Buffer[]): Buffer => {
  const body = Buffer.concat(parts);
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + body.length);
  head.write(type, 4, "latin1");
  return Buffer.concat([head, body]);
};
/** mvhd version 0: flags, creation, modification, then timescale at +12 and duration at +16. */
const mvhd = (timescale: number, duration: number): Buffer => {
  const p = Buffer.alloc(100);
  p.writeUInt32BE(timescale, 12);
  p.writeUInt32BE(duration, 16);
  return box("mvhd", p);
};
const WHERE = "+25.2048+055.2708/";
const mp4 = (): Buffer =>
  Buffer.concat([
    box("ftyp", Buffer.from("isom\0\0\x02\0isomiso2avc1mp41", "latin1")),
    box(
      "moov",
      mvhd(1000, 12_000),
      box("trak", box("tkhd", Buffer.alloc(84)), box("udta", box("\xa9xyz", Buffer.from(`\0\x12\x15\xc7${WHERE}`, "latin1")))),
      box("udta", box("\xa9xyz", Buffer.from(`\0\x12\x15\xc7${WHERE}`, "latin1")), box("\xa9mod", Buffer.from("SomePhone 12", "latin1"))),
      box("meta", Buffer.alloc(4), box("hdlr", Buffer.alloc(24))),
    ),
    box("mdat", Buffer.alloc(256, 7)),
  ]);

describe("what the bytes are", () => {
  it("is decided by the signature, not the name", async () => {
    expect(sniff(await photo(8, 8))).toBe("image/jpeg");
    expect(sniff(await sharp({ create: { width: 4, height: 4, channels: 3, background: "#fff" } }).png().toBuffer())).toBe("image/png");
    expect(sniff(await sharp({ create: { width: 4, height: 4, channels: 3, background: "#fff" } }).webp().toBuffer())).toBe("image/webp");
    expect(sniff(mp4())).toBe("video/mp4");
    expect(sniff(Buffer.concat([box("ftyp", Buffer.from("heic\0\0\0\0mif1heic", "latin1"))]))).toBe("image/heic");
    expect(sniff(Buffer.from("%PDF-1.7 not a picture"))).toBe("unknown");
    expect(sniff(new Uint8Array())).toBe("unknown");
  });
});

describe("a photo", () => {
  it("loses every metadata block — the GPS location included — and keeps the picture", async () => {
    const input = await photo(64, 48, { IFD0: { Make: "TestPhone", Model: "X1" }, IFD3: GPS });
    const before = await sharp(input).metadata();
    expect(hasGpsPointer(before.exif)).toBe(true); // the fixture really carries a location
    const c = await cleanPhoto(input);
    const after = await sharp(c.bytes).metadata();
    expect(after.exif).toBeUndefined();
    expect(after.icc).toBeUndefined();
    expect(after.xmp).toBeUndefined();
    expect(c.bytes.includes(Buffer.from("TestPhone"))).toBe(false);
    expect([c.width, c.height]).toEqual([64, 48]);
    expect(after.format).toBe("jpeg");
    expect((await sharp(c.thumb).metadata()).exif).toBeUndefined();
  });

  it("is turned upright before its orientation tag is dropped", async () => {
    // "Rotate 90° to view", as a phone held upright writes it. (An Orientation key passed through
    // withExif is overridden by libvips' own orientation field — set it the way sharp reads it.)
    const sideways = await sharp({ create: { width: 40, height: 20, channels: 3, background: "#c87828" } })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();
    expect((await sharp(sideways).metadata()).orientation).toBe(6);
    const c = await cleanPhoto(sideways);
    expect([c.width, c.height]).toEqual([20, 40]);
  });

  it("is shrunk to the longest edge kept, and a thumbnail is made", async () => {
    const big = await photo(3000, 1500);
    const c = await cleanPhoto(big);
    expect(Math.max(c.width, c.height)).toBe(MEDIA_LIMITS.maxEdge);
    const t = await sharp(c.thumb).metadata();
    expect(Math.max(t.width ?? 0, t.height ?? 0)).toBe(MEDIA_LIMITS.thumbEdge);
  });

  it("refuses bytes that are not a readable picture, with words the sender can act on", async () => {
    const broken = (await photo(32, 32)).subarray(0, 200);
    await expect(cleanPhoto(broken)).rejects.toThrow(MediaError);
    await expect(cleanPhoto(broken)).rejects.toThrow(/take it again/);
  });
});

describe("a short video", () => {
  it("loses its location and device tags without being re-encoded: same length, offsets intact", () => {
    const input = mp4();
    expect(input.includes(Buffer.from(WHERE, "latin1"))).toBe(true);
    const c = cleanMp4(input);
    expect(c.bytes.length).toBe(input.length);
    expect(c.bytes.includes(Buffer.from(WHERE, "latin1"))).toBe(false);
    expect(c.bytes.includes(Buffer.from("SomePhone", "latin1"))).toBe(false);
    expect(c.neutralised).toEqual(["/moov/trak/udta", "/moov/udta", "/moov/meta"]);
    expect(c.durationMs).toBe(12_000);
    // The picture data is untouched, at the same place.
    const at = input.indexOf(Buffer.from("mdat", "latin1"));
    expect(c.bytes.subarray(at).equals(input.subarray(at))).toBe(true);
    // The caller's bytes are not changed.
    expect(input.includes(Buffer.from(WHERE, "latin1"))).toBe(true);
  });

  it("reads a fragmented video's length from mehd, and calls no readable length unknown — never 0 (TASK-058 review)", () => {
    // MediaRecorder/DASH style: mvhd says 0; the movie's length is moov/mvex/mehd, in mvhd's timescale.
    const mehd = (duration: number): Buffer => {
      const p = Buffer.alloc(8);
      p.writeUInt32BE(duration, 4); // version 0, flags 0, then fragment_duration
      return box("mehd", p);
    };
    const fragmented = (withMehd: boolean): Buffer =>
      Buffer.concat([
        box("ftyp", Buffer.from("iso5\0\0\x02\0iso5iso6mp41", "latin1")),
        box("moov", mvhd(1000, 0), box("trak", box("tkhd", Buffer.alloc(84))), box("mvex", ...(withMehd ? [mehd(20_000)] : []), box("trex", Buffer.alloc(24)))),
        box("moof", box("mfhd", Buffer.alloc(8))),
        box("mdat", Buffer.alloc(64, 3)),
      ]);
    expect(cleanMp4(fragmented(true)).durationMs).toBe(20_000); // 20 s: storeMedia refuses it, as it should
    expect(cleanMp4(fragmented(false)).durationMs).toBeNull(); // no length anywhere: unknown, so refused
  });

  it("refuses a file whose boxes run past its end", () => {
    const cut = mp4().subarray(0, 120);
    expect(() => cleanMp4(cut)).toThrow(/damaged or cut short/);
  });
});

it("names cleaned bytes by their content", () => {
  expect(sha256(Buffer.from("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});
