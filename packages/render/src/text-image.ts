/**
 * Self-contained text rasterizer: renders a string to an RGBA bitmap using the
 * built-in 5x7 font and encodes it as a PNG (via node:zlib — no native image
 * deps). Used as the text-overlay path when ffmpeg lacks `drawtext`.
 */

import { deflateSync } from "node:zlib";
import { GLYPH_HEIGHT, GLYPH_WIDTH, glyphFor } from "./font5x7";

export interface TextImageOptions {
  content: string;
  /** Target glyph height in pixels (maps to a nearest-integer pixel scale). */
  fontSize: number;
  /** Text color, #RGB / #RRGGBB / #RRGGBBAA or a basic named color. */
  color: string;
  /** Optional box color behind the text (same formats). */
  backgroundColor?: string;
  textAlign: "left" | "center" | "right";
}

export interface TextImage {
  /** RGBA, row-major, 4 bytes per pixel. */
  data: Uint8Array;
  width: number;
  height: number;
}

const NAMED_COLORS: Record<string, [number, number, number, number]> = {
  white: [255, 255, 255, 255],
  black: [0, 0, 0, 255],
  red: [255, 0, 0, 255],
  green: [0, 128, 0, 255],
  blue: [0, 0, 255, 255],
  yellow: [255, 255, 0, 255],
  transparent: [0, 0, 0, 0],
};

/** Parse a CSS-style color into RGBA bytes. */
export function parseColor(color: string): [number, number, number, number] {
  const named = NAMED_COLORS[color.trim().toLowerCase()];
  if (named) return [...named];
  const m = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.exec(color.trim());
  if (!m) {
    throw new Error(`Unsupported color "${color}" — use #RGB, #RRGGBB, #RRGGBBAA, or a basic name`);
  }
  let hex = m[1];
  if (hex.length === 3) hex = hex.split("").map((c) => c + c).join("");
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  const a = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) : 255;
  return [r, g, b, a];
}

const CHAR_ADVANCE = GLYPH_WIDTH + 1; // 1px gap between glyphs
const LINE_ADVANCE = GLYPH_HEIGHT + 2; // 2px leading between lines

/**
 * Rasterize text into an RGBA image. The glyph grid scales by
 * round(fontSize / 7) with nearest-neighbor blocks, so output stays crisp.
 * Note: the built-in font is uppercase-only; lowercase maps to uppercase.
 */
export function renderTextImage(options: TextImageOptions): TextImage {
  const scale = Math.max(1, Math.round(options.fontSize / GLYPH_HEIGHT));
  const fg = parseColor(options.color);
  const bg = options.backgroundColor ? parseColor(options.backgroundColor) : [0, 0, 0, 0];

  const lines = (options.content.length ? options.content : " ").split(/\r?\n/);
  const lineChars = lines.map((l) => (l.length ? l.length : 1));
  const maxChars = Math.max(...lineChars);

  const pad = 2 * scale;
  const textWidth = (maxChars * CHAR_ADVANCE - 1) * scale;
  const textHeight = (lines.length * LINE_ADVANCE - 2) * scale;
  const width = textWidth + pad * 2;
  const height = textHeight + pad * 2;

  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) data.set(bg, i * 4);

  const setBlock = (x0: number, y0: number) => {
    for (let dy = 0; dy < scale; dy++) {
      for (let dx = 0; dx < scale; dx++) {
        const x = x0 + dx;
        const y = y0 + dy;
        if (x < 0 || y < 0 || x >= width || y >= height) continue;
        data.set(fg, (y * width + x) * 4);
      }
    }
  };

  lines.forEach((line, lineIndex) => {
    const lineWidth = (Math.max(1, line.length) * CHAR_ADVANCE - 1) * scale;
    let x =
      options.textAlign === "left"
        ? pad
        : options.textAlign === "right"
          ? pad + textWidth - lineWidth
          : pad + Math.round((textWidth - lineWidth) / 2);
    const y = pad + lineIndex * LINE_ADVANCE * scale;
    for (const char of line) {
      const glyph = glyphFor(char);
      for (let row = 0; row < GLYPH_HEIGHT; row++) {
        for (let col = 0; col < GLYPH_WIDTH; col++) {
          if (glyph[row][col] === "X") setBlock(x + col * scale, y + row * scale);
        }
      }
      x += CHAR_ADVANCE * scale;
    }
  });

  return { data, width, height };
}

// -- PNG encoding -----------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(...buffers: Uint8Array[]): number {
  let crc = 0xffffffff;
  for (const buf of buffers) {
    for (let i = 0; i < buf.length; i++) {
      crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeBytes, data), 0);
  return Buffer.concat([head, typeBytes, Buffer.from(data), crc]);
}

/** Encode an RGBA buffer as an 8-bit truecolor+alpha PNG. */
export function encodePng(rgba: Uint8Array, width: number, height: number): Buffer {
  if (rgba.length !== width * height * 4) {
    throw new Error(`encodePng: buffer is ${rgba.length} bytes, expected ${width * height * 4}`);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  // compression, filter, interlace = 0

  // Scanlines with filter byte 0 (None) per row.
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    const rowStart = y * (1 + width * 4);
    raw[rowStart] = 0;
    raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), rowStart + 1);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", new Uint8Array(0)),
  ]);
}
