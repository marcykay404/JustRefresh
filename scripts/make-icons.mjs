// Generates the extension icons (a refresh arrow) as PNGs with no dependencies.
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, pixel) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x, y);
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
function icon(size) {
  const S = 4; // supersampling
  return png(size, (px, py) => {
    let cover = 0, ring = 0;
    for (let sy = 0; sy < S; sy++) for (let sx = 0; sx < S; sx++) {
      const x = (px + (sx + 0.5) / S) / size * 2 - 1;
      const y = (py + (sy + 0.5) / S) / size * 2 - 1;
      // rounded square background
      const q = Math.max(Math.abs(x), Math.abs(y));
      const rr = 0.35, inner = 1 - rr;
      const dx = Math.max(Math.abs(x) - inner, 0), dy = Math.max(Math.abs(y) - inner, 0);
      if ((q <= inner) || Math.hypot(dx, dy) <= rr) cover++;
      // ring with a gap at the top-right and an arrowhead
      const r = Math.hypot(x, y), ang = Math.atan2(y, x);
      const onRing = r > 0.42 && r < 0.62 && !(ang > -1.45 && ang < -0.35);
      const ax = x - 0.3, ay = y + 0.62; // arrowhead near gap end
      const inArrow = ay > -0.05 && ay < 0.33 && Math.abs(ax) < (0.33 - ay) * 0.95 && ay > -0.05;
      if (onRing || inArrow) ring++;
    }
    const bg = cover / (S * S), fg = ring / (S * S);
    const r = Math.round(37 * (1 - fg) + 255 * fg), g = Math.round(99 * (1 - fg) + 255 * fg), b = Math.round(235 * (1 - fg) + 255 * fg);
    return [r, g, b, Math.round(255 * bg)];
  });
}
mkdirSync("public/icons", { recursive: true });
for (const s of [16, 32, 48, 128]) writeFileSync(`public/icons/icon${s}.png`, icon(s));
console.log("icons written");
