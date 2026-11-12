// Generates the extension icons (a refresh arrow) as PNGs with no dependencies.
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";

function crc32(buf) {
  let c,
    crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, pixel) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x, y);
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
      raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
// Ring and gap (screen coordinates: y grows downwards, so angles grow clockwise).
const RING_IN = 0.4,
  RING_OUT = 0.62,
  GAP_FROM = -1.5,
  GAP_TO = -0.25;
// Arrowhead at the clockwise end of the ring (angle GAP_FROM): its base straddles
// the ring radially and its tip points along the clockwise tangent, into the gap.
const ARROW = (() => {
  const a = GAP_FROM,
    mid = (RING_IN + RING_OUT) / 2;
  const n = [Math.cos(a), Math.sin(a)]; // outward
  const t = [-Math.sin(a), Math.cos(a)]; // clockwise tangent
  const base = [mid * n[0], mid * n[1]];
  const half = 0.25,
    len = 0.34;
  return [
    [base[0] + half * n[0], base[1] + half * n[1]],
    [base[0] - half * n[0], base[1] - half * n[1]],
    [base[0] + len * t[0], base[1] + len * t[1]],
  ];
})();
function inTriangle(x, y, [p, q, s]) {
  const side = (a, b) => (x - b[0]) * (a[1] - b[1]) - (a[0] - b[0]) * (y - b[1]);
  const d1 = side(p, q),
    d2 = side(q, s),
    d3 = side(s, p);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
}

/** `pad`: transparent pixels around the artwork on each side (the store icon is 96 px of art in 128). */
function icon(size, pad = 0) {
  const S = 4; // supersampling
  const art = size - 2 * pad;
  return png(size, (px, py) => {
    let cover = 0,
      ring = 0;
    for (let sy = 0; sy < S; sy++)
      for (let sx = 0; sx < S; sx++) {
        const x = ((px - pad + (sx + 0.5) / S) / art) * 2 - 1;
        const y = ((py - pad + (sy + 0.5) / S) / art) * 2 - 1;
        // rounded square background
        const q = Math.max(Math.abs(x), Math.abs(y));
        const rr = 0.35,
          inner = 1 - rr;
        const dx = Math.max(Math.abs(x) - inner, 0),
          dy = Math.max(Math.abs(y) - inner, 0);
        if (q <= inner || Math.hypot(dx, dy) <= rr) cover++;
        // A clockwise refresh arrow (↻): a ring open at the top-right whose
        // end near the top carries an arrowhead pointing along the circle.
        const r = Math.hypot(x, y),
          ang = Math.atan2(y, x);
        const onRing = r > RING_IN && r < RING_OUT && !(ang > GAP_FROM && ang < GAP_TO);
        if (onRing || inTriangle(x, y, ARROW)) ring++;
      }
    const bg = cover / (S * S),
      fg = ring / (S * S);
    const r = Math.round(37 * (1 - fg) + 255 * fg),
      g = Math.round(99 * (1 - fg) + 255 * fg),
      b = Math.round(235 * (1 - fg) + 255 * fg);
    return [r, g, b, Math.round(255 * bg)];
  });
}
mkdirSync("public/icons", { recursive: true });
for (const s of [16, 32, 48, 128]) writeFileSync(`public/icons/icon${s}.png`, icon(s));
// Chrome Web Store icon: 128×128 with the artwork at 96×96 and 16 px of transparent padding.
mkdirSync("store", { recursive: true });
writeFileSync("store/icon-128.png", icon(128, 16));
console.log("icons written");
