import { describe, expect, it } from "vitest";

import {
  collectRecordSets,
  inferFieldRoles,
  isPrivateKey,
  isPrivateValue,
  parseLooseDate,
  readGenericJson,
  toGenericRecord,
  unwrapRecord,
} from "@/lib/data-import/json-records";

import { LONG_BODY } from "./data-import-fixtures";

describe("the privacy filter", () => {
  it("refuses contact, credential, location and device fields by name", () => {
    for (const key of [
      "email",
      "emailAddress",
      "Email Address",
      "phone",
      "phoneNumber",
      "ip",
      "ip_address",
      "ipAddress",
      "street_address",
      "postcode",
      "password",
      "api_key",
      "sessionToken",
      "ssn",
      "passportNumber",
      "dateOfBirth",
      "gender",
      "latitude",
      "longitude",
      "geoLocation",
      "cardNumber",
      "iban",
      "deviceId",
      "userAgent",
      "advertisingId",
      "connections",
      "contactName",
      "recipient",
    ]) {
      expect(isPrivateKey(key)).toBe(true);
    }
  });

  it("does not refuse the fields we actually want", () => {
    for (const key of [
      "title",
      "body",
      "permalink",
      "url",
      "subreddit",
      "author",
      "created_utc",
      "savedDate",
      "id",
      "score",
    ]) {
      expect(isPrivateKey(key)).toBe(false);
    }
  });

  it("does not mistake an epoch timestamp or an id for a phone number", () => {
    // A bare ten-digit run is overwhelmingly a timestamp or an id in export
    // data. Treating it as a phone number silently discarded every
    // `created_utc` in the file.
    expect(isPrivateValue("1715505064")).toBe(false);
    expect(isPrivateValue("1900000000000000001")).toBe(false);
    expect(isPrivateValue("7100000000000000001")).toBe(false);

    // A real phone number shows a leading + or actual separators.
    expect(isPrivateValue("+14155550199")).toBe(true);
    expect(isPrivateValue("415-555-0199")).toBe(true);
    expect(isPrivateValue("(415) 555-0199")).toBe(true);
  });

  it("refuses a private value even under an innocent column name", () => {
    // This is the case a name-only blocklist misses.
    expect(isPrivateValue("someone@example.com")).toBe(true);
    expect(isPrivateValue("203.0.113.9")).toBe(true);
    expect(isPrivateValue("+1 415 555 0199")).toBe(true);
    expect(isPrivateValue("aa:bb:cc:dd:ee:ff")).toBe(true);

    expect(isPrivateValue("Why CRDTs win")).toBe(false);
    expect(isPrivateValue("https://example.com/post")).toBe(false);
  });

  it("drops a private field and says which one it dropped", () => {
    const roles = inferFieldRoles({
      title: "Why CRDTs win",
      note: "someone@example.com",
      ipAddress: "203.0.113.9",
    });

    expect(roles.title).toBe("Why CRDTs win");
    expect(roles.droppedPrivateKeys).toContain("ipAddress");
    // Caught by value shape, not by its name.
    expect(roles.droppedPrivateKeys).toContain("note");
    expect(JSON.stringify(roles)).not.toContain("someone@example.com");
    expect(JSON.stringify(roles)).not.toContain("203.0.113.9");
  });
});

describe("parseLooseDate", () => {
  it("reads the formats exports really use", () => {
    expect(parseLooseDate("2024-05-12T09:31:04Z")).toBe(
      "2024-05-12T09:31:04.000Z",
    );
    expect(parseLooseDate("2024-05-12 09:31:04 UTC")).toBe(
      "2024-05-12T09:31:04.000Z",
    );
    // Epoch seconds and milliseconds, told apart by magnitude.
    expect(parseLooseDate(1715505064)).toBe("2024-05-12T09:11:04.000Z");
    expect(parseLooseDate(1715505064000)).toBe("2024-05-12T09:11:04.000Z");
    expect(parseLooseDate("1715505064")).toBe("2024-05-12T09:11:04.000Z");
  });

  it("refuses a number that merely looks like a date", () => {
    expect(parseLooseDate(2024)).toBeNull();
    expect(parseLooseDate("42")).toBeNull();
    expect(parseLooseDate("not a date")).toBeNull();
    expect(parseLooseDate(null)).toBeNull();
  });
});

