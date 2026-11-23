// news-image-20261123 — renders entry.png (1024x1024), a newspaper infographic
// summing up Monday 23 November 2026. Node 22, stdlib only, fully deterministic:
// no randomness, no clock, no network. Run: MAKEFUN_OUTPUT_DIR=out node main.ts
import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";

// ---------- PNG encoding ----------
const CRC = (() => {
  const tab = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    tab[n] = c >>> 0;
  }
  return tab;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
function savePng(rgb, w, h, file) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    rgb.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  fs.writeFileSync(file, png);
}

// ---------- Raster sheet: plain RGB buffer with thick-stroke drawing ----------
const W = 1024, H = 1024;
const PAPER = [247, 241, 222];
const INK = [25, 25, 25];
const RED = [161, 31, 31];
const NAVY = [34, 64, 94];
const STEEL = [77, 124, 176];
const LIGHT = [214, 228, 240];
const GREY = [107, 107, 96];
const ORANGE = [224, 122, 31];

class Sheet {
  constructor() {
    this.px = Buffer.alloc(W * H * 3);
    for (let i = 0; i < W * H; i++) {
      this.px[i * 3] = PAPER[0]; this.px[i * 3 + 1] = PAPER[1]; this.px[i * 3 + 2] = PAPER[2];
    }
  }
  put(x, y, c) {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const i = (y * W + x) * 3;
    this.px[i] = c[0]; this.px[i + 1] = c[1]; this.px[i + 2] = c[2];
  }
  box(x, y, w, h, c) {
    const x0 = Math.max(0, Math.round(x)), y0 = Math.max(0, Math.round(y));
    const x1 = Math.min(W, Math.round(x + w)), y1 = Math.min(H, Math.round(y + h));
    for (let yy = y0; yy < y1; yy++) {
      for (let xx = x0; xx < x1; xx++) {
        const i = (yy * W + xx) * 3;
        this.px[i] = c[0]; this.px[i + 1] = c[1]; this.px[i + 2] = c[2];
      }
    }
  }
  hline(x0, x1, y, w, c) { this.box(x0, y - w / 2, x1 - x0, w, c); }
  vline(x, y0, y1, w, c) { this.box(x - w / 2, y0, w, y1 - y0, c); }
  dot(cx, cy, r, c) {
    const x0 = Math.floor(cx - r), x1 = Math.ceil(cx + r);
    const y0 = Math.floor(cy - r), y1 = Math.ceil(cy + r);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
        if (dx * dx + dy * dy <= r * r) this.put(x, y, c);
      }
    }
  }
  seg(x0, y0, x1, y1, w, c) {
    const dx = x1 - x0, dy = y1 - y0;
    const len = Math.hypot(dx, dy);
    const step = Math.max(0.5, w / 3);
    const n = Math.max(1, Math.ceil(len / step));
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      this.dot(x0 + dx * t, y0 + dy * t, w / 2, c);
    }
  }
  poly(pts, w, c) {
    for (let i = 0; i + 1 < pts.length; i++) {
      this.seg(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], w, c);
    }
  }
  ring(cx, cy, r, w, c) {
    const steps = Math.max(24, Math.floor(r * 2));
    let prev = null;
    for (let i = 0; i <= steps; i++) {
      const a = (i / steps) * Math.PI * 2;
      const p = [cx + Math.cos(a) * r, cy + Math.sin(a) * r];
      if (prev) this.seg(prev[0], prev[1], p[0], p[1], w, c);
      prev = p;
    }
  }
}

// ---------- Vector glyphs ----------
// Em box: 100 units, baseline y=76, cap top y=8, x-height top y=34, descender to y=96.
// Each glyph: [advance, stroke1, stroke2, ...]; each stroke is a polyline of [x, y].
// 'm' has flat crowns with the middle stem at crown height; 'f' has a candy-cane
// hook (up, over the top, down the left side) plus a long crossbar; 'y' has a
// curled descender sweeping left and back up. Every stroke stays inside its advance.
const G = {};
function def(ch, adv, ...strokes) { G[ch] = [adv, strokes]; }

