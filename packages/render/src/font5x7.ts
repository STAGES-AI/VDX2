/**
 * A tiny built-in 5x7 pixel font for text overlays.
 *
 * Why this exists: lean ffmpeg builds (like Homebrew's default) ship without
 * libfreetype, so `drawtext` is unavailable. The renderer falls back to
 * rasterizing text itself and overlaying the result as an image input — which
 * needs a font that requires zero external dependencies. Glyphs are original
 * hand-drawn 5x7 bitmaps (classic terminal-font geometry).
 *
 * Coverage: printable ASCII subset (uppercase letters, digits, common
 * punctuation). Lowercase input maps to uppercase; unknown characters render
 * as a hollow box.
 */

export const GLYPH_WIDTH = 5;
export const GLYPH_HEIGHT = 7;

/** 7 rows of 5 chars each; "X" = pixel on, "." = pixel off. */
export type Glyph = string[];

export const FALLBACK_GLYPH: Glyph = [
  "XXXXX",
  "X...X",
  "X...X",
  "X...X",
  "X...X",
  "X...X",
  "XXXXX",
];

export const GLYPHS: Record<string, Glyph> = {
  " ": [".....", ".....", ".....", ".....", ".....", ".....", "....."],
  A: [".XXX.", "X...X", "X...X", "XXXXX", "X...X", "X...X", "X...X"],
  B: ["XXXX.", "X...X", "X...X", "XXXX.", "X...X", "X...X", "XXXX."],
  C: [".XXX.", "X...X", "X....", "X....", "X....", "X...X", ".XXX."],
  D: ["XXXX.", "X...X", "X...X", "X...X", "X...X", "X...X", "XXXX."],
  E: ["XXXXX", "X....", "X....", "XXXX.", "X....", "X....", "XXXXX"],
  F: ["XXXXX", "X....", "X....", "XXXX.", "X....", "X....", "X...."],
  G: [".XXX.", "X...X", "X....", "X.XXX", "X...X", "X...X", ".XXXX"],
  H: ["X...X", "X...X", "X...X", "XXXXX", "X...X", "X...X", "X...X"],
  I: ["XXXXX", "..X..", "..X..", "..X..", "..X..", "..X..", "XXXXX"],
  J: ["..XXX", "...X.", "...X.", "...X.", "...X.", "X..X.", ".XX.."],
  K: ["X...X", "X..X.", "X.X..", "XX...", "X.X..", "X..X.", "X...X"],
  L: ["X....", "X....", "X....", "X....", "X....", "X....", "XXXXX"],
  M: ["X...X", "XX.XX", "X.X.X", "X.X.X", "X...X", "X...X", "X...X"],
  N: ["X...X", "XX..X", "X.X.X", "X..XX", "X...X", "X...X", "X...X"],
  O: [".XXX.", "X...X", "X...X", "X...X", "X...X", "X...X", ".XXX."],
  P: ["XXXX.", "X...X", "X...X", "XXXX.", "X....", "X....", "X...."],
  Q: [".XXX.", "X...X", "X...X", "X...X", "X.X.X", "X..X.", ".XX.X"],
  R: ["XXXX.", "X...X", "X...X", "XXXX.", "X.X..", "X..X.", "X...X"],
  S: [".XXXX", "X....", "X....", ".XXX.", "....X", "....X", "XXXX."],
  T: ["XXXXX", "..X..", "..X..", "..X..", "..X..", "..X..", "..X.."],
  U: ["X...X", "X...X", "X...X", "X...X", "X...X", "X...X", ".XXX."],
  V: ["X...X", "X...X", "X...X", "X...X", "X...X", ".X.X.", "..X.."],
  W: ["X...X", "X...X", "X...X", "X.X.X", "X.X.X", "XX.XX", "X...X"],
  X: ["X...X", "X...X", ".X.X.", "..X..", ".X.X.", "X...X", "X...X"],
  Y: ["X...X", "X...X", ".X.X.", "..X..", "..X..", "..X..", "..X.."],
  Z: ["XXXXX", "....X", "...X.", "..X..", ".X...", "X....", "XXXXX"],
  "0": [".XXX.", "X...X", "X..XX", "X.X.X", "XX..X", "X...X", ".XXX."],
  "1": ["..X..", ".XX..", "..X..", "..X..", "..X..", "..X..", "XXXXX"],
  "2": [".XXX.", "X...X", "....X", "...X.", "..X..", ".X...", "XXXXX"],
  "3": ["XXXXX", "...X.", "..X..", "...X.", "....X", "X...X", ".XXX."],
  "4": ["...X.", "..XX.", ".X.X.", "X..X.", "XXXXX", "...X.", "...X."],
  "5": ["XXXXX", "X....", "XXXX.", "....X", "....X", "X...X", ".XXX."],
  "6": ["..XX.", ".X...", "X....", "XXXX.", "X...X", "X...X", ".XXX."],
  "7": ["XXXXX", "....X", "...X.", "..X..", ".X...", ".X...", ".X..."],
  "8": [".XXX.", "X...X", "X...X", ".XXX.", "X...X", "X...X", ".XXX."],
  "9": [".XXX.", "X...X", "X...X", ".XXXX", "....X", "...X.", ".XX.."],
  ".": [".....", ".....", ".....", ".....", ".....", ".XX..", ".XX.."],
  ",": [".....", ".....", ".....", ".....", ".XX..", "..X..", ".X..."],
  "!": ["..X..", "..X..", "..X..", "..X..", "..X..", ".....", "..X.."],
  "?": [".XXX.", "X...X", "....X", "...X.", "..X..", ".....", "..X.."],
  "'": ["..X..", "..X..", ".....", ".....", ".....", ".....", "....."],
  '"': [".X.X.", ".X.X.", ".....", ".....", ".....", ".....", "....."],
  "-": [".....", ".....", ".....", "XXXXX", ".....", ".....", "....."],
  "+": [".....", "..X..", "..X..", "XXXXX", "..X..", "..X..", "....."],
  ":": [".....", ".XX..", ".XX..", ".....", ".XX..", ".XX..", "....."],
  ";": [".....", ".XX..", ".XX..", ".....", ".XX..", "..X..", ".X..."],
  "(": ["...X.", "..X..", ".X...", ".X...", ".X...", "..X..", "...X."],
  ")": [".X...", "..X..", "...X.", "...X.", "...X.", "..X..", ".X..."],
  "/": ["....X", "....X", "...X.", "..X..", ".X...", "X....", "X...."],
  "=": [".....", ".....", "XXXXX", ".....", "XXXXX", ".....", "....."],
  _: [".....", ".....", ".....", ".....", ".....", ".....", "XXXXX"],
  "&": [".XX..", "X..X.", "X..X.", ".XX..", "X.X.X", "X..X.", ".XX.X"],
  "%": ["XX..X", "XX..X", "...X.", "..X..", ".X...", "X..XX", "X..XX"],
  "#": [".X.X.", ".X.X.", "XXXXX", ".X.X.", "XXXXX", ".X.X.", ".X.X."],
  "@": [".XXX.", "X...X", "X.XXX", "X.X.X", "X.XX.", "X....", ".XXX."],
  "<": ["...X.", "..X..", ".X...", "X....", ".X...", "..X..", "...X."],
  ">": [".X...", "..X..", "...X.", "....X", "...X.", "..X..", ".X..."],
  "*": [".....", "X.X.X", ".XXX.", "XXXXX", ".XXX.", "X.X.X", "....."],
};

/** Lowercase maps to uppercase; unknown characters get the fallback box. */
export function glyphFor(char: string): Glyph {
  return GLYPHS[char] ?? GLYPHS[char.toUpperCase()] ?? FALLBACK_GLYPH;
}

// Guard against data typos: every glyph must be exactly 5x7.
for (const [char, glyph] of Object.entries(GLYPHS)) {
  if (glyph.length !== GLYPH_HEIGHT || glyph.some((row) => row.length !== GLYPH_WIDTH)) {
    throw new Error(`font5x7: malformed glyph for ${JSON.stringify(char)}`);
  }
}
