import { IMPORT_LIMITS } from "@/lib/data-import/limits";
import { analyzeUrl, type UrlAnalysis } from "@/lib/urls/analyze";

/**
 * Reading an export file whose schema we have never seen.
 *
 * Platform exports change shape without warning, and users hand us JSON from
 * tools nobody here has heard of. Rather than fail, this walks arbitrary JSON,
 * finds the parts that look like records, and works out what each field *is*
 * from its name, its value shape, and whether it parses as a URL.
 *
 * Two rules govern everything below:
 *
 *   1. **Deny by default.** A field is only extracted if it earns a role. An
 *      unrecognised field is dropped, not stored "just in case".
 *   2. **Privacy first.** Contact details, credentials, locations and device
 *      history are filtered out by key name *and* by value shape, so an
 *      innocuously-named column holding an email address is still refused.
 */

/**
 * Key name tokens that must never be extracted.
 *
 * Matched against *tokens*, not raw substrings, so `viewerIp`, `viewer_ip`,
 * `IP Address` and `ip` are all caught while `page` is not mistaken for `age`.
 * The list errs towards refusing: a false positive loses one field, a false
 * negative leaks personal data into a search index.
 */
const PRIVATE_TOKENS = new Set([
  "email",
  "mail",
  "emails",
  "phone",
  "phones",
  "mobile",
  "msisdn",
  "whatsapp",
  "telephone",
  "ip",
  "ipaddress",
  "ipv4",
  "ipv6",
  "address",
  "addresses",
  "street",
  "postcode",
  "postal",
  "zip",
  "zipcode",
  "city",
  "country",
  "region",
  "timezone",
  "password",
  "passwd",
  "secret",
  "token",
  "apikey",
  "credential",
  "credentials",
  "session",
  "cookie",
  "auth",
  "ssn",
  "nationalid",
  "passport",
  "license",
  "licence",
  "taxid",
  "birth",
  "birthday",
  "birthdate",
  "dob",
  "age",
  "gender",
  "ethnicity",
  "religion",
  "orientation",
  "latitude",
  "longitude",
  "lat",
  "lng",
  "lon",
  "geo",
  "geolocation",
  "coordinates",
  "location",
  "card",
  "iban",
  "swift",
  "routing",
  "payment",
  "billing",
  "invoice",
  "device",
  "devices",
  "useragent",
  "imei",
  "advertising",
  "advertiser",
  "contact",
  "contacts",
  "connection",
  "connections",
  "friend",
  "friends",
  "follower",
  "followers",
  "recipient",
  "recipients",
  "participant",
  "participants",
]);

/** Whole-key patterns, for spellings tokenising alone would miss. */
const PRIVATE_KEY_PATTERNS = [
  /e?mail/i,
  /ip_?addr/i,
  /user_?agent/i,
  /date_?of_?birth/i,
  /credit_?card|card_?number|account_?number/i,
  /api[_-]?key/i,
];

/** Splits `viewerIp`, `viewer_ip` and `Viewer IP` alike into tokens. */
export function tokenizeKey(key: string): string[] {
  return key
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .map((token) => token.toLowerCase())
    .filter(Boolean);
}

/**
 * Value shapes that are private no matter what the column is called.
 *
 * A phone number must show a leading `+` or real separators. A bare run of
 * digits is deliberately NOT treated as one: in export data a ten-digit number
 * is overwhelmingly an epoch timestamp or an id, and refusing those would
 * quietly discard every `created_utc` in the file.
 */
const PRIVATE_VALUE_PATTERNS = [
  // Email address.
  /^[^\s@]+@[^\s@]{2,}\.[a-z]{2,}$/i,
  // International phone number.
  /^\+\d[\d\s().-]{6,}$/,
  // Separated national phone number.
  /^\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}$/,
  // IPv4 address.
  /^(?:\d{1,3}\.){3}\d{1,3}$/,
  // MAC address.
  /^[0-9a-f]{2}(?::[0-9a-f]{2}){5}$/i,
];

/** Key names that name the thing rather than describe it. */
const TITLE_KEYS =
  /^(?:title|name|heading|subject|headline|jobtitle|posttitle|displayname)$/i;
const TEXT_KEYS =
  /^(?:body|text|content|message|commentary|description|selftext|caption|note|notes|summary|excerpt|comment|sharecommentary)$/i;
const URL_KEYS =
  /(?:url|link|permalink|href|uri|address)$|^(?:saveditem|shareLink|articlelink|joburl)/i;