// lowercase
def("a", 58, [[48,76],[48,36],[40,28],[26,28],[15,38],[13,54],[19,70],[32,76],[46,72],[48,62]]);
def("b", 56, [[14,76],[14,6]], [[14,44],[28,40],[42,46],[46,58],[40,70],[26,76],[14,72]]);
def("c", 54, [[46,36],[34,28],[20,32],[13,48],[15,64],[26,74],[40,74],[48,66]]);
def("d", 58, [[14,44],[28,40],[42,46],[46,58],[40,70],[26,76],[14,72]], [[46,76],[46,6]]);
def("e", 56, [[46,54],[42,34],[32,27],[19,32],[13,48],[16,64],[27,74],[41,73],[49,64]], [[14,54],[48,54]]);
def("f", 50, [[40,96],[40,16],[33,6],[21,4],[13,12],[13,26]], [[6,40],[48,40]]);
def("g", 58, [[48,32],[34,26],[20,32],[13,48],[16,64],[28,74],[42,72],[48,60]], [[48,60],[48,86],[42,96],[28,96],[20,88]]);
def("h", 56, [[12,76],[12,6]], [[12,48],[28,44],[40,52],[42,64],[42,76]]);
def("i", 28, [[15,76],[15,36]], [[15,16],[15,20]]);
def("j", 30, [[17,36],[17,84],[13,94],[6,94]], [[17,16],[17,20]]);
def("k", 54, [[12,76],[12,6]], [[12,54],[38,32]], [[26,48],[42,76]]);
def("l", 28, [[15,76],[15,8]]);
def("m", 86, [[8,76],[8,34],[26,34],[44,34],[44,76]], [[44,76],[44,34],[62,34],[80,34],[80,76]]);
def("n", 56, [[10,76],[10,34],[28,34],[46,34],[46,76]]);
def("o", 58, [[30,28],[16,36],[12,54],[17,68],[30,76],[44,74],[52,60],[50,40],[42,30],[30,28]]);
def("p", 56, [[14,32],[14,96]], [[14,44],[28,40],[42,46],[46,58],[40,70],[26,76],[14,72]]);
def("q", 58, [[14,44],[28,40],[42,46],[46,58],[40,70],[26,76],[14,72]], [[46,68],[46,96]]);
def("r", 42, [[12,76],[12,32]], [[12,32],[28,32],[38,40],[38,50]]);
def("s", 54, [[46,36],[34,28],[20,32],[14,44],[20,56],[36,58],[46,66],[42,74],[30,77],[16,72]]);
def("t", 42, [[26,76],[26,12]], [[12,42],[40,42]]);
def("u", 56, [[10,32],[10,62],[18,74],[32,76],[44,70],[48,58],[48,32]]);
def("v", 54, [[6,32],[26,76],[46,32]]);
def("w", 66, [[6,32],[20,76],[34,48],[48,76],[62,32]]);
def("x", 54, [[8,32],[48,76]], [[48,32],[8,76]]);
def("y", 54, [[6,32],[26,62],[46,32]], [[26,62],[26,90],[18,96],[10,92],[8,84]]);
def("z", 54, [[8,32],[48,32],[8,76],[48,76]]);
// digits
def("0", 62, [[32,8],[16,16],[10,36],[12,58],[24,74],[42,76],[56,60],[58,34],[48,16],[32,8]]);
def("1", 36, [[16,18],[28,8],[28,76],[14,76]]);
def("2", 58, [[12,24],[20,10],[38,10],[50,20],[50,34],[14,76],[50,76]]);
def("3", 58, [[14,14],[34,8],[48,16],[48,30],[38,42],[46,50],[48,60],[38,74],[18,76]]);
def("4", 60, [[40,8],[14,52],[50,52]], [[40,8],[40,76]]);
def("5", 58, [[48,10],[14,10],[14,42],[32,42],[48,50],[48,62],[36,76],[18,76]]);
def("6", 60, [[46,16],[32,8],[18,18],[12,36],[14,58],[26,74],[42,74],[52,60],[50,44],[38,40]]);
def("7", 56, [[10,10],[50,10],[30,76]]);
def("8", 60, [[31,8],[18,14],[14,28],[20,42],[31,44],[44,42],[50,28],[44,14],[31,8]], [[26,44],[14,52],[12,64],[22,76],[36,76],[50,64],[48,52],[38,44]]);
def("9", 60, [[16,64],[28,72],[44,62],[50,44],[48,22],[38,10],[22,10],[12,22],[14,38],[26,44]]);
// punctuation
def(".", 28, [[12,68],[12,76],[19,76],[19,68]]);
def(",", 30, [[12,68],[12,76],[19,76],[19,68]], [[17,76],[12,90]]);
def(";", 30, [[12,34],[12,42],[19,42],[19,34]], [[12,68],[12,76],[19,76],[19,68]], [[17,76],[12,90]]);
def(":", 28, [[12,34],[12,42],[19,42],[19,34]], [[12,64],[12,72],[19,72],[19,64]]);
def("'", 24, [[14,8],[10,26]]);
def('"', 38, [[12,8],[8,26]], [[28,8],[24,26]]);
def("(", 32, [[26,8],[14,22],[12,44],[14,64],[26,76]]);
def(")", 32, [[8,8],[20,22],[22,44],[20,64],[8,76]]);
def("-", 42, [[8,48],[36,48]]);
def("—", 66, [[6,48],[62,48]]);
def("·", 28, [[12,36],[12,44],[19,44],[19,36]]);
def("$", 58, [[44,20],[32,10],[18,14],[12,28],[18,40],[32,44],[44,50],[46,62],[36,74],[20,74]], [[28,6],[28,78]]);
def(" ", 28);

