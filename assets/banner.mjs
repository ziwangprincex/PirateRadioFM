// Generates assets/banner.png — the repo's pixel-art banner. Pure Node, no
// dependencies: pixels are drawn on a 320x80 logical grid, upscaled 4x, and
// encoded as a PNG by hand (zlib is built in). Rerun after edits:
//   node assets/banner.mjs
import { writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const W = 320, H = 80, S = 4; // logical grid + upscale factor

// --- palette -----------------------------------------------------------------
const C = {
  bgTop: "#15182a", bgMid: "#1a1e33", bgBot: "#20263f",
  frame: "#2c3252", panel: "#0d101f", panelLine: "#3a4166",
  star: "#54608f", starHi: "#c7d2f4",
  cream: "#f2e6c8", creamDim: "#a9b2d6", amber: "#f2a33c", amberDk: "#b26a1e",
  teal: "#5fd4c4", pink: "#ef7f9e", red: "#e4574d",
  ink: "#101322", body: "#e9dcc4", bodyShade: "#c4b391", bodyDk: "#8f7f5d",
  grill: "#232743", ghost: "#f4f6ff", ghostShade: "#c3cdf0", eye: "#232743",
};
const hex = (s) => [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16));
for (const k of Object.keys(C)) C[k] = hex(C[k]);

// --- canvas ------------------------------------------------------------------
const buf = Buffer.alloc(W * S * H * S * 3);
function px(x, y, c) {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  for (let sy = 0; sy < S; sy++) {
    let o = ((y * S + sy) * W * S + x * S) * 3;
    for (let sx = 0; sx < S; sx++) { buf[o++] = c[0]; buf[o++] = c[1]; buf[o++] = c[2]; }
  }
}
function rect(x, y, w, h, c) { for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) px(x + i, y + j, c); }
function hline(x, y, w, c) { rect(x, y, w, 1, c); }
function vline(x, y, h, c) { rect(x, y, 1, h, c); }

// --- 5x7 pixel font ------------------------------------------------------------
// Uppercase + the lowercase needed for "PirateRadioFM", digits kept for reuse.
const F = {
  A: "01110 10001 10001 11111 10001 10001 10001", B: "11110 10001 11110 10001 10001 10001 11110",
  C: "01110 10001 10000 10000 10000 10001 01110", D: "11110 10001 10001 10001 10001 10001 11110",
  E: "11111 10000 11110 10000 10000 10000 11111", F: "11111 10000 11110 10000 10000 10000 10000",
  G: "01110 10001 10000 10111 10001 10001 01111", H: "10001 10001 11111 10001 10001 10001 10001",
  I: "11111 00100 00100 00100 00100 00100 11111", J: "00111 00010 00010 00010 00010 10010 01100",
  K: "10001 10010 11100 10010 10001 10001 10001", L: "10000 10000 10000 10000 10000 10000 11111",
  M: "10001 11011 10101 10101 10001 10001 10001", N: "10001 11001 10101 10011 10001 10001 10001",
  O: "01110 10001 10001 10001 10001 10001 01110", P: "11110 10001 10001 11110 10000 10000 10000",
  R: "11110 10001 10001 11110 10010 10001 10001", S: "01111 10000 10000 01110 00001 00001 11110",
  T: "11111 00100 00100 00100 00100 00100 00100", U: "10001 10001 10001 10001 10001 10001 01110",
  V: "10001 10001 10001 10001 10001 01010 00100", W: "10001 10001 10001 10101 10101 11011 10001",
  X: "10001 10001 01010 00100 01010 10001 10001", Y: "10001 10001 01010 00100 00100 00100 00100",
  Z: "11111 00001 00010 00100 01000 10000 11111", "Ö": "01010 00000 01110 10001 10001 10001 01110",
  "0": "01110 10001 10011 10101 11001 10001 01110", "1": "00100 01100 00100 00100 00100 00100 01110",
  "2": "01110 10001 00001 00110 01000 10000 11111", "3": "11110 00001 00001 01110 00001 00001 11110",
  "5": "11111 10000 11110 00001 00001 10001 01110", "7": "11111 00001 00010 00100 01000 01000 01000",
  "8": "01110 10001 10001 01110 10001 10001 01110", "9": "01110 10001 10001 01111 00001 00001 01110",
  ".": "00000 00000 00000 00000 00000 00000 00100", "-": "00000 00000 00000 01110 00000 00000 00000",
  "·": "00000 00000 00000 00100 00000 00000 00000", "/": "00001 00010 00010 00100 01000 01000 10000",
  " ": "00000 00000 00000 00000 00000 00000 00000",
  i: "00100 00000 01100 00100 00100 00100 01110", r: "00000 00000 10110 11001 10000 10000 10000",
  a: "00000 00000 01110 00001 01111 10001 01111", t: "00100 00100 11111 00100 00100 00101 00010",
  e: "00000 00000 01110 10001 11111 10000 01110", d: "00001 00001 01101 10011 10001 10011 01101",
  o: "00000 00000 01110 10001 10001 10001 01110",
};
function glyph(ch, x, y, c, sc = 1) {
  const rows = (F[ch] ?? F["·"]).split(" ");
  for (let j = 0; j < 7; j++)
    for (let i = 0; i < 5; i++)
      if (rows[j][i] === "1") rect(x + i * sc, y + j * sc, sc, sc, c);
}
// Draws a string; segments = [[text, color], ...] so one line can be multicolor.
// bold double-draws each glyph 1px right, thickening vertical strokes; the char
// advance grows by 1 so bold letters keep a gap between them.
function text(segments, x, y, sc = 1, bold = false) {
  let cx = x;
  for (const [str, col] of segments)
    for (const ch of str) {
      glyph(ch, cx, y, col, sc);
      if (bold) glyph(ch, cx + 1, y, col, sc);
      cx += 6 * sc + (bold ? 1 : 0);
    }
  return cx;
}
const textW = (s, sc = 1) => s.length * 6 * sc - sc;

