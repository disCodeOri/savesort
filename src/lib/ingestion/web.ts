import { safeFetchText } from "@/lib/ingestion/ssrf";

export interface PageMetadata {
  title: string | null;
  description: string | null;
  thumbnailUrl: string | null;
  canonicalUrl: string | null;
  content: string | null;
}

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function cleanText(value: string | undefined | null): string | null {
  if (!value) return null;
  const cleaned = decodeEntities(value).replace(/\s+/g, " ").trim();
  return cleaned || null;
}

function attribute(tag: string, name: string): string | null {
  const match = tag.match(new RegExp(`${name}\\s*=\\s*["']([^"']*)["']`, "i"));
  return cleanText(match?.[1]);
}

function findMeta(html: string, key: string): string | null {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const name = attribute(tag, "name") ?? attribute(tag, "property");
    if (name?.toLowerCase() === key.toLowerCase())
      return attribute(tag, "content");
  }
  return null;
}

function findLink(html: string, rel: string): string | null {
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    if (attribute(tag, "rel")?.toLowerCase() === rel)
      return attribute(tag, "href");
  }
  return null;
}

function safeAbsoluteUrl(value: string | null, baseUrl: string): string | null {
  if (!value) return null;
  try {
    const url = new URL(value, baseUrl);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

function extractVisibleContent(html: string): string | null {
  const body = html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)?.[1] ?? html;
  const withoutNoise = body
    .replace(
      /<(script|style|svg|noscript|nav|header|footer)\b[^>]*>[\s\S]*?<\/\1>/gi,
      " ",
    )
    .replace(/<!--([\s\S]*?)-->/g, " ")
    .replace(/<[^>]+>/g, " ");
  return cleanText(withoutNoise)?.slice(0, 8_000) ?? null;
}

export function extractPageMetadata(
  html: string,
  pageUrl: string,
): PageMetadata {
  const titleTag = cleanText(
    html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1],
  );
  return {
    title: findMeta(html, "og:title") ?? titleTag,
    description:
      findMeta(html, "og:description") ?? findMeta(html, "description"),
    thumbnailUrl: safeAbsoluteUrl(findMeta(html, "og:image"), pageUrl),
    canonicalUrl: safeAbsoluteUrl(findLink(html, "canonical"), pageUrl),
    content: extractVisibleContent(html),
  };
}

export async function enrichPublicWebpage(url: string): Promise<PageMetadata> {
  const response = await safeFetchText(url);
  return extractPageMetadata(response.body, response.finalUrl);
}
