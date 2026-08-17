import { createHash } from "node:crypto";

import { buildSearchableText } from "@/lib/search/searchable-text";

/** Obsidian treats the file name as the note title, so SaveSort does too. */
export function noteTitle(relativePath: string): string {
  const name = relativePath.split("/").pop() ?? relativePath;
  return name.replace(/\.md$/i, "") || name;
}

/** The vault-relative folder, shown as the note's description. */
export function noteFolder(relativePath: string): string | null {
  const parts = relativePath.split("/");
  parts.pop();
  const folder = parts.join("/");
  return folder.length > 0 ? folder : null;
}

/** A link that opens the note in Obsidian on the machine that synced it. */
export function obsidianOpenUrl(
  vaultName: string,
  relativePath: string,
): string {
  const params = new URLSearchParams({
    vault: vaultName,
    file: relativePath.replace(/\.md$/i, ""),
  });
  return `obsidian://open?${params.toString()}`;
}

export function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export function buildNoteSearchableText(
  relativePath: string,
  content: string,
): string {
  return buildSearchableText({
    title: noteTitle(relativePath),
    source: "obsidian",
    description: noteFolder(relativePath),
    content,
  });
}