// capitals
def("A", 66, [[6,76],[34,8],[62,76]], [[18,50],[50,50]]);
def("B", 60, [[12,76],[12,8]], [[12,8],[38,8],[50,18],[50,34],[38,42],[12,42]], [[12,42],[40,42],[52,52],[52,66],[40,76],[12,76]]);
def("C", 60, [[52,22],[40,10],[22,12],[12,28],[12,54],[22,72],[40,76],[52,64]]);
def("D", 64, [[12,76],[12,8]], [[12,8],[38,8],[56,22],[56,58],[38,76],[12,76]]);
def("E", 56, [[12,76],[12,8]], [[12,8],[48,8]], [[12,42],[40,42]], [[12,76],[48,76]]);
def("F", 54, [[12,76],[12,8]], [[12,8],[48,8]], [[12,42],[38,42]]);
def("G", 64, [[54,26],[42,12],[24,12],[12,28],[12,54],[22,72],[40,76],[54,64],[54,44],[36,44]]);
def("H", 64, [[12,76],[12,8]], [[54,76],[54,8]], [[12,42],[54,42]]);
def("I", 32, [[8,8],[26,8]], [[17,8],[17,76]], [[8,76],[26,76]]);
def("J", 54, [[46,8],[46,64],[38,76],[20,76],[12,66]]);
def("K", 62, [[12,76],[12,8]], [[12,44],[52,8]], [[28,38],[52,76]]);
def("L", 54, [[12,76],[12,8]], [[12,76],[50,76]]);
def("M", 76, [[8,76],[8,8],[39,44],[70,8],[70,76]]);
def("N", 68, [[10,76],[10,8],[60,76],[60,8]]);
def("O", 68, [[35,8],[16,16],[10,36],[12,58],[24,74],[44,76],[58,60],[60,34],[50,16],[35,8]]);
def("P", 58, [[12,76],[12,8]], [[12,8],[38,8],[52,18],[52,34],[40,44],[12,44]]);
def("Q", 68, [[35,8],[16,16],[10,36],[12,58],[24,74],[44,76],[58,60],[60,34],[50,16],[35,8]], [[46,58],[60,76]]);
def("R", 60, [[12,76],[12,8]], [[12,8],[38,8],[52,18],[52,34],[40,44],[12,44]], [[30,42],[54,76]]);
def("S", 58, [[50,20],[38,10],[22,12],[14,24],[18,38],[32,46],[48,50],[52,62],[44,72],[28,77],[14,70]]);
def("T", 60, [[8,8],[54,8]], [[31,8],[31,76]]);
def("U", 64, [[10,8],[10,58],[20,74],[42,76],[54,62],[54,8]]);
def("V", 64, [[6,8],[33,76],[60,8]]);
def("W", 90, [[6,8],[18,76],[32,42],[46,76],[60,42],[74,76],[86,8]]);
def("X", 62, [[8,8],[56,76]], [[56,8],[8,76]]);
def("Y", 62, [[6,8],[32,40],[58,8]], [[32,40],[32,76]]);
def("Z", 60, [[8,8],[54,8],[8,76],[54,76]]);

