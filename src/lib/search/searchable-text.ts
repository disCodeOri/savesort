const MAX_SEARCHABLE_TEXT_LENGTH = 12_000;

export interface SearchableItemText {
  title?: string | null;
  source: string;
  author?: string | null;
  description?: string | null;
  tags?: string[] | null;
  notes?: string | null;
  content?: string | null;
}

function clean(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function buildSearchableText(item: SearchableItemText): string {
  const fields: Array<[string, string | undefined | null]> = [
    ["Title", item.title],
    ["Source", item.source],
    ["Author", item.author],
    ["Description", item.description],
    ["Tags", item.tags?.join(", ")],
    ["Notes", item.notes],
    ["Content", item.content],
  ];

  return fields
    .map(([label, value]) => [label, value ? clean(value) : ""] as const)
    .filter(([, value]) => value.length > 0)
    .map(([label, value]) => `${label}: ${value}`)
    .join("\n")
    .slice(0, MAX_SEARCHABLE_TEXT_LENGTH)
    .trim();
}