const ID_KEYS = /^(?:id|.*_id|.*id|guid|uuid|key|slug|fullname|urn)$/i;
const AUTHOR_KEYS =
  /^(?:author|username|user|screenname|handle|creator|owner|by|postedby|from)$/i;
const COMMUNITY_KEYS =
  /^(?:subreddit|community|group|channel|company|companyname|publication|board|category|topic|source)$/i;
/**
 * `created_utc`, `savedOn` and `created_at` all name a date, so the token may
 * appear anywhere. Bare `at` stays anchored, because `status`, `category` and
 * `author` all contain it.
 */
const DATE_KEYS =
  /(?:date|timestamp|created|updated|modified|published|posted|saved|added|time)/i;
const DATE_SUFFIX_KEYS = /(?:_at|At)$/;
/**
 * A value shaped unmistakably like a date, for columns whose name gives
 * nothing away — `bookmarkedOn`, `when`, `stamp`. Restricted to written dates:
 * a bare epoch number is too easily an id to accept without a key hint.
 */
const DATE_VALUE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}|$)/;

const MAX_DEPTH = 6;
const MAX_TITLE = 300;
const MAX_TEXT = 10_000;
/** Below this, a string is a label; above it, it is prose. */
const TEXT_MIN_LENGTH = 40;

export interface JsonFieldRoles {
  title: string | null;
  text: string | null;
  urls: string[];
  author: string | null;
  community: string | null;
  /** Every parseable date found, newest role wins at the call site. */
  dates: Array<{ key: string; iso: string }>;
  ids: Array<{ key: string; value: string }>;
  /** Keys that were recognised as private and deliberately dropped. */
  droppedPrivateKeys: string[];
  /** Keys that earned no role at all. */
  ignoredKeys: string[];
}

export function isPrivateKey(key: string): boolean {
  if (PRIVATE_KEY_PATTERNS.some((pattern) => pattern.test(key))) return true;
  return tokenizeKey(key).some((token) => PRIVATE_TOKENS.has(token));
}

export function isPrivateValue(value: string): boolean {
  const trimmed = value.trim();
  return PRIVATE_VALUE_PATTERNS.some((pattern) => pattern.test(trimmed));
}

/**
 * Parses the date formats exports actually use.
 *
 * Covers ISO, `2024-01-02 15:04:05 UTC`, and epoch seconds or milliseconds.
 * Anything ambiguous becomes null rather than a plausible-looking guess.
 */
export function parseLooseDate(value: unknown): string | null {
  if (typeof value === "number") {
    // A short number is a count, a year or an index — never an epoch. The
    // floor is 1e8, which is 1973 in seconds.
    if (!Number.isFinite(value) || value < 1e8) return null;
    // Seconds and milliseconds are told apart by magnitude: a 10-digit number
    // is seconds well into the future as milliseconds.
    const millis = value > 1e11 ? value : value * 1000;
    if (millis > 4e12) return null;
    const date = new Date(millis);
    return Number.isNaN(date.valueOf()) ? null : date.toISOString();
  }

  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  if (/^\d{9,13}$/.test(trimmed)) return parseLooseDate(Number(trimmed));
  // A bare year, or a number that merely looks date-ish, is not a date.
  if (/^\d{1,8}$/.test(trimmed)) return null;

  const direct = new Date(trimmed);
  if (!Number.isNaN(direct.valueOf())) return direct.toISOString();

  const cleaned = trimmed.replace(/\s+UTC$/i, "Z").replace(" ", "T");
  const parsed = new Date(cleaned);
  return Number.isNaN(parsed.valueOf()) ? null : parsed.toISOString();
}

