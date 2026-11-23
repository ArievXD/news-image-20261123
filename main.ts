// news-image-20261123 — a one-day newspaper infographic for Monday 23 November 2026.
// Draws the whole page with vector strokes into an RGB buffer and encodes a PNG.
// Node's standard library only; nothing is read from disk, the clock, or the network,
// so every run produces the same bytes. Run: MAKEFUN_OUTPUT_DIR=out node main.ts
import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";

// ---------------------------------------------------------------- PNG encoding
// CRC-32 (IEEE) table, built once at startup.
function buildCrcTable() {
  const table = new Array(256);
  for (let n = 0; n < 256; n += 1) {
    let value = n;
    for (let bit = 0; bit < 8; bit += 1) {
      const lowBit = value & 1;
      value >>>= 1;
      if (lowBit) value ^= 0xedb88320;
    }
    table[n] = value >>> 0;
  }
  return table;
}
const CRC_TABLE = buildCrcTable();

function crcOf(bytes) {
  let acc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    acc = CRC_TABLE[(acc ^ bytes[i]) & 0xff] ^ (acc >>> 8);
  }
  return (acc ^ 0xffffffff) >>> 0;
}

function makeChunk(kind, payload) {
  const size = payload.length;
  const out = Buffer.alloc(size + 12);
  out.writeUInt32BE(size, 0);
  out.write(kind, 4, "ascii");
  payload.copy(out, 8);
  out.writeUInt32BE(crcOf(out.subarray(4, size + 8)), size + 8);
  return out;
}

