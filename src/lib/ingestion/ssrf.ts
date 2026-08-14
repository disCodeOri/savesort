import { isIP } from "node:net";
import { lookup } from "node:dns/promises";

import { validateHttpUrl } from "@/lib/urls/normalize";

const MAX_REDIRECTS = 3;
const DEFAULT_MAX_BYTES = 1_000_000;
const DEFAULT_TIMEOUT_MS = 6_000;

function isPrivateIpv4(address: string): boolean {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((octet) => Number.isNaN(octet)))
    return true;

  const [a, b] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    a >= 224
  );
}

export function isPrivateIpAddress(address: string): boolean {
  const normalized = address.toLowerCase();
  if (normalized.startsWith("::ffff:")) {
    return isPrivateIpAddress(normalized.slice(7));
  }

  const version = isIP(normalized);
  if (version === 4) return isPrivateIpv4(normalized);
  if (version !== 6) return true;

  return (
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe8") ||
    normalized.startsWith("fe9") ||
    normalized.startsWith("fea") ||
    normalized.startsWith("feb")
  );
}

export async function assertPublicHttpUrl(input: string): Promise<URL> {
  const validation = validateHttpUrl(input);
  if (!validation.ok) throw new Error(validation.message);

  const url = validation.url;
  const hostname = url.hostname.toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    throw new Error("Local network addresses cannot be fetched.");
  }

  if (isIP(hostname)) {
    if (isPrivateIpAddress(hostname)) {
      throw new Error("Private network addresses cannot be fetched.");
    }
    return url;
  }

  const addresses = await lookup(hostname, { all: true, verbatim: true });
  if (
    !addresses.length ||
    addresses.some(({ address }) => isPrivateIpAddress(address))
  ) {
    throw new Error("Private network addresses cannot be fetched.");
  }

  return url;
}

async function readBoundedText(
  response: Response,
  maxBytes: number,
): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length") ?? "0");
  if (declaredLength > maxBytes)
    throw new Error("The webpage response was too large.");
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel();
      throw new Error("The webpage response was too large.");
    }
    chunks.push(value);
  }

  const merged = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

export async function safeFetchText(
  input: string,
  options: { maxBytes?: number; timeoutMs?: number } = {},
): Promise<{ body: string; finalUrl: string; contentType: string }> {
  let url = await assertPublicHttpUrl(input);
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  for (
    let redirectCount = 0;
    redirectCount <= MAX_REDIRECTS;
    redirectCount += 1
  ) {
    const response = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        Accept: "text/html,application/xhtml+xml;q=0.9,text/plain;q=0.7",
        "User-Agent": "SaveSort/0.1 metadata fetcher",
      },
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location || redirectCount === MAX_REDIRECTS) {
        throw new Error("The webpage redirected too many times.");
      }
      url = await assertPublicHttpUrl(new URL(location, url).toString());
      continue;
    }

    if (!response.ok)
      throw new Error(`The webpage returned HTTP ${response.status}.`);

    const contentType = response.headers.get("content-type") ?? "";
    if (
      !contentType.includes("text/html") &&
      !contentType.includes("text/plain")
    ) {
      throw new Error("That link did not return a public webpage.");
    }

    return {
      body: await readBoundedText(response, maxBytes),
      finalUrl: url.toString(),
      contentType,
    };
  }

  throw new Error("The webpage could not be fetched.");
}
