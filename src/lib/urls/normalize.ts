const TRACKING_PARAMETER_NAMES = new Set([
  "fbclid",
  "gclid",
  "dclid",
  "mc_cid",
  "mc_eid",
  "igshid",
  "ref_src",
]);

export type UrlValidationResult =
  { ok: true; url: URL } | { ok: false; message: string };

export function validateHttpUrl(input: string): UrlValidationResult {
  const trimmed = input.trim();
  if (!trimmed) {
    return { ok: false, message: "That URL doesn't look valid." };
  }

  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return { ok: false, message: "Only HTTP and HTTPS links can be saved." };
    }
    if (!url.hostname || url.username || url.password) {
      return { ok: false, message: "That URL doesn't look valid." };
    }
    return { ok: true, url };
  } catch {
    return { ok: false, message: "That URL doesn't look valid." };
  }
}

export function normalizeUrl(input: string): string {
  const validation = validateHttpUrl(input);
  if (!validation.ok) {
    throw new Error(validation.message);
  }

  const url = validation.url;
  url.hash = "";

  for (const name of [...url.searchParams.keys()]) {
    const lowerName = name.toLowerCase();
    if (
      lowerName.startsWith("utm_") ||
      TRACKING_PARAMETER_NAMES.has(lowerName)
    ) {
      url.searchParams.delete(name);
    }
  }

  if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
    url.pathname = url.pathname.replace(/\/+$/, "");
  }

  return url.toString();
}
