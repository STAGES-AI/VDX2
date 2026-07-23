/**
 * Document text extraction, best-effort and feature-detected:
 *   .txt/.md  -> read utf8                              ('plain')
 *   .docx     -> textutil (macOS), else unzip + strip   ('textutil'/'unzip-xml')
 *   .rtf      -> textutil                               ('textutil', else 'none')
 *   .pdf      -> pdftotext when installed               ('pdftotext', else 'none')
 * Extraction never fails an ingest: the asset stores either way, and when a
 * Claude key is present the agent can read PDFs natively — extraction here is
 * only for offline grounding/search.
 */

import { readFileSync } from "node:fs";
import type { DocumentRecord } from "./types";
import { run } from "./probe";

/** Stored text is capped so briefs/scripts stay searchable without bloating the db. */
export const MAX_STORED_TEXT_CHARS = 200_000;

export interface ExtractedText {
  textContent: string;
  extractionMethod: DocumentRecord["extractionMethod"];
  wordCount: number;
}

function finalize(text: string, method: DocumentRecord["extractionMethod"]): ExtractedText {
  const capped = text.slice(0, MAX_STORED_TEXT_CHARS);
  const wordCount = capped.split(/\s+/).filter(Boolean).length;
  return { textContent: capped, extractionMethod: method, wordCount };
}

const XML_ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
};

/** Strip WordprocessingML down to plain text (paragraphs -> newlines). */
export function stripDocxXml(xml: string): string {
  return xml
    .replace(/<\/w:p>/g, "\n")
    .replace(/<w:tab[^>]*\/>/g, "\t")
    .replace(/<w:br[^>]*\/>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&(amp|lt|gt|quot|apos);/g, (m) => XML_ENTITIES[m] ?? m)
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

/** macOS textutil conversion to plain text (docx/rtf/html...). */
export async function extractViaTextutil(path: string): Promise<string | undefined> {
  if (!Bun.which("textutil")) return undefined;
  const result = await run(["textutil", "-convert", "txt", "-stdout", path]);
  if (result.code !== 0) return undefined;
  const text = result.stdout.trim();
  return text.length > 0 ? text : undefined;
}

/** Portable docx fallback: pull word/document.xml out of the zip and strip tags. */
export async function extractDocxViaUnzip(path: string): Promise<string | undefined> {
  if (!Bun.which("unzip")) return undefined;
  const result = await run(["unzip", "-p", path, "word/document.xml"]);
  if (result.code !== 0) return undefined;
  const text = stripDocxXml(result.stdout);
  return text.length > 0 ? text : undefined;
}

async function extractPdf(path: string): Promise<ExtractedText> {
  if (!Bun.which("pdftotext")) return finalize("", "none");
  const result = await run(["pdftotext", path, "-"]);
  if (result.code !== 0) return finalize("", "none");
  return finalize(result.stdout.trim(), "pdftotext");
}

/**
 * Extract text from a stored document blob. `ext` is the classified
 * extension (see classify.ts); unknown text-y extensions read as utf8.
 */
export async function extractText(path: string, ext: string): Promise<ExtractedText> {
  switch (ext) {
    case "docx": {
      const viaTextutil = await extractViaTextutil(path);
      if (viaTextutil !== undefined) return finalize(viaTextutil, "textutil");
      const viaUnzip = await extractDocxViaUnzip(path);
      if (viaUnzip !== undefined) return finalize(viaUnzip, "unzip-xml");
      return finalize("", "none");
    }
    case "rtf": {
      const viaTextutil = await extractViaTextutil(path);
      if (viaTextutil !== undefined) return finalize(viaTextutil, "textutil");
      return finalize("", "none");
    }
    case "pdf":
      return extractPdf(path);
    default: {
      // .txt/.md and unknown-extension utf8 documents.
      try {
        return finalize(readFileSync(path, "utf8"), "plain");
      } catch {
        return finalize("", "none");
      }
    }
  }
}
