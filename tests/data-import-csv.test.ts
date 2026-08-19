import { describe, expect, it } from "vitest";

import {
  cell,
  hasColumns,
  normalizeHeader,
  parseCsv,
} from "@/lib/data-import/csv";
import { IMPORT_LIMITS } from "@/lib/data-import/limits";

describe("normalizeHeader", () => {
  it("collapses every spelling of the same column onto one key", () => {
    expect(normalizeHeader("Saved Date")).toBe("saveddate");
    expect(normalizeHeader("savedDate")).toBe("saveddate");
    expect(normalizeHeader("saved_date")).toBe("saveddate");
    expect(normalizeHeader("SAVED-DATE")).toBe("saveddate");
  });
});

describe("parseCsv", () => {
  it("reads a plain table", () => {
    const table = parseCsv(
      "id,permalink\nabc,https://www.reddit.com/r/x/comments/abc/t",
    );
    expect(table.headers).toEqual(["id", "permalink"]);
    expect(table.rows).toHaveLength(1);
    expect(cell(table.rows[0]!, "permalink")).toContain("/comments/abc/");
  });

  it("strips a UTF-8 BOM from the first header", () => {
    const table = parseCsv(
      "﻿id,permalink\nabc,https://www.reddit.com/r/x/comments/abc/t",
    );
    expect(table.headers[0]).toBe("id");
    expect(cell(table.rows[0]!, "id")).toBe("abc");
  });

  it("handles CRLF endings", () => {
    const table = parseCsv("id,permalink\r\nabc,link\r\ndef,link2\r\n");
    expect(table.rows).toHaveLength(2);
    expect(cell(table.rows[1]!, "id")).toBe("def");
  });

  it("keeps newlines and commas inside quoted fields", () => {
    const table = parseCsv('id,body\n1,"line one\nline two, with comma"');
    expect(cell(table.rows[0]!, "body")).toBe("line one\nline two, with comma");
  });

  it("unescapes doubled quotes", () => {
    const table = parseCsv('id,body\n1,"she said ""hello"" loudly"');
    expect(cell(table.rows[0]!, "body")).toBe('she said "hello" loudly');
  });

  it("tolerates reordered and unknown extra columns", () => {
    const table = parseCsv("permalink,unknown_thing,id\nlink,junk,abc");
    expect(cell(table.rows[0]!, "id")).toBe("abc");
    expect(hasColumns(table, "id", "permalink")).toBe(true);
  });

  it("skips a preamble line above the header", () => {
    const table = parseCsv("Notes:\nid,permalink\nabc,link");
    expect(table.headers).toEqual(["id", "permalink"]);
    expect(table.rows).toHaveLength(1);
  });

  it("returns nothing for an empty file", () => {
    expect(parseCsv("").rows).toHaveLength(0);
    expect(parseCsv("\n\n").rows).toHaveLength(0);
  });

  it("ignores blank rows rather than emitting empty records", () => {
    const table = parseCsv("id,permalink\nabc,link\n\n\ndef,link2\n");
    expect(table.rows).toHaveLength(2);
  });

  it("truncates an absurdly large cell instead of buffering it", () => {
    const huge = "x".repeat(IMPORT_LIMITS.maxFieldCharacters + 5_000);
    const table = parseCsv(`id,body\n1,${huge}`);
    expect(table.truncated).toBe(true);
    expect(cell(table.rows[0]!, "body")!.length).toBeLessThanOrEqual(
      IMPORT_LIMITS.maxFieldCharacters,
    );
  });

  it("stops at the row cap and says so", () => {
    const rows = Array.from({ length: 30 }, (_, index) => `${index},link`).join(
      "\n",
    );
    const table = parseCsv(`id,permalink\n${rows}`, 10);
    expect(table.rows).toHaveLength(10);
    expect(table.truncated).toBe(true);
  });
});
