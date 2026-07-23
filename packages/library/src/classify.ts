/**
 * File classification: extension first, magic bytes for unknown extensions,
 * UTF-8 text as a last-resort document. Anything else is rejected with a
 * clear error listing what the library accepts.
 */

import type { AssetKind } from "./types";

export interface Classification {
  kind: AssetKind;
  mime: string;
  ext: string;
}

const EXT_TABLE: Record<string, { kind: AssetKind; mime: string }> = {
  // images
  png: { kind: "image", mime: "image/png" },
  jpg: { kind: "image", mime: "image/jpeg" },
  jpeg: { kind: "image", mime: "image/jpeg" },
  webp: { kind: "image", mime: "image/webp" },
  gif: { kind: "image", mime: "image/gif" },
  // video
  mp4: { kind: "video", mime: "video/mp4" },
  mov: { kind: "video", mime: "video/quicktime" },
  webm: { kind: "video", mime: "video/webm" },
  m4v: { kind: "video", mime: "video/x-m4v" },
  // audio
  mp3: { kind: "audio", mime: "audio/mpeg" },
  wav: { kind: "audio", mime: "audio/wav" },
  m4a: { kind: "audio", mime: "audio/mp4" },
  aac: { kind: "audio", mime: "audio/aac" },
  aiff: { kind: "audio", mime: "audio/aiff" },
  ogg: { kind: "audio", mime: "audio/ogg" },
  // documents
  md: { kind: "document", mime: "text/markdown" },
  txt: { kind: "document", mime: "text/plain" },
  pdf: { kind: "document", mime: "application/pdf" },
  docx: {
    kind: "document",
    mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  },
  rtf: { kind: "document", mime: "text/rtf" },
};

export const SUPPORTED_EXTENSIONS = Object.keys(EXT_TABLE);

/** Lowercased extension without the dot, or "" when the name has none. */
export function extOf(name: string): string {
  const base = name.split("/").pop() ?? name;
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "";
  return base.slice(dot + 1).toLowerCase();
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(start, start + length));
}

function startsWith(bytes: Uint8Array, magic: number[]): boolean {
  return magic.every((b, i) => bytes[i] === b);
}

/** Magic-byte sniff for files with unknown/missing extensions. */
export function sniffMagic(bytes: Uint8Array): Classification | undefined {
  if (bytes.length < 4) return undefined;
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47])) return { kind: "image", mime: "image/png", ext: "png" };
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return { kind: "image", mime: "image/jpeg", ext: "jpg" };
  if (ascii(bytes, 0, 4) === "GIF8") return { kind: "image", mime: "image/gif", ext: "gif" };
  if (ascii(bytes, 0, 4) === "RIFF" && bytes.length >= 12) {
    const fourcc = ascii(bytes, 8, 4);
    if (fourcc === "WEBP") return { kind: "image", mime: "image/webp", ext: "webp" };
    if (fourcc === "WAVE") return { kind: "audio", mime: "audio/wav", ext: "wav" };
  }
  if (ascii(bytes, 0, 4) === "FORM" && bytes.length >= 12 && ascii(bytes, 8, 4).startsWith("AIF")) {
    return { kind: "audio", mime: "audio/aiff", ext: "aiff" };
  }
  if (ascii(bytes, 0, 4) === "%PDF") return { kind: "document", mime: "application/pdf", ext: "pdf" };
  if (bytes.length >= 12 && ascii(bytes, 4, 4) === "ftyp") {
    const brand = ascii(bytes, 8, 4);
    if (brand.startsWith("qt")) return { kind: "video", mime: "video/quicktime", ext: "mov" };
    if (brand === "M4A " || brand === "M4B ") return { kind: "audio", mime: "audio/mp4", ext: "m4a" };
    return { kind: "video", mime: "video/mp4", ext: "mp4" };
  }
  if (startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3])) return { kind: "video", mime: "video/webm", ext: "webm" };
  if (ascii(bytes, 0, 3) === "ID3" || (bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0)) {
    return { kind: "audio", mime: "audio/mpeg", ext: "mp3" };
  }
  if (ascii(bytes, 0, 4) === "OggS") return { kind: "audio", mime: "audio/ogg", ext: "ogg" };
  return undefined;
}

function isUtf8Text(bytes: Uint8Array): boolean {
  if (bytes.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/**
 * Classify a file by extension, then magic bytes, then a UTF-8 text fallback
 * (treated as a plain-text document). Throws for unsupported binaries.
 */
export function classify(originalName: string, bytes: Uint8Array): Classification {
  const ext = extOf(originalName);
  const known = EXT_TABLE[ext];
  if (known) return { ...known, ext };

  const sniffed = sniffMagic(bytes);
  if (sniffed) return sniffed;

  if (isUtf8Text(bytes)) {
    return { kind: "document", mime: "text/plain", ext: ext || "txt" };
  }

  throw new Error(
    `Unsupported file type for "${originalName}". Supported extensions: ${SUPPORTED_EXTENSIONS.join(", ")} ` +
      `(unknown extensions are accepted when the content is a recognizable image/video/audio format or UTF-8 text).`,
  );
}
