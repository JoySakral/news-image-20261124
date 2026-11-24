// news-image-20261124 — draws a 1024x1024 newspaper front page summing up
// the world news of Tuesday 24 November 2026 and writes it to entry.png.
// Node 22, standard library only, no network. Everything is drawn here:
// a tiny RGB canvas, a 5x7 bitmap font, a PNG encoder (CRC32 + zlib),
// the masthead, the lead story scene, six story tiles and the footer.
//
//   MAKEFUN_OUTPUT_DIR=out node main.ts

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';

// ---------------------------------------------------------------- CRC32
const CRC_TABLE: number[] = (() => {
  const table: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table.push(c >>> 0);
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

// Encode raw RGB rows (width*3 bytes each) as a PNG with filter 0 per row.
function encodePng(width: number, height: number, rgb: Uint8Array): Buffer {
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 3)] = 0;
    Buffer.from(rgb.buffer, rgb.byteOffset + y * width * 3, width * 3)
      .copy(raw, y * (1 + width * 3) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type RGB
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------- canvas
type RGB = [number, number, number];

class Canvas {
  readonly w: number;
  readonly h: number;
  readonly px: Uint8Array; // RGB rows

  constructor(w: number, h: number, bg: RGB) {
    this.w = w;
    this.h = h;
    this.px = new Uint8Array(w * h * 3);
    this.fill(bg);
  }

  fill(c: RGB): void {
    for (let i = 0; i < this.px.length; i += 3) {
      this.px[i] = c[0];
      this.px[i + 1] = c[1];
      this.px[i + 2] = c[2];
    }
  }

  set(x: number, y: number, c: RGB): void {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const i = (y * this.w + x) * 3;
    this.px[i] = c[0];
    this.px[i + 1] = c[1];
    this.px[i + 2] = c[2];
  }

  rect(x: number, y: number, w: number, h: number, c: RGB): void {
    const x0 = Math.max(0, Math.floor(x));
    const y0 = Math.max(0, Math.floor(y));
    const x1 = Math.min(this.w, Math.ceil(x + w));
    const y1 = Math.min(this.h, Math.ceil(y + h));
    for (let yy = y0; yy < y1; yy++) {
      for (let xx = x0; xx < x1; xx++) {
        const i = (yy * this.w + xx) * 3;
        this.px[i] = c[0];
        this.px[i + 1] = c[1];
        this.px[i + 2] = c[2];
      }
    }
  }

  hline(x: number, y: number, w: number, c: RGB): void {
    this.rect(x, y, w, 1, c);
  }

  vline(x: number, y: number, h: number, c: RGB): void {
    this.rect(x, y, 1, h, c);
  }

  // Bresenham line.
  line(x0: number, y0: number, x1: number, y1: number, c: RGB): void {
    const dx = Math.abs(x1 - x0);
    const dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    let x = x0;
    let y = y0;
    for (;;) {
      this.set(x, y, c);
      if (x === x1 && y === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) {
        err += dy;
        x += sx;
      }
      if (e2 <= dx) {
        err += dx;
        y += sy;
      }
    }
  }

  // Filled circle by horizontal spans.
  disc(cx: number, cy: number, r: number, c: RGB): void {
    for (let dy = -r; dy <= r; dy++) {
      const half = Math.floor(Math.sqrt(r * r - dy * dy));
      this.rect(cx - half, cy + dy, half * 2 + 1, 1, c);
    }
  }

  // Filled triangle via scanline interpolation between its three edges.
  triangle(x0: number, y0: number, x1: number, y1: number, x2: number, y2: number, c: RGB): void {
    const pts = [
      [x0, y0],
      [x1, y1],
      [x2, y2],
    ].sort((a, b) => a[1] - b[1]);
    const [ax, ay] = pts[0];
    const [bx, by] = pts[1];
    const [cx, cy] = pts[2];
    const interp = (xa: number, ya: number, xb: number, yb: number, y: number): number =>
      ya === yb ? xa : xa + ((xb - xa) * (y - ya)) / (yb - ya);
    // Scanlines must be integers: a fractional y would shift the row's
    // writes by half a row's width in the flat pixel buffer.
    for (let y = Math.ceil(ay); y <= cy; y++) {
      const xa = interp(ax, ay, cx, cy, y);
      const xb = y <= by ? interp(ax, ay, bx, by, y) : interp(bx, by, cx, cy, y);
      const lo = Math.ceil(Math.min(xa, xb));
      const hi = Math.floor(Math.max(xa, xb));
      if (hi >= lo) this.rect(lo, y, hi - lo + 1, 1, c);
    }
  }

  // Outlined rectangle, 1px border.
  frame(x: number, y: number, w: number, h: number, c: RGB): void {
    this.hline(x, y, w, c);
    this.hline(x, y + h - 1, w, c);
    this.vline(x, y, h, c);
    this.vline(x + w - 1, y, h, c);
  }
}

// ---------------------------------------------------------------- 5x7 font
// Each glyph is 7 rows of 5 cells; '1' is ink, '0' is blank. Uppercase,
// digits and the punctuation this page needs. Drawn at integer scales.
const GLYPHS: Record<string, string[]> = {
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
  C: ['01110', '10001', '10000', '10000', '10000', '10001', '01110'],
  D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  F: ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
  G: ['01110', '10001', '10000', '10111', '10001', '10001', '01111'],
  H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
  I: ['01110', '00100', '00100', '00100', '00100', '00100', '01110'],
  J: ['00111', '00010', '00010', '00010', '00010', '10010', '01100'],
  K: ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
  N: ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  Q: ['01110', '10001', '10001', '10001', '10101', '10010', '01101'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  U: ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
  V: ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
  W: ['10001', '10001', '10001', '10101', '10101', '11011', '10001'],
  X: ['10001', '10001', '01010', '00100', '01010', '10001', '10001'],
  Y: ['10001', '10001', '01010', '00100', '00100', '00100', '00100'],
  Z: ['11111', '00001', '00010', '00100', '01000', '10000', '11111'],
  '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  '2': ['01110', '10001', '00001', '00110', '01000', '10000', '11111'],
  '3': ['11111', '00010', '00100', '00010', '00001', '10001', '01110'],
  '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  '5': ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  '6': ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  '9': ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
  '.': ['00000', '00000', '00000', '00000', '00000', '01100', '01100'],
  ',': ['00000', '00000', '00000', '00000', '01100', '00100', '01000'],
  ':': ['00000', '01100', '01100', '00000', '01100', '01100', '00000'],
  ';': ['00000', '01100', '01100', '00000', '01100', '00100', '01000'],
  "'": ['00100', '00100', '01000', '00000', '00000', '00000', '00000'],
  '-': ['00000', '00000', '00000', '01110', '00000', '00000', '00000'],
  '(': ['00010', '00100', '01000', '01000', '01000', '00100', '00010'],
  ')': ['01000', '00100', '00010', '00010', '00010', '00100', '01000'],
  '/': ['00001', '00010', '00010', '00100', '01000', '01000', '10000'],
  '!': ['00100', '00100', '00100', '00100', '00100', '00000', '00100'],
  '?': ['01110', '10001', '00001', '00110', '00100', '00000', '00100'],
  '&': ['01100', '10010', '10100', '01000', '10101', '10010', '01101'],
  '%': ['11001', '11010', '00010', '00100', '01000', '01011', '10011'],
  '+': ['00000', '00100', '00100', '11111', '00100', '00100', '00000'],
  '=': ['00000', '00000', '11111', '00000', '11111', '00000', '00000'],
  '•': ['00000', '00000', '01100', '01100', '00000', '00000', '00000'],
  ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
};

const CHAR_W = 6; // glyph advance in font units (5 px glyph + 1 px gap)
const CHAR_H = 7;

function textWidth(text: string, scale: number): number {
  return text.length * CHAR_W * scale - scale;
}

function drawText(cv: Canvas, text: string, x: number, y: number, scale: number, c: RGB): void {
  let cx = x;
  for (const ch of text) {
    // The bitmap font is uppercase-only; fold case so body copy reads.
    const g = GLYPHS[ch.toUpperCase()] ?? GLYPHS['?'];
    for (let r = 0; r < CHAR_H; r++) {
      for (let col = 0; col < 5; col++) {
        if (g[r][col] === '1') cv.rect(cx + col * scale, y + r * scale, scale, scale, c);
      }
    }
    cx += CHAR_W * scale;
  }
}

function drawTextCentred(cv: Canvas, text: string, cx: number, y: number, scale: number, c: RGB): void {
  drawText(cv, text, cx - Math.floor(textWidth(text, scale) / 2), y, scale, c);
}

// Greedy word wrap; returns lines that fit maxWidth at the given scale.
function wrapText(text: string, maxWidth: number, scale: number): string[] {
  const words = text.split(' ');
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    const trial = cur ? cur + ' ' + w : w;
    if (textWidth(trial, scale) <= maxWidth || !cur) {
      cur = trial;
    } else {
      lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

// Draw wrapped text; returns the y just below the last line.
function drawPara(cv: Canvas, text: string, x: number, y: number, maxWidth: number, scale: number, c: RGB, leading: number): number {
  const lines = wrapText(text, maxWidth, scale);
  for (const line of lines) {
    drawText(cv, line, x, y, scale, c);
    y += leading;
  }
  return y;
}

// ---------------------------------------------------------------- palette
const PAPER: RGB = [246, 241, 229];
const INK: RGB = [23, 21, 15];
const RED: RGB = [163, 29, 29];
const MUTED: RGB = [90, 83, 68];
const PANEL: RGB = [232, 225, 207];
const SKY: RGB = [196, 205, 214];
const STEEL: RGB = [74, 78, 84];
const FLAME: RGB = [224, 94, 22];
const FLAME2: RGB = [240, 178, 32];
const SMOKE: RGB = [120, 120, 116];
const GREEN: RGB = [31, 122, 60];
const BLUE: RGB = [38, 84, 138];

// ---------------------------------------------------------------- pictograms
// Each draws a small scene inside the box (x, y, w, h) at a tile's top.

function pictoKyiv(cv: Canvas, x: number, y: number, w: number, h: number): void {
  cv.rect(x, y, w, h, [58, 64, 78]);
  cv.rect(x + 18, y + 22, 52, h - 22, STEEL);
  cv.rect(x + 84, y + 12, 44, h - 12, [52, 56, 62]);
  cv.rect(x + 142, y + 26, 60, h - 26, STEEL);
  for (let i = 0; i < 3; i++) {
    cv.rect(x + 26 + i * 14, y + 30, 6, 6, FLAME2);
    cv.rect(x + 92 + i * 12, y + 20, 5, 5, FLAME2);
  }
  const ex = x + w - 62;
  const ey = y + 26;
  cv.disc(ex, ey, 15, FLAME);
  cv.disc(ex, ey, 8, FLAME2);
  for (let k = 0; k < 8; k++) {
    const a = (k * Math.PI) / 4;
    cv.line(ex, ey, Math.round(ex + 26 * Math.cos(a)), Math.round(ey + 26 * Math.sin(a)), FLAME);
  }
  cv.disc(x + w - 96, y + 16, 8, SMOKE);
  cv.disc(x + w - 80, y + 12, 10, SMOKE);
}

function pictoShip(cv: Canvas, x: number, y: number, w: number, h: number): void {
  cv.rect(x, y, w, h, [168, 196, 214]);
  cv.rect(x, y + h - 16, w, 16, [52, 96, 140]);
  cv.hline(x, y + h - 10, w, [120, 170, 205]);
  const hx = x + 40;
  const hy = y + h - 34;
  cv.triangle(hx, hy + 18, hx + 150, hy + 18, hx + 18, hy, [90, 42, 36]);
  cv.rect(hx + 18, hy, 132, 18, [120, 52, 44]);
  cv.rect(hx + 60, hy - 16, 34, 16, [140, 66, 54]);
  cv.rect(hx + 72, hy - 30, 4, 14, INK);
  cv.triangle(hx + 96, hy - 12, hx + 108, hy - 12, hx + 102, hy - 18, FLAME);
  cv.triangle(hx + 110, hy - 12, hx + 120, hy - 12, hx + 115, hy - 14, FLAME2);
}

function pictoChip(cv: Canvas, x: number, y: number, w: number, h: number): void {
  cv.rect(x, y, w, h, [26, 34, 44]);
  const cx = x + 26;
  const cy = y + 10;
  cv.rect(cx, cy, 40, 40, [24, 120, 70]);
  cv.rect(cx + 12, cy + 12, 16, 16, [18, 80, 48]);
  for (let i = 0; i < 5; i++) {
    cv.rect(cx + 4 + i * 8, cy - 5, 3, 5, [180, 190, 200]);
    cv.rect(cx + 4 + i * 8, cy + 40, 3, 5, [180, 190, 200]);
    cv.rect(cx - 5, cy + 4 + i * 8, 5, 3, [180, 190, 200]);
    cv.rect(cx + 40, cy + 4 + i * 8, 5, 3, [180, 190, 200]);
  }
  // Rising chart line to the right of the chip.
  const pts: [number, number][] = [
    [x + 92, y + 46],
    [x + 118, y + 38],
    [x + 140, y + 40],
    [x + 166, y + 26],
    [x + 196, y + 28],
    [x + 224, y + 12],
  ];
  for (let i = 0; i < pts.length - 1; i++) {
    cv.line(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], [70, 200, 110]);
    cv.line(pts[i][0], pts[i][1] + 1, pts[i + 1][0], pts[i + 1][1] + 1, [70, 200, 110]);
  }
  cv.triangle(x + 224, y + 12, x + 212, y + 10, x + 222, y + 22, [70, 200, 110]);
}

function pictoTrain(cv: Canvas, x: number, y: number, w: number, h: number): void {
  cv.rect(x, y, w, h, [214, 226, 214]);
  const ty = y + 6;
  cv.rect(x + 30, ty, 170, 26, [150, 40, 40]);
  cv.rect(x + 30, ty + 26, 170, 8, [240, 232, 214]);
  for (let i = 0; i < 5; i++) cv.rect(x + 40 + i * 32, ty + 6, 20, 14, [250, 244, 220]);
  cv.rect(x + 200, ty, 44, 34, [120, 32, 32]);
  cv.rect(x + 208, ty + 6, 16, 12, [250, 244, 220]);
  cv.disc(x + 62, ty + 40, 7, INK);
  cv.disc(x + 108, ty + 40, 7, INK);
  cv.disc(x + 154, ty + 40, 7, INK);
  cv.disc(x + 216, ty + 40, 7, INK);
  cv.hline(x + 10, ty + 50, w - 20, INK);
}

function pictoCrowd(cv: Canvas, x: number, y: number, w: number, h: number): void {
  cv.rect(x, y, w, h, [226, 214, 190]);
  for (let i = 0; i < 8; i++) {
    const px = x + 22 + i * 32;
    cv.disc(px, y + 22, 8, [120, 80, 52]);
    cv.rect(px - 11, y + 30, 22, h - 30, i % 2 ? [70, 96, 140] : [150, 60, 50]);
  }
  cv.rect(x + 96, y + 4, 74, 16, [250, 248, 240]);
  cv.frame(x + 96, y + 4, 74, 16, INK);
  drawText(cv, 'COSTS!', x + 102, y + 8, 1, RED);
  cv.vline(x + 100, y + 20, 12, INK);
  cv.vline(x + 166, y + 20, 12, INK);
}

function pictoTrophy(cv: Canvas, x: number, y: number, w: number, h: number): void {
  cv.rect(x, y, w, h, [214, 222, 232]);
  const cx = x + 70;
  cv.rect(cx - 22, y + 8, 44, 26, FLAME2);
  cv.triangle(cx - 22, y + 34, cx + 22, y + 34, cx, y + 46, FLAME2);
  cv.rect(cx - 4, y + 46, 8, 8, FLAME2);
  cv.rect(cx - 16, y + 54, 32, 4, FLAME2);
  cv.line(cx - 22, y + 12, cx - 34, y + 20, FLAME2);
  cv.line(cx + 22, y + 12, cx + 34, y + 20, FLAME2);
  cv.disc(x + 180, y + 20, 14, [250, 250, 250]);
  cv.disc(x + 232, y + 40, 12, INK);
  drawText(cv, '128', x + 223, y + 36, 1, [250, 250, 250]);
}

// ---------------------------------------------------------------- lead scene
function drawLeadScene(cv: Canvas, x: number, y: number, w: number, h: number): void {
  cv.rect(x, y, w, h, SKY);
  cv.rect(x, y + h - 26, w, 26, [96, 92, 82]);
  // Factory block with sawtooth roof.
  const bx = x + 56;
  const by = y + 78;
  const bw = w - 130;
  const bh = h - 78 - 26;
  cv.rect(bx, by, bw, bh, STEEL);
  for (let i = 0; i < 4; i++) {
    const tx = bx + i * Math.floor(bw / 4);
    cv.triangle(tx, by, tx + Math.floor(bw / 4), by, tx + Math.floor(bw / 4), by - 22, [58, 62, 68]);
  }
  // Lit windows.
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 9; c++) {
      cv.rect(bx + 14 + c * 34, by + 18 + r * 26, 18, 14, FLAME2);
    }
  }
  // Chimneys and smoke.
  cv.rect(bx + bw - 52, by - 52, 16, 52, [52, 56, 62]);
  cv.rect(bx + bw - 84, by - 40, 14, 40, [52, 56, 62]);
  cv.disc(bx + bw - 44, by - 60, 12, SMOKE);
  cv.disc(bx + bw - 30, by - 74, 15, SMOKE);
  cv.disc(bx + bw - 70, by - 48, 10, SMOKE);
  cv.disc(bx + bw - 58, by - 62, 13, SMOKE);
  // Flames along the roofline.
  const flames: [number, number, number][] = [
    [0.08, 46, 30],
    [0.24, 62, 38],
    [0.42, 50, 30],
    [0.58, 66, 40],
    [0.74, 52, 32],
    [0.88, 58, 36],
  ];
  for (const [fx, fh, fw] of flames) {
    const px = bx + Math.floor(fx * bw);
    cv.triangle(px - fw / 2, by, px + fw / 2, by, px, by - fh, FLAME);
    cv.triangle(px - fw / 4, by, px + fw / 4, by, px, by - fh * 0.55, FLAME2);
  }
  // Fire engine at the gate.
  const ex = x + 14;
  const ey = y + h - 58;
  cv.rect(ex, ey, 64, 26, [178, 34, 28]);
  cv.rect(ex + 44, ey - 12, 20, 12, [178, 34, 28]);
  cv.rect(ex + 6, ey + 5, 16, 10, [250, 244, 220]);
  cv.disc(ex + 16, ey + 28, 6, INK);
  cv.disc(ex + 50, ey + 28, 6, INK);
  cv.line(ex + 70, ey + 4, ex + 118, ey - 34, [220, 220, 210]);
  cv.line(ex + 70, ey + 8, ex + 118, ey - 30, [220, 220, 210]);
}

// ---------------------------------------------------------------- tiles
interface Tile {
  kicker: string;
  headline: string;
  detail: string;
  picto: (cv: Canvas, x: number, y: number, w: number, h: number) => void;
}

const TILES: Tile[] = [
  {
    kicker: 'UKRAINE',
    headline: 'MISSILES HIT KYIV REGION',
    detail:
      'Russian drone and missile attacks kill several people and leave others missing. A home is hit in Dymer, Zelenskyy says.',
    picto: pictoKyiv,
  },
  {
    kicker: 'GULF OF FINLAND',
    headline: 'RUSSIAN SHIP ON FIRE AT SEA',
    detail:
      'Cargo ship Sparta II burns after a drone attack and drifts toward Finnish waters.',
    picto: pictoShip,
  },
  {
    kicker: 'MARKETS',
    headline: 'HUANG BACK AT NVIDIA',
    detail:
      'Board reinstates Jensen Huang as CEO after an inquiry; shares surge 31% in a day.',
    picto: pictoChip,
  },
  {
    kicker: 'INDIA - NEPAL',
    headline: 'NEW TRAIN LINKS AYODHYA, JANAKPUR',
    detail:
      'PM Modi and Nepal PM Shah flag off the Saryu-Kamala Express and hold talks on energy and trade.',
    picto: pictoTrain,
  },
  {
    kicker: 'PORTUGAL',
    headline: 'THOUSANDS MARCH OVER LIVING COSTS',
    detail: 'Protesters fill Lisbon streets as rising prices squeeze households.',
    picto: pictoCrowd,
  },
  {
    kicker: 'SPORT',
    headline: 'PANT 128 AS TEST IS DRAWN',
    detail:
      'Alcaraz wins the ATP Finals; Verstappen takes Las Vegas; the chess title match opens in Geneva.',
    picto: pictoTrophy,
  },
];

function drawTile(cv: Canvas, t: Tile, x: number, y: number, w: number, h: number): void {
  cv.frame(x, y, w, h, INK);
  t.picto(cv, x + 1, y + 1, w - 2, 58);
  cv.hline(x, y + 59, w, INK);
  const ix = x + 10;
  const iw = w - 20;
  drawText(cv, t.kicker, ix, y + 68, 1, RED);
  let ty = y + 82;
  for (const line of wrapText(t.headline, iw, 2)) {
    drawText(cv, line, ix, ty, 2, INK);
    ty += 18;
  }
  ty += 4;
  drawPara(cv, t.detail, ix, ty, iw, 1, MUTED, 12);
}

// ---------------------------------------------------------------- page
function drawPage(): Buffer {
  const W = 1024;
  const H = 1024;
  const cv = new Canvas(W, H, PAPER);
  const M = 30; // margin
  const R = W - M; // right edge of content

  // Masthead.
  drawTextCentred(cv, 'THE WORLD IN ONE IMAGE', W / 2, 28, 7, INK);
  drawTextCentred(cv, 'TUESDAY 24 NOVEMBER 2026', W / 2, 92, 3, RED);
  cv.rect(M, 122, R - M, 3, INK);
  cv.hline(M, 129, R - M, INK);

  // Lead story.
  drawText(cv, 'LEAD STORY - INDONESIA', M, 146, 2, RED);
  drawText(cv, '24 DEAD IN INDONESIA', M, 168, 4, INK);
  drawText(cv, 'CANDY FACTORY FIRE', M, 200, 4, INK);
  const sceneX = M;
  const sceneY = 238;
  const sceneW = 500;
  const sceneH = 220;
  cv.frame(sceneX, sceneY, sceneW, sceneH, INK);
  drawLeadScene(cv, sceneX + 1, sceneY + 1, sceneW - 2, sceneH - 2);
  const tx = 552;
  const tw = R - tx;
  let ty = drawPara(
    cv,
    'Fire broke out on Saturday at the PT Fonusa Agung Mulia candy plant in Cikande, Serang, Banten. Rescuers are still searching the wreckage for about 30 workers missing. The cause is under investigation.',
    tx,
    sceneY + 2,
    tw,
    2,
    INK,
    22,
  );
  ty += 10;
  cv.frame(tx, ty, tw, 52, RED);
  drawTextCentred(cv, '24 DEAD - 15 RESCUED', tx + tw / 2, ty + 9, 2, RED);
  drawTextCentred(cv, 'ABOUT 30 STILL MISSING', tx + tw / 2, ty + 31, 2, RED);

  // Story tiles, 3 x 2.
  cv.hline(M, 474, R - M, INK);
  const tileW = 304;
  const tileH = 200;
  const gap = 14;
  for (let i = 0; i < TILES.length; i++) {
    const col = i % 3;
    const row = Math.floor(i / 3);
    drawTile(
      cv,
      TILES[i],
      M + col * (tileW + gap),
      488 + row * (tileH + gap),
      tileW,
      tileH,
    );
  }

  // Also ticker.
  cv.hline(M, 914, R - M, INK);
  drawText(cv, 'ALSO:', M, 926, 1, RED);
  drawPara(
    cv,
    'COP31 ends in Antalya with no fossil-fuel deal. Myanmar criticises ASEAN. Seoul names a new foreign minister. Armenia plans a new constitution. Bangladesh vows to arrest Hasina if she returns.',
    M + 42,
    926,
    R - M - 42,
    1,
    INK,
    13,
  );

  // Footer.
  cv.hline(M, 962, R - M, INK);
  drawTextCentred(
    cv,
    'SOURCES: BBC - FRANCE 24 - THE GUARDIAN - AP - REUTERS',
    W / 2,
    974,
    1,
    MUTED,
  );

  return encodePng(W, H, cv.px);
}

function main(): void {
  const outDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
  mkdirSync(outDir, { recursive: true });
  const png = drawPage();
  writeFileSync(join(outDir, 'entry.png'), png);
  console.log(`wrote ${png.length} bytes to ${join(outDir, 'entry.png')}`);
}

main();