// Assemble a true-colour PNG (8-bit RGB, no filtering) from a raw RGB buffer.
function encodePng(width, height, rgb) {
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let row = 0; row < height; row += 1) {
    raw[row * stride] = 0;
    rgb.copy(raw, row * stride + 1, row * width * 3, (row + 1) * width * 3);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    makeChunk("IHDR", ihdr),
    makeChunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    makeChunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------- raster sheet
class Sheet {
  constructor(width, height, background) {
    this.w = width;
    this.h = height;
    this.pixels = Buffer.alloc(width * height * 3);
    for (let i = 0; i < width * height; i += 1) {
      this.pixels[i * 3] = background[0];
      this.pixels[i * 3 + 1] = background[1];
      this.pixels[i * 3 + 2] = background[2];
    }
  }

  put(x, y, rgb) {
    const xi = Math.round(x);
    const yi = Math.round(y);
    if (xi < 0 || yi < 0 || xi >= this.w || yi >= this.h) return;
    const i = (yi * this.w + xi) * 3;
    this.pixels[i] = rgb[0];
    this.pixels[i + 1] = rgb[1];
    this.pixels[i + 2] = rgb[2];
  }

  fillRect(x, y, w, h, rgb) {
    const x0 = Math.max(0, Math.round(x));
    const y0 = Math.max(0, Math.round(y));
    const x1 = Math.min(this.w, Math.round(x + w));
    const y1 = Math.min(this.h, Math.round(y + h));
    for (let yy = y0; yy < y1; yy += 1) {
      for (let xx = x0; xx < x1; xx += 1) {
        const i = (yy * this.w + xx) * 3;
        this.pixels[i] = rgb[0];
        this.pixels[i + 1] = rgb[1];
        this.pixels[i + 2] = rgb[2];
      }
    }
  }

  // Filled disc, used as the stamp for thick strokes.
  dot(cx, cy, radius, rgb) {
    const x0 = Math.floor(cx - radius);
    const x1 = Math.ceil(cx + radius);
    const y0 = Math.floor(cy - radius);
    const y1 = Math.ceil(cy + radius);
    for (let y = y0; y <= y1; y += 1) {
      for (let x = x0; x <= x1; x += 1) {
        const dx = x + 0.5 - cx;
        const dy = y + 0.5 - cy;
        if (dx * dx + dy * dy <= radius * radius) this.put(x, y, rgb);
      }
    }
  }

  // Thick segment: stamp discs every ~1.5 px along the line.
  segment(x0, y0, x1, y1, width, rgb) {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const len = Math.sqrt(dx * dx + dy * dy);
    const count = Math.max(2, Math.round(len / 1.5));
    for (let i = 0; i <= count; i += 1) {
      const t = i / count;
      this.dot(x0 + dx * t, y0 + dy * t, width / 2, rgb);
    }
  }

  // Open polyline through a list of [x, y] points.
  polyline(points, width, rgb) {
    for (let i = 0; i + 1 < points.length; i += 1) {
      this.segment(points[i][0], points[i][1], points[i + 1][0], points[i + 1][1], width, rgb);
    }
  }

  ring(cx, cy, radius, width, rgb) {
    const steps = Math.max(28, Math.floor(radius * 2.5));
    let prev = null;
    for (let i = 0; i <= steps; i += 1) {
      const a = (i / steps) * Math.PI * 2;
      const p = [cx + Math.cos(a) * radius, cy + Math.sin(a) * radius];
      if (prev) this.segment(prev[0], prev[1], p[0], p[1], width, rgb);
      prev = p;
    }
  }
}

// ---------------------------------------------------------------- typeface
// Vector face on a 120-unit em: cap top y=12, x-height top y=44, baseline y=96,
// descender floor y=118. Each letter is { adv, paths } where a path is a list of
// [x, y] points drawn as one open polyline. Design notes baked in from the start:
// 'm' has flat crowns with the middle stem reaching crown height; 'f' has a
// candy-cane hook (up, over the top, down the left side) plus a long crossbar;
// 'y' has a descender that curls left and back up; 't' is a plain straight stem
// with a flat top and no hook at all; every stroke stays inside its advance and
// left bearings stay small so counters never fill in.
const FACE = {};
function define(ch, adv, ...paths) {
  FACE[ch] = { adv, paths };
}
function needGlyph(ch) {
  const g = FACE[ch];
  if (!g) throw new Error("no glyph for " + JSON.stringify(ch));
  return g;
}

// ---------------------------------------------------------------- text engine
function measure(text, size) {
  let total = 0;
  for (const ch of text) total += (needGlyph(ch).adv * size) / 120;
  return total;
}

// Paint a string left-aligned at (x, baselineY). Returns the x where it ends.
function paint(sheet, x, baselineY, text, size, rgb, weight = 0.115) {
  const scale = size / 120;
  const width = Math.max(1, size * weight);
  let cursor = x;
  for (const ch of text) {
    const g = needGlyph(ch);
    for (const path of g.paths) {
      const pts = path.map(([px, py]) => [cursor + px * scale, baselineY + (py - 96) * scale]);
      sheet.polyline(pts, width, rgb);
    }
    cursor += (g.adv * size) / 120;
  }
  return cursor;
}

function flow(text, size, maxWidth) {
  const words = text.split(" ");
  const lines = [];
  let current = "";
  for (const word of words) {
    const trial = current ? current + " " + word : word;
    if (measure(trial, size) <= maxWidth) {
      current = trial;
      continue;
    }
    if (current) lines.push(current);
    current = word;
  }
  if (current) lines.push(current);
  return lines;
}

function paintBlock(sheet, x, y, text, size, leading, maxWidth, rgb) {
  const lines = flow(text, size, maxWidth);
  lines.forEach((line, i) => paint(sheet, x, y + i * leading, line, size, rgb));
  return lines.length;
}

function paintCentered(sheet, y, text, size, rgb, weight = 0.115) {
  paint(sheet, (1024 - measure(text, size)) / 2, y, text, size, rgb, weight);
}

function paintCenteredIn(sheet, cx, y, text, size, rgb, weight = 0.115) {
  paint(sheet, cx - measure(text, size) / 2, y, text, size, rgb, weight);
}

function paintKicker(sheet, x, y, text, size = 14) {
  sheet.fillRect(x, y - size + 3, size - 3, size - 3, RED);
  paint(sheet, x + size + 5, y, text, size, RED, 0.13);
}

// ---------------------------------------------------------------- glyph table
// lowercase
define("a", 58, [[48, 96], [48, 54], [40, 46], [26, 44], [14, 50], [10, 66], [14, 86], [26, 96], [40, 96], [48, 88]]);
define("b", 56, [[14, 96], [14, 12]], [[14, 56], [28, 48], [42, 54], [46, 68], [40, 88], [26, 94], [14, 88]]);
define("c", 54, [[46, 52], [34, 44], [20, 48], [12, 62], [14, 82], [26, 94], [40, 94], [48, 86]]);
define("d", 58, [[14, 56], [28, 48], [42, 54], [46, 68], [40, 88], [26, 94], [14, 88]], [[46, 96], [46, 12]]);
define("e", 56, [[46, 66], [42, 48], [30, 44], [16, 50], [12, 66], [16, 86], [28, 96], [42, 94], [48, 84]], [[12, 66], [48, 66]]);
define("f", 52, [[40, 96], [40, 18], [30, 8], [18, 8], [12, 18], [12, 34]], [[6, 58], [50, 58]]);
define("g", 58, [[48, 52], [34, 44], [20, 48], [12, 62], [14, 82], [26, 94], [40, 94], [48, 84]], [[48, 84], [48, 108], [42, 118], [28, 118], [20, 110]]);
define("h", 56, [[12, 96], [12, 12]], [[12, 58], [28, 52], [42, 58], [44, 70], [44, 96]]);
define("i", 28, [[14, 96], [14, 52]], [[14, 22], [19, 30], [14, 38], [9, 30], [14, 22]]);
define("j", 30, [[16, 52], [16, 104], [12, 114], [4, 114]], [[16, 28], [16, 32]]);
define("k", 54, [[12, 96], [12, 12]], [[12, 64], [40, 44]], [[26, 58], [44, 96]]);
define("l", 28, [[14, 96], [14, 12]]);
define("m", 88, [[8, 96], [8, 44], [26, 44], [44, 44], [44, 96]], [[44, 96], [44, 44], [62, 44], [80, 44], [80, 96]]);
define("n", 56, [[10, 96], [10, 44], [28, 44], [46, 44], [46, 96]]);
define("o", 56, [[28, 44], [14, 52], [10, 68], [14, 86], [28, 96], [42, 94], [50, 80], [48, 60], [40, 46], [28, 44]]);
define("p", 56, [[14, 44], [14, 118]], [[14, 56], [28, 48], [42, 54], [46, 68], [40, 88], [26, 94], [14, 88]]);
define("q", 58, [[14, 56], [28, 48], [42, 54], [46, 68], [40, 88], [26, 94], [14, 88]], [[46, 88], [46, 118]]);
define("r", 42, [[12, 96], [12, 44]], [[12, 44], [28, 44], [38, 52], [38, 62]]);
define("s", 54, [[46, 52], [34, 44], [20, 48], [14, 60], [20, 72], [36, 74], [46, 82], [42, 92], [28, 97], [14, 92]]);
define("t", 42, [[26, 96], [26, 16]], [[10, 44], [42, 44]]);
define("u", 56, [[10, 44], [10, 80], [18, 94], [32, 96], [44, 90], [48, 76], [48, 44]]);
define("v", 54, [[6, 44], [26, 96], [46, 44]]);
define("w", 66, [[6, 44], [20, 96], [34, 62], [48, 96], [62, 44]]);
define("x", 54, [[8, 44], [48, 96]], [[48, 44], [8, 96]]);
define("y", 54, [[6, 44], [26, 84], [46, 44]], [[26, 84], [26, 110], [18, 118], [8, 112], [6, 102]]);
define("z", 54, [[8, 44], [48, 44], [8, 96], [48, 96]]);
// digits
define("0", 62, [[30, 12], [14, 20], [8, 44], [10, 72], [22, 94], [40, 96], [54, 80], [56, 44], [46, 20], [30, 12]]);
define("1", 36, [[16, 22], [28, 12], [28, 96], [14, 96]]);
define("2", 58, [[12, 30], [20, 14], [38, 12], [50, 24], [50, 40], [14, 96], [50, 96]]);
define("3", 58, [[14, 18], [34, 10], [48, 20], [48, 36], [38, 50], [46, 58], [48, 72], [38, 94], [18, 96]]);
define("4", 60, [[40, 12], [14, 66], [50, 66]], [[40, 12], [40, 96]]);
define("5", 58, [[48, 12], [14, 12], [14, 52], [32, 52], [48, 60], [48, 78], [36, 94], [18, 94]]);
define("6", 60, [[46, 20], [32, 12], [18, 22], [12, 44], [14, 72], [26, 94], [42, 94], [52, 78], [50, 56], [38, 50]]);
define("7", 56, [[10, 12], [50, 12], [30, 96]]);
define("8", 60, [[30, 12], [17, 18], [12, 34], [18, 52], [30, 54], [42, 52], [48, 34], [42, 18], [30, 12]], [[25, 54], [13, 62], [11, 78], [21, 94], [35, 94], [49, 80], [47, 62], [37, 54]]);
define("9", 60, [[16, 80], [28, 90], [44, 78], [50, 56], [48, 30], [38, 14], [22, 14], [12, 28], [14, 46], [26, 52]]);
// punctuation and symbols
define(".", 28, [[12, 88], [12, 96], [19, 96], [19, 88]]);
define(",", 30, [[12, 88], [12, 96], [19, 96], [19, 88]], [[17, 96], [12, 112]]);
define(";", 30, [[12, 42], [12, 50], [19, 50], [19, 42]], [[12, 88], [12, 96], [19, 96], [19, 88]], [[17, 96], [12, 112]]);
define(":", 28, [[12, 42], [12, 50], [19, 50], [19, 42]], [[12, 82], [12, 90], [19, 90], [19, 82]]);
define("’", 24, [[14, 12], [10, 32]]);
define("‘", 24, [[10, 12], [14, 32]]);
define("'", 24, [[14, 12], [10, 32]]);
define("-", 42, [[8, 58], [36, 58]]);
define("–", 50, [[6, 58], [44, 58]]);
define("—", 66, [[6, 58], [62, 58]]);
define("·", 28, [[12, 44], [12, 52], [19, 52], [19, 44]]);
define("$", 62, [[48, 24], [34, 12], [18, 16], [12, 30], [16, 46], [30, 54], [46, 58], [52, 72], [46, 88], [30, 96], [14, 88]], [[31, 4], [31, 104]]);
define(" ", 28);
// capitals
define("A", 66, [[6, 96], [34, 12], [62, 96]], [[18, 64], [50, 64]]);
define("B", 60, [[12, 96], [12, 12]], [[12, 12], [38, 12], [50, 24], [50, 42], [38, 52], [12, 52]], [[12, 52], [40, 52], [52, 62], [52, 80], [40, 96], [12, 96]]);
define("C", 60, [[52, 28], [40, 14], [22, 16], [12, 34], [12, 68], [22, 90], [40, 94], [52, 80]]);
define("D", 64, [[12, 96], [12, 12]], [[12, 12], [38, 12], [56, 28], [56, 72], [38, 96], [12, 96]]);
define("E", 56, [[12, 96], [12, 12]], [[12, 12], [48, 12]], [[12, 54], [40, 54]], [[12, 96], [48, 96]]);
define("F", 54, [[12, 96], [12, 12]], [[12, 12], [48, 12]], [[12, 54], [38, 54]]);
define("G", 64, [[54, 32], [42, 16], [24, 16], [12, 34], [12, 68], [22, 90], [40, 94], [54, 80], [54, 58], [36, 58]]);
define("H", 64, [[12, 96], [12, 12]], [[54, 96], [54, 12]], [[12, 56], [54, 56]]);
define("I", 34, [[8, 12], [26, 12]], [[17, 12], [17, 96]], [[8, 96], [26, 96]]);
define("J", 54, [[46, 12], [46, 80], [38, 94], [20, 94], [12, 84]]);
define("K", 62, [[12, 96], [12, 12]], [[12, 58], [52, 12]], [[28, 48], [52, 96]]);
define("L", 54, [[12, 96], [12, 12]], [[12, 96], [50, 96]]);
define("M", 76, [[8, 96], [8, 12], [38, 58], [68, 12], [68, 96]]);
define("N", 68, [[10, 96], [10, 12], [60, 96], [60, 12]]);
define("O", 68, [[34, 12], [15, 20], [9, 42], [11, 70], [23, 92], [43, 94], [57, 78], [59, 42], [49, 20], [34, 12]]);
define("P", 58, [[12, 96], [12, 12]], [[12, 12], [38, 12], [52, 24], [52, 42], [40, 56], [12, 56]]);
define("Q", 68, [[34, 12], [15, 20], [9, 42], [11, 70], [23, 92], [43, 94], [57, 78], [59, 42], [49, 20], [34, 12]], [[46, 72], [60, 96]]);
define("R", 60, [[12, 96], [12, 12]], [[12, 12], [38, 12], [52, 24], [52, 42], [40, 56], [12, 56]], [[30, 54], [54, 96]]);
define("S", 58, [[50, 24], [38, 12], [22, 14], [14, 28], [18, 44], [32, 52], [48, 58], [52, 74], [44, 88], [28, 94], [14, 86]]);
define("T", 60, [[8, 12], [54, 12]], [[31, 12], [31, 96]]);
define("U", 64, [[10, 12], [10, 74], [20, 92], [42, 94], [54, 78], [54, 12]]);
define("V", 64, [[6, 12], [32, 96], [58, 12]]);
define("W", 90, [[6, 12], [18, 96], [32, 56], [46, 96], [60, 56], [74, 96], [86, 12]]);
define("X", 62, [[8, 12], [56, 96]], [[56, 12], [8, 96]]);
define("Y", 62, [[6, 12], [32, 52], [58, 12]], [[32, 52], [32, 96]]);
define("Z", 60, [[8, 12], [54, 12], [8, 96], [54, 96]]);

// ---------------------------------------------------------------- palette
const PAPER = [247, 241, 222];
const INK = [25, 25, 25];
const RED = [161, 31, 31];
const NAVY = [34, 64, 94];
const SEA = [77, 124, 176];
const PALE = [214, 228, 240];
const GREY = [107, 107, 96];
const FLAME = [214, 110, 40];
const EMBER = [190, 50, 30];

// ---------------------------------------------------------------- page layout
const PAGE_W = 1024;
const PAGE_H = 1024;
const MARGIN_L = 36;
const MARGIN_R = 988;

function compose() {
  const sheet = new Sheet(PAGE_W, PAGE_H, PAPER);

  // Top double rule and masthead.
  sheet.fillRect(MARGIN_L, 24, MARGIN_R - MARGIN_L, 4, INK);
  sheet.fillRect(MARGIN_L, 32, MARGIN_R - MARGIN_L, 2, INK);
  paintCentered(sheet, 80, "THE WORLD IN ONE DAY", 46, RED, 0.13);

  // Two-line headline.
  paint(sheet, MARGIN_L, 152, "Sixth tanker hit in Hormuz", 60, INK, 0.12);
  paint(sheet, MARGIN_L, 220, "Trump: ‘bottom of the sea’", 60, INK, 0.12);

  // Dateline with red rules on both sides.
  const dateText = "MONDAY, 23 NOVEMBER 2026";
  const dateW = measure(dateText, 21);
  sheet.fillRect(MARGIN_L, 249, 512 - dateW / 2 - 18 - MARGIN_L, 2, RED);
  sheet.fillRect(512 + dateW / 2 + 18, 249, MARGIN_R - (512 + dateW / 2 + 18), 2, RED);
  paint(sheet, 512 - dateW / 2, 258, dateText, 21, INK, 0.12);

  // Deck, wrapped to the full width.
  paintBlock(
    sheet, MARGIN_L, 292,
    "Iran claims a sixth tanker hit since Sunday; UKMTO confirms a vessel struck at dawn on Monday. Oil holds above $92 a barrel.",
    19, 26, MARGIN_R - MARGIN_L, GREY
  );
  sheet.fillRect(MARGIN_L, 333, MARGIN_R - MARGIN_L, 2, INK);

  // ---- lead block: schematic panel on the left, text on the right ----
  const px = 36;
  const py = 350;
  const pw = 416;
  const ph = 262;
  sheet.fillRect(px, py, pw, ph, NAVY);
  sheet.fillRect(px, py + 98, pw, ph - 98, SEA);
  // Small flame on the water, left side.
  sheet.dot(px + 146, py + 88, 9, FLAME);
  sheet.polyline([[px + 146, py + 62], [px + 136, py + 90], [px + 156, py + 90]], 7, EMBER);
  // White tanker silhouette, right side.
  sheet.fillRect(px + 262, py + 122, 122, 16, PALE);
  sheet.fillRect(px + 296, py + 98, 38, 24, PALE);
  sheet.fillRect(px + 350, py + 104, 12, 18, PALE);
  // Red banner with the panel headline.
  sheet.fillRect(px, py + 156, pw, 46, RED);
  paintCenteredIn(sheet, px + pw / 2, py + 190, "6TH TANKER HIT", 30, PAPER, 0.13);
  paintCenteredIn(sheet, px + pw / 2, py + 234, "OIL ABOVE $92", 14, PAPER, 0.12);
  paintCenteredIn(sheet, px + pw / 2, py + 256, "7 HIT SINCE 16 NOV", 14, PAPER, 0.12);

  // Right column: kicker, subhead, body.
  paintKicker(sheet, 484, 372, "THE GULF · WAR AT SEA", 15);
  paint(sheet, 484, 414, "War at sea widens on Monday", 30, INK, 0.12);
  paintBlock(
    sheet, 484, 446,
    "Iran said a sixth tanker had been hit in the Strait of Hormuz since Sunday. UKMTO confirmed a vessel was struck at about 6 a.m. on Monday, with all crew safe. Seven tankers have been hit since 16 November, monitors say, and oil held above $92 a barrel. President Trump warned on Sunday that ships testing the US blockade would end up ‘at the bottom of the sea’.",
    16, 21, 504, INK
  );

  sheet.fillRect(MARGIN_L, 627, MARGIN_R - MARGIN_L, 2, INK);

  // ---- 2x2 grid of supporting stories ----
  sheet.fillRect(511, 644, 2, 236, INK);
  sheet.fillRect(MARGIN_L, 757, MARGIN_R - MARGIN_L, 2, INK);
  function cell(x, top, kick, head, body) {
    paintKicker(sheet, x, top + 22, kick, 13);
    paint(sheet, x, top + 54, head, 21, INK, 0.12);
    paintBlock(sheet, x, top + 76, body, 14.5, 19, 460, INK);
  }
  cell(
    36, 628, "UKRAINE · DYMER", "Dymer toll rises to 11",
    "A Russian drone hit a five-storey block in Dymer on Sunday. The toll rose to 11 on Monday; a boy, 7, was pulled alive after 14 hours under the rubble."
  );
  cell(
    528, 628, "SUDAN · KHARTOUM", "UN staff hurt in Khartoum strikes",
    "Three UN staff were hurt when drones hit a UN site in Khartoum. The UN and US condemned the attacks on Monday; the strikes before dawn on Sunday were blamed on the RSF."
  );
  cell(
    36, 758, "THE GULF · TEHRAN", "Iran claims 78 US drones downed",
    "The IRGC said on Monday its air defences had destroyed 58 MQ-9 Reapers and 20 MQ-1 Predators. The claim, in an infographic, has not been verified."
  );
  cell(
    528, 758, "ASIA · NEW DELHI", "Nepal PM meets Modi in Delhi",
    "Balendra Shah was given a ceremonial welcome on Monday and held 100-minute talks with Narendra Modi. A new Ayodhya–Janakpur train was announced."
  );

  sheet.fillRect(MARGIN_L, 889, MARGIN_R - MARGIN_L, 2, INK);

  // ---- also today ----
  paintKicker(sheet, MARGIN_L, 916, "ALSO TODAY — 23 NOVEMBER 2026", 15);
  const also = [
    "Australia: music legend Molly Meldrum dies at 83 after a long illness.",
    "Hormuz: search goes on for a Jordanian sailor missing after a tanker attack.",
    "Asia: India keeps third place in the Lowy Institute Asia Power Index.",
  ];
  also.forEach((line, i) => {
    const y = 940 + i * 21;
    sheet.dot(42, y - 5, 3.5, RED);
    paint(sheet, 56, y, line, 15, INK);
  });

  // ---- footer ----
  sheet.fillRect(MARGIN_L, 995, MARGIN_R - MARGIN_L, 2, INK);
  paintCentered(
    sheet, 1014,
    "23 November 2026 · Sources: Reuters, BBC, AP, AFP, IANS · A one-day summary, drawn from the day’s reporting",
    12, GREY
  );
  return sheet;
}

// ---------------------------------------------------------------- run
const outDir = process.env.MAKEFUN_OUTPUT_DIR || "out";
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, "entry.png");
const sheet = compose();
fs.writeFileSync(outFile, encodePng(PAGE_W, PAGE_H, sheet.pixels));
console.log("wrote", outFile, fs.statSync(outFile).size, "bytes");