function asString(value: unknown): string | null {
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function looksLikeUrl(value: string): boolean {
  return /^https?:\/\/\S+$/i.test(value);
}

/**
 * Works out what each field of one record is for.
 *
 * Key name is the first signal, value shape the second. A field that looks
 * private by either measure is dropped and named in `droppedPrivateKeys`, so
 * the filtering is auditable rather than silent.
 */
export function inferFieldRoles(
  record: Record<string, unknown>,
): JsonFieldRoles {
  const roles: JsonFieldRoles = {
    title: null,
    text: null,
    urls: [],
    author: null,
    community: null,
    dates: [],
    ids: [],
    droppedPrivateKeys: [],
    ignoredKeys: [],
  };

  for (const [key, raw] of Object.entries(record)) {
    if (isPrivateKey(key)) {
      roles.droppedPrivateKeys.push(key);
      continue;
    }

    const value = asString(raw);
    if (value === null) {
      if (raw !== null && raw !== undefined) roles.ignoredKeys.push(key);
      continue;
    }
    if (isPrivateValue(value)) {
      roles.droppedPrivateKeys.push(key);
      continue;
    }

    if (looksLikeUrl(value)) {
      if (!roles.urls.includes(value)) roles.urls.push(value.slice(0, 2_000));
      continue;
    }

    if (URL_KEYS.test(key) && value.startsWith("/")) {
      // A bare path is still a link; the caller resolves it against a host.
      if (!roles.urls.includes(value)) roles.urls.push(value.slice(0, 2_000));
      continue;
    }

    if (
      DATE_KEYS.test(key) ||
      DATE_SUFFIX_KEYS.test(key) ||
      DATE_VALUE.test(value)
    ) {
      const iso = parseLooseDate(raw);
      if (iso) {
        roles.dates.push({ key, iso });
        continue;
      }
    }

    if (AUTHOR_KEYS.test(key)) {
      roles.author ??= value.slice(0, 120);
      continue;
    }

    if (COMMUNITY_KEYS.test(key)) {
      roles.community ??= value.slice(0, 120);
      continue;
    }

    if (TEXT_KEYS.test(key)) {
      // The longest text-shaped field wins; a short "description" should not
      // displace a full post body.
      if (!roles.text || value.length > roles.text.length) {
        roles.text = value.slice(0, MAX_TEXT);
      }
      continue;
    }

    if (TITLE_KEYS.test(key)) {
      roles.title ??= value.slice(0, MAX_TITLE);
      continue;
    }

    if (ID_KEYS.test(key) && value.length <= 200) {
      roles.ids.push({ key, value });
      continue;
    }

    // Unnamed prose still counts: exports invent column names constantly, and
    // a long free-text field is content whatever it is called.
    if (value.length >= TEXT_MIN_LENGTH && /\s/.test(value)) {
      if (!roles.text || value.length > roles.text.length) {
        roles.text = value.slice(0, MAX_TEXT);
      }
      continue;
    }

    roles.ignoredKeys.push(key);
  }

  return roles;
}

/**
 * Unwraps the single-key envelope several exports use, e.g. `{ like: {...} }`.
 */
export function unwrapRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;

  const keys = Object.keys(record);
  if (keys.length === 1) {
    const inner = record[keys[0]!];
    if (inner && typeof inner === "object" && !Array.isArray(inner)) {
      return inner as Record<string, unknown>;
    }
  }
  return record;
}

/**
 * Flattens one level of nesting into `parent.child` keys.
 *
 * Exports routinely bury the interesting field one level down — `entities.urls`
 * or `content.body` — and a flat view lets the role rules see it without any
 * schema knowledge.
 */
function flattenOnce(
  record: Record<string, unknown>,
  depth: number,
  dropped: string[],
): Record<string, unknown> {
  if (depth >= MAX_DEPTH) return record;
  const flat: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(record)) {
    // Refused here as well as in `inferFieldRoles`, so a private branch is
    // never even flattened — but recorded either way, because a filter that
    // drops data silently cannot be audited.
    if (isPrivateKey(key)) {
      dropped.push(key);
      continue;
    }

    if (value && typeof value === "object" && !Array.isArray(value)) {
      for (const [childKey, childValue] of Object.entries(
        value as Record<string, unknown>,
      )) {
        if (isPrivateKey(childKey)) {
          dropped.push(`${key}.${childKey}`);
          continue;
        }
        if (childValue === null || typeof childValue === "object") continue;
        flat[`${key}.${childKey}`] = childValue;
        // The bare child name is also offered, so `content.body` can match the
        // `body` rule rather than needing a `content.body` rule.
        flat[childKey] ??= childValue;
      }
      continue;
    }

    if (Array.isArray(value)) {
      // Arrays of scalars become one joined string; arrays of objects are left
      // to the record walker.
      const scalars = value.filter(
        (entry) => typeof entry === "string" || typeof entry === "number",
      );
      if (scalars.length > 0) flat[key] = scalars.slice(0, 50).join(", ");
      continue;
    }

    flat[key] = value;
  }

  return flat;
}

export interface JsonRecordSet {
  /** Where in the document the records were found, for the report. */
  path: string;
  records: Array<Record<string, unknown>>;
}

