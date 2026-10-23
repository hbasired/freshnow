import sharp from "sharp";
const img = await sharp({ create: { width: 64, height: 48, channels: 3, background: { r: 200, g: 120, b: 40 } } })
  .jpeg()
  .withExif({ IFD0: { Make: "TestPhone", Model: "X1" }, IFD3: { GPSLatitudeRef: "N", GPSLatitude: "25/1 12/1 1728/100", GPSLongitudeRef: "E", GPSLongitude: "55/1 16/1 1428/100" } })
  .toBuffer();
const m = await sharp(img).metadata();
const ex = m.exif ?? Buffer.alloc(0);
// The GPS IFD pointer is tag 0x8825 in IFD0 (TIFF, either byte order).
const hasGpsPointer = ex.includes(Buffer.from([0x88, 0x25])) || ex.includes(Buffer.from([0x25, 0x88]));
console.log("input: exif bytes", ex.length, "| GPS IFD pointer present:", hasGpsPointer, "| has 'TestPhone':", ex.includes(Buffer.from("TestPhone")));
const clean = await sharp(img).rotate().jpeg({ quality: 82 }).toBuffer();
const c = await sharp(clean).metadata();
console.log("after default re-encode: exif", c.exif ? c.exif.length + " bytes" : "none", "| icc", c.icc ? "yes" : "none", "| xmp", c.xmp ? "yes" : "none");
