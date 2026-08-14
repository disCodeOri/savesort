import type { Source } from "@/lib/sources/detect-source";

export interface SavedItem {
  id: string;
  url: string;
  normalized_url: string;
  source: Source;
  title: string | null;
  description: string | null;
  notes: string | null;
  content: string | null;
  author: string | null;
  thumbnail_url: string | null;
  tags: string[];
  metadata: Record<string, unknown>;
  indexing_status: "ready" | "keyword_only" | "pending" | "failed";
  indexing_error?: string | null;
  created_at: string;
  updated_at: string;
  keyword_rank?: number | null;
  semantic_rank?: number | null;
  similarity?: number | null;
  combined_score?: number | null;
}