/**
 * Finds the record-bearing arrays in an arbitrary JSON document.
 *
 * Exports nest their payload unpredictably — a top-level array, a single keyed
 * array, or several arrays side by side. Every array of objects is collected,
 * deepest-first, so a wrapper object around the real data is not mistaken for
 * the data.
 */
export function collectRecordSets(
  value: unknown,
  path = "$",
  depth = 0,
  found: JsonRecordSet[] = [],
): JsonRecordSet[] {
  if (depth > MAX_DEPTH || found.length > 50) return found;

  if (Array.isArray(value)) {
    const objects = value.filter(
      (entry) => entry && typeof entry === "object" && !Array.isArray(entry),
    ) as Array<Record<string, unknown>>;

    if (objects.length > 0) {
      found.push({
        path,
        records: objects.slice(0, IMPORT_LIMITS.maxRowsPerFile),
      });
    }
    return found;
  }

  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const nested = Object.entries(record).filter(
      ([, child]) => child && typeof child === "object",
    );

    for (const [key, child] of nested) {
      // A privacy-excluded branch is never descended into at all.
      if (isPrivateKey(key)) continue;
      collectRecordSets(child, `${path}.${key}`, depth + 1, found);
    }

    // A lone object with no nested arrays is itself one record.
    if (found.length === 0 && Object.keys(record).length > 0) {
      found.push({ path, records: [record] });
    }
  }

  return found;
}

export interface GenericRecord {
  roles: JsonFieldRoles;
  /** The best URL in the record, already analysed. */
  url: UrlAnalysis | null;
  /** Title from the record, else decoded from the URL slug. */
  title: string | null;
  titleFromUrl: boolean;
  text: string | null;
  author: string | null;
  community: string | null;
  /** The most specific date the record carried. */
  date: string | null;
  contentId: string | null;
}

/**
 * Reduces one arbitrary record to the fields GRAPPlin can actually use.
 *
 * The URL does double duty: it is the identity, and when the record carried no
 * title of its own the URL's slug supplies one. That is flagged with
 * `titleFromUrl` so nothing downstream treats a decoded slug as verbatim text.
 */
export function toGenericRecord(raw: unknown): GenericRecord | null {
  const unwrapped = unwrapRecord(raw);
  if (!unwrapped) return null;

  const droppedWhileFlattening: string[] = [];
  const flat = flattenOnce(unwrapped, 0, droppedWhileFlattening);
  const roles = inferFieldRoles(flat);
  roles.droppedPrivateKeys = [
    ...new Set([...droppedWhileFlattening, ...roles.droppedPrivateKeys]),
  ];

  // The most informative URL wins, not merely the first one.
  const analyses = roles.urls
    .map((candidate) => analyzeUrl(candidate))
    .filter((analysis) => analysis.confidence !== "none");
  const rank = { high: 3, medium: 2, low: 1, none: 0 } as const;
  const url =
    analyses.sort((a, b) => rank[b.confidence] - rank[a.confidence])[0] ?? null;

  const titleFromUrl = !roles.title && Boolean(url?.titleFromSlug);
  const title = roles.title ?? url?.titleFromSlug ?? null;

  if (!url && !title && !roles.text) return null;

  return {
    roles,
    url,
    title,
    titleFromUrl,
    text: roles.text,
    author: roles.author ?? url?.author ?? null,
    community: roles.community ?? url?.community ?? null,
    // A date the record stated beats one decoded from the URL path.
    date: roles.dates[0]?.iso ?? url?.dateFromPath ?? null,
    contentId: url?.contentId ?? roles.ids[0]?.value ?? null,
  };
}

/**
 * Reads a whole JSON document into generic records.
 *
 * Used when a file in an export matches no known dataset shape: rather than
 * skip it, we take whatever it will honestly give up.
 */
export function readGenericJson(text: string): {
  records: GenericRecord[];
  /** Private fields refused across the whole document, for the report. */
  droppedPrivateKeys: string[];
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { records: [], droppedPrivateKeys: [] };
  }

  const sets = collectRecordSets(parsed);
  const records: GenericRecord[] = [];
  const dropped = new Set<string>();

  for (const set of sets) {
    for (const entry of set.records) {
      if (records.length >= IMPORT_LIMITS.maxRowsPerFile) break;
      const record = toGenericRecord(entry);
      if (!record) continue;
      for (const key of record.roles.droppedPrivateKeys) dropped.add(key);
      records.push(record);
    }
  }

  return { records, droppedPrivateKeys: [...dropped] };
}
