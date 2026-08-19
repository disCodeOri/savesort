import { z } from "zod";

import { CATEGORY_LABELS } from "@/lib/data-import/types";

/**
 * Wire format for records the browser has already parsed.
 *
 * The client does the extraction, so nothing it sends is trusted. Every field
 * is validated here, and the server independently re-derives everything that
 * affects cost or safety — content availability, AI eligibility, the indexed
 * document — rather than taking the client's word for any of it.
 */

export const MAX_BATCH_RECORDS = 100;
export const PARSER_VERSION = "v1";

const MAX_TEXT = 10_000;
const MAX_USER_TEXT = 4_000;

export const importPlatformSchema = z.enum(["reddit", "linkedin"]);

export const importCategorySchema = z.enum(
  Object.keys(CATEGORY_LABELS) as [string, ...string[]],
);

/** Only these two hosts. A record cannot smuggle in an arbitrary destination. */
const canonicalUrlSchema = z
  .string()
  .trim()
  .min(1)
  .max(2_000)
  .refine((value) => {
    try {
      const url = new URL(value);
      if (url.protocol !== "https:") return false;
      const host = url.hostname.toLowerCase();
      return (
        host === "www.reddit.com" ||
        host === "www.linkedin.com" ||
        host === "reddit.com" ||
        host === "linkedin.com" ||
        host.endsWith(".reddit.com") ||
        host.endsWith(".linkedin.com")
      );
    } catch {
      return false;
    }
  }, "Unexpected item URL.");

const nullableText = (max: number) =>
  z.string().max(max).nullable().optional().default(null);

export const importRecordSchema = z.object({
  platform: importPlatformSchema,
  contentKey: z.string().trim().min(1).max(400),
  contentType: z.enum(["post", "comment", "job", "article", "link"]),
  sourceId: z.string().trim().max(64).nullable().optional().default(null),
  canonicalUrl: canonicalUrlSchema,
  originalUrl: nullableText(2_000),
  title: nullableText(300),
  titleSource: z
    .enum(["source", "permalink_slug", "fallback_label"])
    .nullable()
    .optional()
    .default(null),
  rawText: nullableText(MAX_TEXT),
  userText: nullableText(MAX_USER_TEXT),
  author: nullableText(120),
  community: nullableText(120),
  sourceCreatedAt: z.iso.datetime().nullable().optional().default(null),
  sourceSavedAt: z.iso.datetime().nullable().optional().default(null),
  sourceActedAt: z.iso.datetime().nullable().optional().default(null),
  externalUrl: nullableText(2_000),
  categories: z.array(importCategorySchema).min(1).max(8),
  // File names only. Contents never travel with a record.
  sourceFiles: z.array(z.string().max(300)).max(20).default([]),
});

export const startImportSchema = z.object({
  platform: importPlatformSchema,
  safeFilename: z.string().trim().min(1).max(255),
  fileSizeBytes: z
    .number()
    .int()
    .min(0)
    .max(1024 * 1024 * 1024),
  fileHash: z
    .string()
    .trim()
    .regex(/^[a-f0-9]{64}$/, "Unexpected file fingerprint.")
    .nullable()
    .optional()
    .default(null),
  selectedCategories: z.array(importCategorySchema).min(1).max(12),
  detectedCategories: z
    .record(importCategorySchema, z.number().int().min(0).max(5_000_000))
    .default({}),
  itemsDetected: z.number().int().min(0).max(5_000_000),
  itemsSelected: z.number().int().min(0).max(5_000_000),
  filesDetected: z.number().int().min(0).max(100_000),
});

export const batchSchema = z.object({
  importId: z.uuid(),
  records: z.array(importRecordSchema).min(1).max(MAX_BATCH_RECORDS),
});

export const classifySchema = z.object({
  importId: z.uuid(),
  /** Bounded per request so no single call runs long. */
  limit: z.number().int().min(1).max(20).optional().default(8),
});

export const completeImportSchema = z.object({
  importId: z.uuid(),
  filesProcessed: z.number().int().min(0).max(100_000),
  filesSkipped: z.number().int().min(0).max(100_000),
  itemsUnresolved: z.number().int().min(0).max(5_000_000),
  warnings: z.array(z.string().max(300)).max(100).default([]),
  failed: z.boolean().default(false),
});

export const revertImportSchema = z.object({ importId: z.uuid() });

export type ImportRecordInput = z.infer<typeof importRecordSchema>;
export type StartImportInput = z.infer<typeof startImportSchema>;
