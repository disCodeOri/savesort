import { describe, expect, it } from "vitest";

import {
  buildNoteSearchableText,
  hashContent,
  noteFolder,
  noteTitle,
  obsidianOpenUrl,
} from "@/lib/obsidian/markdown";
import { relativePathSchema } from "@/lib/obsidian/schemas";

describe("note titles and folders", () => {
  it("uses the file name as the title, as Obsidian does", () => {
    expect(noteTitle("Projects/My Project/Notes.md")).toBe("Notes");
    expect(noteTitle("Inbox.md")).toBe("Inbox");
  });

  it("keeps unicode file names intact", () => {
    expect(noteTitle("日記/2026年の目標.md")).toBe("2026年の目標");
    expect(noteFolder("日記/2026年の目標.md")).toBe("日記");
  });

  it("reports the vault-relative folder, or nothing at the root", () => {
    expect(noteFolder("Projects/My Project/Notes.md")).toBe(
      "Projects/My Project",
    );
    expect(noteFolder("Inbox.md")).toBeNull();
  });
});

describe("obsidianOpenUrl", () => {
  it("builds a link that opens the note in Obsidian", () => {
    const url = new URL(obsidianOpenUrl("My Vault", "Projects/Notes.md"));

    expect(url.protocol).toBe("obsidian:");
    expect(url.searchParams.get("vault")).toBe("My Vault");
    expect(url.searchParams.get("file")).toBe("Projects/Notes");
  });
});

describe("hashContent", () => {
  it("is stable for identical content and differs for a single edit", () => {
    expect(hashContent("# Hello")).toBe(hashContent("# Hello"));
    expect(hashContent("# Hello")).not.toBe(hashContent("# Hello "));
    expect(hashContent("# Hello")).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("buildNoteSearchableText", () => {
  it("indexes the title, folder and body", () => {
    const text = buildNoteSearchableText(
      "Projects/Alpha/Kickoff.md",
      "Meeting notes about the launch.",
    );

    expect(text).toContain("Title: Kickoff");
    expect(text).toContain("Source: obsidian");
    expect(text).toContain("Description: Projects/Alpha");
    expect(text).toContain("Content: Meeting notes about the launch.");
  });

  it("caps the indexed text so a huge note cannot bloat the row", () => {
    const text = buildNoteSearchableText("Big.md", "x".repeat(50_000));

    expect(text.length).toBeLessThanOrEqual(12_000);
  });
});

describe("relativePathSchema", () => {
  it("accepts nested Markdown paths including unicode", () => {
    expect(
      relativePathSchema.safeParse("Projects/Alpha/Notes.md").success,
    ).toBe(true);
    expect(relativePathSchema.safeParse("日記/2026.md").success).toBe(true);
  });

  it("rejects paths that escape the vault", () => {
    expect(relativePathSchema.safeParse("../secrets.md").success).toBe(false);
    expect(relativePathSchema.safeParse("Projects/../../x.md").success).toBe(
      false,
    );
    expect(relativePathSchema.safeParse("/etc/passwd.md").success).toBe(false);
    expect(relativePathSchema.safeParse("C:/Windows/note.md").success).toBe(
      false,
    );
  });

  it("rejects files that are not Markdown in this version", () => {
    expect(relativePathSchema.safeParse("Attachments/photo.png").success).toBe(
      false,
    );
  });
});
