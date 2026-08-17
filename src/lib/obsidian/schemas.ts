import { z } from "zod";

export const MAX_BATCH_FILES = 25;
export const MAX_NOTE_CHARACTERS = 1_000_000;

const clientId = z.string().trim().min(1).max(128);

/**
 * Vault-relative POSIX paths only. Rejecting absolute paths and parent
 * traversal keeps a compromised client from describing files outside the vault
 * the user chose.
 */
export const relativePathSchema = z
  .string()
  .trim()
  .min(1)
  .max(1_024)
  .refine((value) => !value.startsWith("/") && !/^[a-zA-Z]:/.test(value), {
    message: "Paths must be relative to the vault.",
  })
  .refine((value) => !value.split("/").includes(".."), {
    message: "Paths must stay inside the vault.",
  })
  .refine((value) => value.toLowerCase().endsWith(".md"), {
    message: "Only Markdown notes sync today.",
  });

export const registerVaultSchema = z.object({
  clientVaultId: clientId,
  name: z.string().trim().min(1).max(200),
});

export const syncFileSchema = z.object({
  clientFileId: clientId,
  relativePath: relativePathSchema,
  content: z.string().max(MAX_NOTE_CHARACTERS),
  contentHash: z
    .string()
    .trim()
    .regex(/^[a-f0-9]{64}$/, "Content hash must be a SHA-256 hex digest."),
  modifiedAt: z.iso.datetime().optional(),
  baseRevision: z.number().int().positive().nullable().optional(),
});

export const syncFilesBatchSchema = z.object({
  vaultId: z.uuid(),
  files: z.array(syncFileSchema).min(1).max(MAX_BATCH_FILES),
});

export const syncDeleteSchema = z.object({
  vaultId: z.uuid(),
  files: z
    .array(
      z.object({
        clientFileId: clientId,
        baseRevision: z.number().int().positive().nullable().optional(),
      }),
    )
    .min(1)
    .max(MAX_BATCH_FILES),
});

export const syncMoveSchema = z.object({
  vaultId: z.uuid(),
  files: z
    .array(
      z.object({
        clientFileId: clientId,
        relativePath: relativePathSchema,
        baseRevision: z.number().int().positive().nullable().optional(),
      }),
    )
    .min(1)
    .max(MAX_BATCH_FILES),
});

export type SyncFile = z.infer<typeof syncFileSchema>;