// --- background ----------------------------------------------------------------
rect(0, 0, W, 28, C.bgTop);
rect(0, 28, W, 28, C.bgMid);
rect(0, 56, W, H - 56, C.bgBot);
// stars: dim singles + a few bright plus-shaped sparkles
const stars = [
  [12, 6], [30, 11], [52, 5], [74, 9], [96, 4], [118, 10], [140, 6], [163, 12],
  [187, 5], [209, 9], [232, 6], [254, 12], [276, 7], [298, 11], [310, 24],
  [8, 30], [305, 40], [14, 48], [300, 52], [190, 14], [260, 26],
];
for (const [x, y] of stars) px(x, y, C.star);
for (const [x, y] of [[52, 5], [187, 5], [276, 7], [310, 24]]) {
  px(x, y, C.starHi); px(x - 1, y, C.star); px(x + 1, y, C.star); px(x, y - 1, C.star); px(x, y + 1, C.star);
}

// --- dial strip (bottom panel) ---------------------------------------------------
const P_Y = 58, P_H = 20;
rect(2, P_Y, W - 4, P_H, C.panel);
hline(2, P_Y, W - 4, C.panelLine);
// minor ticks along the top of the panel
for (let x = 8; x < W - 8; x += 6) vline(x, P_Y + 3, 3, C.star);
// stations laid out like presets on an FM dial; KEXP holds the needle
const stations = [
  ["KCRW", 10], ["KEXP", 53], ["WWOZ", 96], ["WFMU", 139],
  ["NTS", 182], ["HÖR", 219], ["PARADISE", 256],
];
for (const [name, x] of stations) {
  const cx = x + Math.floor(textW(name) / 2);
  const active = name === "KEXP";
  vline(cx, P_Y + 2, 5, active ? C.red : C.creamDim);
  if (active) { vline(cx - 1, P_Y + 2, 5, C.red); px(cx, P_Y + 1, C.red); }
  text([[name, active ? C.amber : C.creamDim]], x, P_Y + 9);
}

