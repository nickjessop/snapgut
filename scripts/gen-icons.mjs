// Generates PWA PNG icons with no external deps (uses built-in zlib).
// Draws a dark rounded background with a yellow "plate" circle.
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function png(size) {
  const bg = [17, 17, 17]; // #111
  const accent = [255, 214, 10]; // #ffd60a
  const cx = size / 2;
  const cy = size / 2;
  const plateR = size * 0.34;
  const innerR = size * 0.2;

  const bytesPerRow = size * 4;
  const raw = Buffer.alloc((bytesPerRow + 1) * size);

  for (let y = 0; y < size; y++) {
    raw[y * (bytesPerRow + 1)] = 0; // filter type 0
    for (let x = 0; x < size; x++) {
      const off = y * (bytesPerRow + 1) + 1 + x * 4;
      const d = Math.hypot(x - cx, y - cy);
      let r, g, b;
      if (d < innerR) {
        [r, g, b] = bg; // inner dark circle (food)
      } else if (d < plateR) {
        [r, g, b] = accent; // plate ring
      } else {
        [r, g, b] = bg; // background
      }
      raw[off] = r;
      raw[off + 1] = g;
      raw[off + 2] = b;
      raw[off + 3] = 255;
    }
  }

  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const idat = deflateSync(raw);
  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

mkdirSync(new URL("../public", import.meta.url), { recursive: true });
for (const size of [192, 512]) {
  const out = new URL(`../public/icon-${size}.png`, import.meta.url);
  writeFileSync(out, png(size));
  console.log(`wrote public/icon-${size}.png`);
}
