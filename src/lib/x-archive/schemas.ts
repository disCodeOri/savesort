import { z } from "zod";

/**
 * Wire format for records the browser has already parsed.
 *
 * The client does the extraction, so nothing it sends is trusted: every field
 * is validated here, and the server re-derives anything that affects cost or
 * safety (content availability, embedding eligibility, canonical URL) rather
 * than accepting the client's word for it.
 */

export const MAX_BATCH_RECORDS = 200;
const MAX_TEXT = 10_000;

const postId = z
  .string()
  .trim()
  .regex(/^\d{1,25}$/, "Post ids are numeric.");

/** Must be an x.com status permalink; anything else is rejected outright. */
const canonicalUrl = z
  .string()
  .trim()
  .max(300)
  .regex(
    /^https:\/\/x\.com\/[A-Za-z0-9_]{1,20}\/status\/\d{1,25}$/,
    "Unexpected post URL.",
  );

export const relationshipSchema = z.object({
  type: z.enum([
    "bookmark",
    "like",
    "own_post",
    "repost",
    "reply",
    "quote_post",
  ]),
  timestamp: z.iso.datetime().nullable().optional(),
});

export const archiveRecordSchema = z.object({
  postId,
  canonicalUrl,
  text: z.string().max(MAX_TEXT).nullable().optional(),
  authorUsername: z.string().trim().max(20).nullable().optional(),
  authorName: z.string().trim().max(120).nullable().optional(),
  createdAt: z.iso.datetime().nullable().optional(),
  conversationId: z.string().trim().max(32).nullable().optional(),
  replyToPostId: z.string().trim().max(32).nullable().optional(),
  quotedPostId: z.string().trim().max(32).nullable().optional(),
  hashtags: z.array(z.string().trim().max(140)).max(50).default([]),
  mentions: z.array(z.string().trim().max(20)).max(50).default([]),
  externalUrls: z.array(z.string().trim().max(2_000)).max(20).default([]),
  mediaUrls: z.array(z.string().trim().max(2_000)).max(20).default([]),
  relationships: z.array(relationshipSchema).min(1).max(6),
});

export const startImportSchema = z.object({
  archiveName: z.string().trim().min(1).max(255),
  archiveSizeBytes: z
    .number()
    .int()
    .min(0)
    .max(8 * 1024 * 1024 * 1024),
  filesDetected: z.number().int().min(0).max(100_000),
  archiveUsername: z.string().trim().max(20).nullable().optional(),
  archiveUserId: z.string().trim().max(32).nullable().optional(),
});

export const batchSchema = z.object({
  importId: z.uuid(),
  records: z.array(archiveRecordSchema).min(1).max(MAX_BATCH_RECORDS),
});

export const completeImportSchema = z.object({
  importId: z.uuid(),
  filesProcessed: z.number().int().min(0).max(100_000),
  filesSkipped: z.number().int().min(0).max(100_000),
  recordsDiscovered: z.number().int().min(0).max(5_000_000),
  // Free-text messages the client generated; capped and never echoed back to
  // other users.
  warnings: z.array(z.string().max(300)).max(100).default([]),
  failed: z.boolean().default(false),
});

export type ArchiveRecordInput = z.infer<typeof archiveRecordSchema>;