describe("field role inference", () => {
  it("separates a title from a body by name", () => {
    const roles = inferFieldRoles({
      title: "Why CRDTs win",
      selftext: LONG_BODY,
    });
    expect(roles.title).toBe("Why CRDTs win");
    expect(roles.text).toBe(LONG_BODY);
  });

  it("keeps the longest text field rather than the first", () => {
    const roles = inferFieldRoles({
      description: "short blurb",
      body: LONG_BODY,
    });
    expect(roles.text).toBe(LONG_BODY);
  });

  it("treats a long unnamed prose field as content anyway", () => {
    // Exports invent column names constantly; shape has to be enough.
    const roles = inferFieldRoles({ wysiwygPayload: LONG_BODY });
    expect(roles.text).toBe(LONG_BODY);
  });

  it("collects every URL in the record", () => {
    const roles = inferFieldRoles({
      permalink: "https://www.reddit.com/r/rust/comments/abc123/why_async/",
      url: "https://example.com/target",
    });
    expect(roles.urls).toHaveLength(2);
  });

  it("recognises authors, communities, ids and dates", () => {
    const roles = inferFieldRoles({
      author: "someone",
      subreddit: "rust",
      id: "abc123",
      created_utc: 1715505064,
    });
    expect(roles.author).toBe("someone");
    expect(roles.community).toBe("rust");
    expect(roles.ids[0]?.value).toBe("abc123");
    expect(roles.dates[0]?.iso).toBe("2024-05-12T09:11:04.000Z");
  });

  it("ignores fields that earn no role", () => {
    const roles = inferFieldRoles({ score: 42, gildings: 0, over_18: false });
    expect(roles.title).toBeNull();
    expect(roles.text).toBeNull();
    expect(roles.ignoredKeys.length).toBeGreaterThan(0);
  });
});

describe("walking an unknown document", () => {
  it("unwraps the single-key envelope some exports use", () => {
    expect(unwrapRecord({ like: { tweetId: "1" } })).toEqual({ tweetId: "1" });
    expect(unwrapRecord({ a: "1", b: "2" })).toEqual({ a: "1", b: "2" });
    expect(unwrapRecord("string")).toBeNull();
  });

  it("finds records however deeply the payload is nested", () => {
    const sets = collectRecordSets({
      meta: { version: 2 },
      data: { saved: { items: [{ url: "https://example.com/a" }] } },
    });
    expect(sets.some((set) => set.records.length === 1)).toBe(true);
    expect(sets.some((set) => set.path.includes("items"))).toBe(true);
  });

  it("never descends into a privacy-excluded branch", () => {
    const sets = collectRecordSets({
      connections: [{ email: "private@example.com" }],
      saved: [{ url: "https://example.com/a" }],
    });
    expect(JSON.stringify(sets)).not.toContain("private@example.com");
  });

  it("treats a lone object as one record", () => {
    const sets = collectRecordSets({
      url: "https://example.com/a",
      title: "A",
    });
    expect(sets[0]?.records).toHaveLength(1);
  });
});

