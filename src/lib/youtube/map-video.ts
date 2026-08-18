import { buildSearchableText } from "@/lib/search/searchable-text";
import { normalizeUrl } from "@/lib/urls/normalize";
import type { YouTubeVideo } from "@/lib/youtube/types";

const MAX_DESCRIPTION_LENGTH = 500;
const MAX_PROVIDER_TAGS = 12;

export interface YouTubeProviderMetadata {
  videoId: string;
  channelTitle: string | null;
  publishedAt: string | null;
  durationIso: string | null;
  viewCount: number | null;
  providerTags: string[];
  /** Set by the enrichment pass once Gemini has analysed the video. */
  analysisModel?: string;
}

export interface YouTubeProviderItem {
  url: string;
  normalized_url: string;
  video_id: string;
  playlist_id: string | null;
  source: "youtube";
  title: string;
  description: string | null;
  content: string | null;
  author: string | null;
  thumbnail_url: string | null;
  tags: string[];
  metadata: { youtube: YouTubeProviderMetadata };
  searchable_text: string;
}

export function youtubeWatchUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

function collapse(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function excerpt(value: string | null): string | null {
  if (!value) return null;
  const collapsed = collapse(value);
  if (!collapsed) return null;
  if (collapsed.length <= MAX_DESCRIPTION_LENGTH) return collapsed;
  return `${collapsed.slice(0, MAX_DESCRIPTION_LENGTH - 1).trimEnd()}…`;
}

/**
 * Maps official YouTube metadata into a saved item. The description is kept
 * short here because the full searchable body comes from the Gemini analysis
 * during enrichment, not from the uploader's description text.
 */
export function mapYouTubeVideo(
  video: YouTubeVideo,
  playlistId: string | null,
): YouTubeProviderItem {
  const url = normalizeUrl(youtubeWatchUrl(video.videoId));
  const tags = [...new Set(video.tags.map(collapse).filter(Boolean))].slice(
    0,
    MAX_PROVIDER_TAGS,
  );

  const item: YouTubeProviderItem = {
    url,
    normalized_url: url,
    video_id: video.videoId,
    playlist_id: playlistId,
    source: "youtube",
    title: collapse(video.title) || video.videoId,
    description: excerpt(video.description),
    // Left null on import so a re-sync never overwrites an existing analysis.
    content: null,
    author: video.channelTitle,
    thumbnail_url: video.thumbnailUrl,
    tags,
    metadata: {
      youtube: {
        videoId: video.videoId,
        channelTitle: video.channelTitle,
        publishedAt: video.publishedAt,
        durationIso: video.durationIso,
        viewCount: video.viewCount,
        providerTags: tags,
      },
    },
    searchable_text: "",
  };
  item.searchable_text = buildSearchableText(item);
  return item;
}

/**
 * The searchable document once Gemini has described the video. This is what
 * makes a video findable by a concept that never appears in its title.
 */
export function buildEnrichedSearchableText(
  item: {
    title: string | null;
    author: string | null;
    description: string | null;
    tags: string[];
  },
  analysis: string,
): string {
  return buildSearchableText({
    title: item.title,
    source: "youtube",
    author: item.author,
    description: item.description,
    tags: item.tags,
    content: analysis,
  });
}
