// Generates the home-screen icons. `node tools/make-icons.js`
//
// Written by hand rather than pulling in an image library: the app ships with
// no dependencies and this is a handful of triangles on a gradient. Node's own
// zlib does the compression, so a PNG encoder is about thirty lines.
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const OUT = path.join(__dirname, "..", "icons");

// ── PNG ────────────────────────────────────────────────────────────
let crcTable = null;
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

// rgba: Uint8Array of size*size*4
function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // truecolour with alpha
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ── the mark ───────────────────────────────────────────────────────
// A paper plane, in coordinates from 0..1. Kept inside the middle 62% so
// Android's maskable crop can't clip it.
const PLANE = [
  [[0.19, 0.53], [0.81, 0.19], [0.45, 0.56]],   // upper wing
  [[0.45, 0.56], [0.81, 0.19], [0.57, 0.81]],   // body
  [[0.45, 0.56], [0.57, 0.81], [0.43, 0.70]],   // fold, slightly darker
];
const FOLD = 2; // index into PLANE that gets the shaded tone

const GRAD_A = [0x6a, 0x8c, 0xff];  // --accent
const GRAD_B = [0xa0, 0x6a, 0xff];  // the violet end of the timeline bar

function inTriangle(px, py, t) {
  const [[ax, ay], [bx, by], [cx, cy]] = t;
  const d = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
  const a = ((by - cy) * (px - cx) + (cx - bx) * (py - cy)) / d;
  const b = ((cy - ay) * (px - cx) + (ax - cx) * (py - cy)) / d;
  return a >= 0 && b >= 0 && a + b <= 1;
}

function render(size, samples) {
  const out = new Uint8Array(size * size * 4);
  const step = 1 / samples;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // supersample: the triangle edges look ragged otherwise
      let hit = 0, fold = 0;
      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const px = (x + (sx + 0.5) * step) / size;
          const py = (y + (sy + 0.5) * step) / size;
          for (let i = 0; i < PLANE.length; i++) {
            if (inTriangle(px, py, PLANE[i])) { hit++; if (i === FOLD) fold++; break; }
          }
        }
      }
      const n = samples * samples;
      const cover = hit / n;
      const foldMix = hit ? fold / hit : 0;

      // diagonal gradient background
      const t = (x / size + y / size) / 2;
      const bg = [0, 1, 2].map((i) => Math.round(GRAD_A[i] + (GRAD_B[i] - GRAD_A[i]) * t));
      // the fold is the same white, dimmed, so the plane reads as folded paper
      const ink = 255 - Math.round(70 * foldMix);

      const o = (y * size + x) * 4;
      for (let i = 0; i < 3; i++) out[o + i] = Math.round(bg[i] * (1 - cover) + ink * cover);
      out[o + 3] = 255;
    }
  }
  return out;
}

fs.mkdirSync(OUT, { recursive: true });
for (const size of [180, 192, 512]) {
  const file = path.join(OUT, "icon-" + size + ".png");
  fs.writeFileSync(file, png(size, render(size, 4)));
  console.log("  " + path.relative(path.join(__dirname, ".."), file) +
              "  " + Math.round(fs.statSync(file).size / 1024) + "KB");
}