describe("toGenericRecord", () => {
  it("takes the title from the URL slug when the record has none", () => {
    const record = toGenericRecord({
      savedItem: "https://example.com/blog/2024/05/why-rust-wins",
      savedDate: "2024-06-01",
    })!;

    expect(record.title).toBe("Why rust wins");
    // Flagged, so nothing downstream treats a decoded slug as verbatim text.
    expect(record.titleFromUrl).toBe(true);
    expect(record.url?.contentType).toBe("article");
  });

  it("prefers a stated title over one decoded from the URL", () => {
    const record = toGenericRecord({
      url: "https://example.com/blog/why-rust-wins",
      title: "Why Rust Wins On Embedded",
    })!;
    expect(record.title).toBe("Why Rust Wins On Embedded");
    expect(record.titleFromUrl).toBe(false);
  });

  it("prefers a stated date over one decoded from the URL path", () => {
    const record = toGenericRecord({
      url: "https://example.com/blog/2024/05/12/post",
      savedDate: "2025-01-02T00:00:00Z",
    })!;
    expect(record.date).toBe("2025-01-02T00:00:00.000Z");
  });

  it("falls back to the URL path date when the record states none", () => {
    const record = toGenericRecord({
      url: "https://example.com/blog/2024/05/12/post",
    })!;
    expect(record.date).toBe("2024-05-12T00:00:00.000Z");
  });

  it("picks the most informative URL when a record has several", () => {
    const record = toGenericRecord({
      shareUrl: "https://example.com/",
      permalink: "https://www.reddit.com/r/rust/comments/abc123/why_async/",
    })!;
    // The one carrying a stable id wins over a bare homepage.
    expect(record.url?.contentId).toBe("abc123");
    expect(record.contentId).toBe("abc123");
  });

  it("reads a field buried one level down", () => {
    const record = toGenericRecord({
      id: "1",
      content: { body: LONG_BODY },
      links: { permalink: "https://example.com/post" },
    })!;
    expect(record.text).toBe(LONG_BODY);
    expect(record.url?.canonicalUrl).toBe("https://example.com/post");
  });

  it("returns null for a record with nothing usable in it", () => {
    expect(toGenericRecord({ score: 1, flag: true })).toBeNull();
    expect(toGenericRecord(null)).toBeNull();
    expect(toGenericRecord([1, 2, 3])).toBeNull();
  });
});

describe("readGenericJson", () => {
  it("reads an export shape nobody wrote a parser for", () => {
    const text = JSON.stringify({
      exportVersion: "3",
      bookmarks: [
        {
          bookmarkId: "b1",
          target: "https://www.reddit.com/r/rust/comments/abc123/why_async/",
          savedOn: "2025-05-12 09:31:04 UTC",
          note: "read later",
        },
        {
          bookmarkId: "b2",
          target: "https://example.com/blog/2024/05/local-first-sync",
          savedOn: 1715505064,
        },
      ],
    });

    const result = readGenericJson(text);
    expect(result.records).toHaveLength(2);
    expect(result.records[0]!.url?.community).toBe("rust");
    expect(result.records[0]!.date).toBe("2025-05-12T09:31:04.000Z");
    expect(result.records[1]!.title).toBe("Local first sync");
  });

  it("keeps private fields out of the result and names them", () => {
    const text = JSON.stringify([
      {
        url: "https://example.com/a",
        title: "A post",
        authorEmail: "private@example.com",
        viewerIp: "203.0.113.9",
      },
    ]);

    const result = readGenericJson(text);
    expect(result.records).toHaveLength(1);
    expect(JSON.stringify(result.records)).not.toContain("private@example.com");
    expect(JSON.stringify(result.records)).not.toContain("203.0.113.9");
    expect(result.droppedPrivateKeys).toContain("authorEmail");
    expect(result.droppedPrivateKeys).toContain("viewerIp");
  });

  it("returns nothing rather than throwing on malformed JSON", () => {
    expect(readGenericJson("{not json").records).toHaveLength(0);
    expect(readGenericJson("").records).toHaveLength(0);
  });

  it("does not execute anything it reads", () => {
    // The payload is data. It is parsed, never evaluated.
    const text = JSON.stringify([
      {
        url: "https://example.com/a",
        title: "<script>globalThis.__pwned = true</script>",
      },
    ]);
    const result = readGenericJson(text);

    expect(result.records[0]!.title).toContain("<script>");
    expect((globalThis as Record<string, unknown>).__pwned).toBeUndefined();
  });
});
