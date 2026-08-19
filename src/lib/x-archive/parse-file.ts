/**
 * Safe parsing of X/Twitter archive files.
 *
 * Archive `.js` files are JavaScript assignments wrapping a JSON payload, e.g.
 *
 *   window.YTD.like.part0 = [ ... ]
 *
 * They are treated strictly as DATA. Nothing here evaluates, imports, or
 * injects the file: the assignment prefix is stripped textually and the
 * remainder goes through JSON.parse. A file that does not yield valid JSON is
 * reported as a per-file error rather than executed in any form.
 */

export type ArchiveFileFormat = "json" | "js" | "csv" | "unknown";

export interface ParsedArchiveFile {
  format: ArchiveFileFormat;
  records: unknown[];
  error: string | null;
}

/** Anything larger is refused before parsing to bound memory use. */
export const MAX_FILE_BYTES = 64 * 1024 * 1024;

export function detectFormat(relativePath: string): ArchiveFileFormat {
  const lower = relativePath.toLowerCase();
  if (lower.endsWith(".json")) return "json";
  if (lower.endsWith(".js")) return "js";
  if (lower.endsWith(".csv")) return "csv";
  return "unknown";
}

/**
 * Removes a leading `<identifier chain> = ` assignment, if present.
 *
 * Matched structurally rather than by a hardcoded global name, because X has
 * changed the wrapper prefix over time and will again.
 */
export function stripJsAssignment(source: string): string {
  const text = source.replace(/^﻿/, "").trimStart();
  const assignment =
    /^[A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*|\s*\[\s*(['"])[^'"]*\1\s*\])*\s*=\s*/;
  const withoutPrefix = text.replace(assignment, "");
  // A trailing semicolon is valid JS but not valid JSON.
  return withoutPrefix.trim().replace(/;\s*$/, "");
}

function parseCsv(source: string): unknown[] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let quoted = false;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (char === '"') {
        if (source[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (char !== "\r") {
      field += char;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  const [header, ...body] = rows;
  if (!header) return [];
  return body
    .filter((entry) => entry.some((value) => value.trim().length > 0))
    .map((entry) =>
      Object.fromEntries(
        header.map((key, index) => [key.trim(), entry[index] ?? ""]),
      ),
    );
}

/** Archive payloads are arrays at the top level, or a single object. */
function toRecords(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") return [value];
  return [];
}

export function parseArchiveFile(
  relativePath: string,
  source: string,
): ParsedArchiveFile {
  const format = detectFormat(relativePath);

  if (format === "csv") {
    try {
      return { format, records: parseCsv(source), error: null };
    } catch {
      return { format, records: [], error: "This file could not be read." };
    }
  }

  const payload = format === "js" ? stripJsAssignment(source) : source.trim();
  if (!payload) {
    return { format, records: [], error: "This file was empty." };
  }

  try {
    return { format, records: toRecords(JSON.parse(payload)), error: null };
  } catch {
    return {
      format,
      records: [],
      // Deliberately generic: a parse failure must never echo file contents.
      error: "This file could not be read as archive data.",
    };
  }
}