// --- boombox ---------------------------------------------------------------------
const bx = 20, by = 16, bw = 64, bh = 38; // body: x 20-84, y 16-54
// handle
vline(36, 10, 6, C.bodyShade); vline(37, 10, 6, C.bodyShade);
vline(66, 10, 6, C.bodyShade); vline(67, 10, 6, C.bodyShade);
hline(36, 10, 32, C.body); hline(36, 11, 32, C.bodyShade);
// body with 1px dark outline and bottom shade
rect(bx - 1, by - 1, bw + 2, bh + 2, C.ink);
rect(bx, by, bw, bh, C.body);
rect(bx, by + bh - 4, bw, 4, C.bodyShade);
hline(bx, by, bw, [255, 255, 255].map((v, i) => Math.min(255, C.body[i] + 24)));
// feet
rect(bx + 4, by + bh + 1, 6, 2, C.ink); rect(bx + bw - 10, by + bh + 1, 6, 2, C.ink);
// speakers: concentric square rings
function speaker(cx, cy) {
  rect(cx - 9, cy - 9, 18, 18, C.grill);
  rect(cx - 8, cy - 8, 16, 16, C.ink);
  rect(cx - 6, cy - 6, 12, 12, C.grill);
  rect(cx - 4, cy - 4, 8, 8, C.ink);
  rect(cx - 2, cy - 2, 4, 4, C.amber);
  px(cx - 2, cy - 2, C.cream); // glint
}
speaker(34, 37); speaker(70, 37);
// center console: dial window, buttons, cassette
rect(45, by + 5, 14, 8, C.ink);
rect(46, by + 6, 12, 6, C.amberDk);
rect(46, by + 6, 12, 2, C.amber);
vline(51, by + 6, 6, C.red); // tuning needle
rect(46, by + 16, 3, 3, C.teal); rect(51, by + 16, 3, 3, C.pink); rect(56, by + 16, 2, 3, C.cream);
rect(45, by + 22, 14, 9, C.ink);
rect(47, by + 24, 4, 4, C.cream); rect(53, by + 24, 4, 4, C.cream); // reels
px(48, by + 25, C.ink); px(54, by + 25, C.ink);
// antenna up-right from the body corner, pirate flag at the tip
for (let i = 0; i < 12; i++) px(80 + i, 15 - i, C.creamDim);
vline(92, 3, 2, C.creamDim);
rect(93, 3, 13, 9, C.ink);
// skull: rounded head, two eye sockets, two teeth
rect(97, 4, 5, 3, C.cream);
rect(98, 7, 3, 1, C.cream);
px(98, 5, C.ink); px(100, 5, C.ink);
px(98, 8, C.cream); px(100, 8, C.cream);

// --- title -----------------------------------------------------------------------
text([
  ["Pirate", C.cream],
  ["Radio", C.amber],
  ["FM", C.teal],
], 98, 19, 2, true);
text([["INTERNET RADIO IN YOUR CLI", C.creamDim]], 100, 38);
text([["/JAZZ /LOFI /PODCAST /HOER", C.teal]], 100, 48);

// --- music notes drifting top-right ----------------------------------------------
function note(x, y, c) {
  vline(x + 3, y, 5, c);
  hline(x + 3, y, 3, c); px(x + 5, y + 1, c);
  rect(x, y + 4, 3, 2, c);
}
note(276, 16, C.pink); note(292, 26, C.teal); note(304, 10, C.amber);
// tiny broadcast arcs from the antenna flag
px(108, 6, C.teal); px(110, 4, C.teal); px(109, 9, C.teal);

// --- frame -----------------------------------------------------------------------
rect(0, 0, W, 2, C.frame); rect(0, H - 2, W, 2, C.frame);
rect(0, 0, 2, H, C.frame); rect(W - 2, 0, 2, H, C.frame);

// --- PNG encode -------------------------------------------------------------------
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (b) => {
  let c = 0xffffffff;
  for (const byte of b) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W * S, 0); ihdr.writeUInt32BE(H * S, 4);
ihdr[8] = 8; ihdr[9] = 2; // 8-bit truecolor
const rows = [];
for (let y = 0; y < H * S; y++) {
  rows.push(Buffer.from([0]), buf.subarray(y * W * S * 3, (y + 1) * W * S * 3));
}
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(Buffer.concat(rows), { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);
const out = join(dirname(fileURLToPath(import.meta.url)), "banner.png");
writeFileSync(out, png);
console.log(`wrote ${out} (${W * S}x${H * S}, ${png.length} bytes)`);
