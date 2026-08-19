import { unzip, type Unzipped } from "fflate";

import {
  detectDataset,
  detectDatasetFromShape,
  type ArchiveDataset,
} from "@/lib/x-archive/datasets";
import {
  ARCHIVE_LIMITS,
  describeRejection,
  rejectEntryPath,
  rejectEntrySize,
} from "@/lib/x-archive/limits";
import {
  normalizeRecord,
  type NormalizedRecord,
  type RelationshipType,
} from "@/lib/x-archive/normalize";
import { parseArchiveFile } from "@/lib/x-archive/parse-file";

/**
 * Reads an X archive in the browser and produces normalized records.
 *
 * Everything happens on the user's machine: excluded datasets — direct
 * messages, contacts, device and login history, ad targeting — are filtered
 * here and never transmitted anywhere. Only allowlisted, content-bearing
 * records leave the device.
 */

export interface ArchiveFileReport {
  path: string;
  dataset: ArchiveDataset | null;
  recordCount: number;
  status: "parsed" | "skipped" | "error";
  message?: string;
}

export interface ArchiveReadResult {
  records: NormalizedRecord[];
  files: ArchiveFileReport[];
  filesDetected: number;
  filesProcessed: number;
  filesSkipped: number;
  warnings: string[];
  /** Identity of the account the archive belongs to, when it says. */
  accountUsername: string | null;
  accountUserId: string | null;
}

/** Which relationship a dataset's records represent. */
const DATASET_RELATIONSHIP: Record<ArchiveDataset, RelationshipType | null> = {
  bookmarks: "bookmark",
  likes: "like",
  // Replies, reposts and quotes all live in the post history; normalizeRecord
  // refines the specific type per record.
  posts: "own_post",
  account: null,
  profile: null,
};

function decode(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

function unzipAsync(data: Uint8Array): Promise<Unzipped> {
  return new Promise((resolve, reject) => {
    unzip(data, (error, result) => {
      if (error) reject(error);
      else resolve(result);
    });
  });
}

/** Pulls the archive owner's identity out of account/profile datasets. */
function readAccountIdentity(records: unknown[]): {
  username: string | null;
  userId: string | null;
} {
  for (const raw of records) {
    if (!raw || typeof raw !== "object") continue;
    const wrapper = Object.values(raw as Record<string, unknown>)[0];
    const entry = (
      wrapper && typeof wrapper === "object" ? wrapper : raw
    ) as Record<string, unknown>;
    const username = entry.username ?? entry.screenName ?? entry.screen_name;
    const userId = entry.accountId ?? entry.account_id ?? entry.id;
    if (typeof username === "string" || typeof userId === "string") {
      return {
        username: typeof username === "string" ? username : null,
        userId: typeof userId === "string" ? userId : null,
      };
    }
  }
  return { username: null, userId: null };
}

export class ArchiveReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArchiveReadError";
  }
}

/**
 * Reads the archive bytes and returns normalized records.
 *
 * One unreadable optional file is reported as a warning rather than failing
 * the import; only an unreadable archive, or one with no recognisable X data
 * at all, is fatal.
 */
export async function readXArchive(
  data: Uint8Array,
): Promise<ArchiveReadResult> {
  if (data.byteLength > ARCHIVE_LIMITS.maxArchiveBytes) {
    throw new ArchiveReadError("This archive is too large to process.");
  }

  let entries: Unzipped;
  try {
    entries = await unzipAsync(data);
  } catch {
    throw new ArchiveReadError(
      "This doesn't appear to be a valid X archive. Upload the ZIP provided by X.",
    );
  }

  const result: ArchiveReadResult = {
    records: [],
    files: [],
    filesDetected: 0,
    filesProcessed: 0,
    filesSkipped: 0,
    warnings: [],
    accountUsername: null,
    accountUserId: null,
  };

  let totalUncompressed = 0;
  let candidatesOpened = 0;

  for (const [path, bytes] of Object.entries(entries)) {
    // Directory entries have no content.
    if (path.endsWith("/") || bytes.byteLength === 0) continue;
    result.filesDetected += 1;

    const pathRejection = rejectEntryPath(path);
    if (pathRejection) {
      result.filesSkipped += 1;
      result.files.push({
        path,
        dataset: null,
        recordCount: 0,
        status: "skipped",
        message: describeRejection(pathRejection),
      });
      continue;
    }

    // Datasets we do not recognise — including every privacy-excluded one —
    // are never opened at all.
    const named = detectDataset(path);
    if (!named && !/\.(js|json|csv)$/i.test(path)) continue;

    const sizeRejection = rejectEntrySize(bytes.byteLength, bytes.byteLength);
    if (sizeRejection) {
      result.filesSkipped += 1;
      result.files.push({
        path,
        dataset: named?.dataset ?? null,
        recordCount: 0,
        status: "skipped",
        message: describeRejection(sizeRejection),
      });
      continue;
    }

    totalUncompressed += bytes.byteLength;
    if (totalUncompressed > ARCHIVE_LIMITS.maxTotalUncompressedBytes) {
      result.warnings.push(
        "The archive was larger than expected; some files were skipped.",
      );
      break;
    }
    if (candidatesOpened >= ARCHIVE_LIMITS.maxCandidateFiles) {
      result.warnings.push(
        "The archive contained an unusual number of files; some were skipped.",
      );
      break;
    }

    const parsed = parseArchiveFile(path, decode(bytes));
    if (parsed.error) {
      // A single corrupt optional file must not fail the whole import.
      result.filesSkipped += 1;
      result.files.push({
        path,
        dataset: named?.dataset ?? null,
        recordCount: 0,
        status: "error",
        message: parsed.error,
      });
      continue;
    }
    candidatesOpened += 1;

    // Fall back to record shape only for files the allowlist already permits.
    const match = named ?? detectDatasetFromShape(path, parsed.records);
    if (!match) continue;

    if (match.dataset === "account" || match.dataset === "profile") {
      const identity = readAccountIdentity(parsed.records);
      result.accountUsername ??= identity.username;
      result.accountUserId ??= identity.userId;
      result.filesProcessed += 1;
      result.files.push({
        path,
        dataset: match.dataset,
        recordCount: parsed.records.length,
        status: "parsed",
      });
      continue;
    }

    const relationship = DATASET_RELATIONSHIP[match.dataset];
    if (!relationship) continue;

    let kept = 0;
    for (const raw of parsed.records) {
      const record = normalizeRecord(raw, relationship, path);
      if (record) {
        result.records.push(record);
        kept += 1;
      }
    }

    result.filesProcessed += 1;
    result.files.push({
      path,
      dataset: match.dataset,
      recordCount: kept,
      status: "parsed",
    });
  }

  if (result.records.length === 0 && result.filesProcessed === 0) {
    throw new ArchiveReadError(
      "We couldn't find supported X content in this archive.",
    );
  }

  return result;
}
