import { z } from "zod";

import { SOURCES } from "@/lib/sources/detect-source";

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((value) => value || undefined);

const clearableText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((value) => value || null)
    .optional();

export const createItemSchema = z.object({
  url: z.string().trim().min(1).max(2_000),
  title: optionalText(300),
  notes: optionalText(5_000),
  content: optionalText(12_000),
  tags: z
    .array(z.string().trim().min(1).max(40))
    .max(20)
    .optional()
    .default([]),
});

export const updateItemSchema = z
  .object({
    title: clearableText(300),
    notes: clearableText(5_000),
    content: clearableText(12_000),
    tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
  })
  .refine(
    (value) => Object.values(value).some((field) => field !== undefined),
    {
      message: "Provide at least one field to update.",
    },
  );

export const sourceFilterSchema = z.enum(SOURCES).optional();

export const searchSchema = z.object({
  query: z.string().trim().min(1).max(500),
  source: sourceFilterSchema,
  limit: z.number().int().min(1).max(50).optional().default(20),
});