// ---------- Text engine ----------
function measure(s, size) {
  let w = 0;
  for (const ch of s) {
    const gl = G[ch];
    if (!gl) throw new Error("missing glyph: " + JSON.stringify(ch));
    w += (gl[0] * size) / 100;
  }
  return w;
}
function paint(cv, x, baselineY, s, size, color, weight = 0.115) {
  const sc = size / 100;
  const w = Math.max(1, size * weight);
  let cx = x;
  for (const ch of s) {
    const gl = G[ch];
    if (!gl) throw new Error("missing glyph: " + JSON.stringify(ch));
    for (const stroke of gl[1]) {
      const pts = stroke.map(([px, py]) => [cx + px * sc, baselineY + (py - 76) * sc]);
      cv.poly(pts, w, color);
    }
    cx += (gl[0] * size) / 100;
  }
  return cx;
}
function wrap(s, size, maxW) {
  const words = s.split(" ");
  const lines = [];
  let cur = "";
  for (const wd of words) {
    const trial = cur ? cur + " " + wd : wd;
    if (measure(trial, size) <= maxW) { cur = trial; continue; }
    if (cur) lines.push(cur);
    cur = wd;
  }
  if (cur) lines.push(cur);
  return lines;
}
function para(cv, x, y, s, size, leading, maxW, color) {
  const lines = wrap(s, size, maxW);
  lines.forEach((ln, i) => paint(cv, x, y + i * leading, ln, size, color));
  return lines.length;
}
function center(cv, y, s, size, color, weight = 0.115) {
  const w = measure(s, size);
  paint(cv, (W - w) / 2, y, s, size, color, weight);
}
function centerAt(cv, cx, y, s, size, color, weight = 0.115) {
  const w = measure(s, size);
  paint(cv, cx - w / 2, y, s, size, color, weight);
}
function tag(cv, x, y, s, size = 14) {
  cv.box(x, y - size + 3, size - 3, size - 3, RED);
  paint(cv, x + size + 5, y, s, size, RED, 0.13);
}

// ---------- Layout ----------
function render() {
  const cv = new Sheet();
  const MX = 34, RX = 990;

  // top rules + masthead
  cv.hline(MX, RX, 24, 4, INK);
  cv.hline(MX, RX, 31, 1.5, INK);
  center(cv, 78, "THE WORLD IN ONE DAY", 46, RED, 0.13);
  // headline
  paint(cv, MX, 148, "Sixth tanker hit in Hormuz", 58, INK, 0.12);
  paint(cv, MX, 214, "Trump: 'bottom of the sea'", 58, INK, 0.12);
  // dateline
  const dateTxt = "MONDAY, 23 NOVEMBER 2026";
  const dw = measure(dateTxt, 21);
  cv.hline(MX, 512 - dw / 2 - 18, 246, 2, RED);
  cv.hline(512 + dw / 2 + 18, RX, 246, 2, RED);
  paint(cv, 512 - dw / 2, 254, dateTxt, 21, INK, 0.12);
  // deck
  paint(cv, MX, 288, "Iran claims a sixth tanker hit since Sunday; UKMTO confirms a vessel", 19, GREY);
  paint(cv, MX, 314, "struck at dawn on Monday. Oil holds above $92 a barrel.", 19, GREY);
  cv.hline(MX, RX, 330, 2, INK);

  // ---- lead block ----
  // visual panel: Gulf schematic — sea, tanker, flame, banner
  const PX = 34, PY = 346, PW = 420, PH = 266;
  cv.box(PX, PY, PW, PH, NAVY);
  cv.box(PX, PY + 96, PW, PH - 96, STEEL); // sea
  // tanker hull + bridge
  cv.box(PX + 96, PY + 128, 228, 26, LIGHT);
  cv.box(PX + 96, PY + 128, 228, 8, [247, 241, 222]);
  cv.box(PX + 268, PY + 104, 56, 24, LIGHT);
  cv.box(PX + 284, PY + 88, 24, 16, LIGHT);
  // flame above the tanker
  cv.dot(PX + 150, PY + 92, 10, ORANGE);
  cv.dot(PX + 150, PY + 82, 6, RED);
  cv.dot(PX + 150, PY + 72, 3, [255, 220, 120]);
  cv.box(PX, PY + 168, PW, 44, RED); // banner
  centerAt(cv, PX + PW / 2, PY + 200, "6TH TANKER HIT", 32, [247, 241, 222], 0.13);
  centerAt(cv, PX + PW / 2, PY + 240, "OIL ABOVE $92", 15, [247, 241, 222], 0.12);
  centerAt(cv, PX + PW / 2, PY + 262, "7 HIT SINCE 16 NOV", 15, [247, 241, 222], 0.12);
  // right column
  tag(cv, 486, 368, "THE GULF · WAR AT SEA", 15);
  paint(cv, 486, 408, "War at sea widens on Monday", 28, INK, 0.12);
  para(cv, 486, 442,
    "Iran said a sixth tanker had been hit in the Strait of Hormuz since Sunday. UKMTO confirmed a vessel was struck at about 6 a.m. on Monday, with all crew safe. Seven tankers have been hit since 16 November, monitors say, and oil held above $92 a barrel. President Trump warned on Sunday that ships testing the US blockade would end up 'at the bottom of the sea'.",
    16, 21, 504, INK);

  cv.hline(MX, RX, 628, 2, INK);

  // ---- 2x2 grid ----
  cv.vline(512, 644, 880, 1.5, INK);
  cv.hline(MX, RX, 758, 1.5, INK);
  function cell(x, top, kick, head, body) {
    tag(cv, x, top + 22, kick, 13);
    paint(cv, x, top + 54, head, 21, INK, 0.12);
    para(cv, x, top + 76, body, 14.5, 19, 460, INK);
  }
  cell(34, 628, "UKRAINE · DYMER", "Dymer toll rises to 11",
    "A Russian drone hit a five-storey block in Dymer on Sunday. The toll rose to 11 on Monday; a boy, 7, was pulled alive after 14 hours under the rubble.");
  cell(528, 628, "SUDAN · KHARTOUM", "UN staff hurt in Khartoum strikes",
    "Three UN staff were hurt when drones hit a UN site in Khartoum. The UN and US condemned the attacks on Monday; the strikes before dawn on Sunday were blamed on the RSF.");
  cell(34, 758, "THE GULF · TEHRAN", "Iran claims 78 US drones downed",
    "The IRGC said on Monday its air defences had destroyed 58 MQ-9 Reapers and 20 MQ-1 Predators. The claim, in an infographic, has not been verified.");
  cell(528, 758, "ASIA · NEW DELHI", "Nepal PM meets Modi in Delhi",
    "Balendra Shah was given a ceremonial welcome on Monday and held 100-minute talks with Narendra Modi. A new Ayodhya-Janakpur train was announced.");

  cv.hline(MX, RX, 890, 2, INK);

  // ---- also today ----
  tag(cv, MX, 916, "ALSO TODAY — 23 NOVEMBER 2026", 15);
  const also = [
    "Australia: music legend Molly Meldrum dies at 83 after a long illness.",
    "Hormuz: search goes on for a Jordanian sailor missing after a tanker attack.",
    "Asia: India keeps third place in the Lowy Institute Asia Power Index.",
  ];
  also.forEach((s, i) => {
    const y = 940 + i * 21;
    cv.dot(42, y - 5, 3.5, RED);
    paint(cv, 56, y, s, 15, INK);
  });

  // ---- footer ----
  cv.hline(MX, RX, 996, 1.5, INK);
  center(cv, 1014, "23 November 2026 · Sources: Reuters, BBC, AP, AFP, IANS · A one-day summary, drawn from the day's reporting", 12, GREY);
  return cv;
}

const outDir = process.env.MAKEFUN_OUTPUT_DIR || "out";
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, "entry.png");
const cv = render();
savePng(cv.px, W, H, outFile);
console.log("wrote", outFile, fs.statSync(outFile).size, "bytes");
