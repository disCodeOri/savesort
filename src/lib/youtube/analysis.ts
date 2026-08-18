import "server-only";

import { GoogleGenAI } from "@google/genai";

import { getYouTubeAnalysisModel } from "@/lib/env";
import { youtubeWatchUrl } from "@/lib/youtube/map-video";

const MAX_ANALYSIS_CHARACTERS = 10_000;

/**
 * Asks for retrieval-oriented prose rather than a viewer-facing summary: the
 * output is only ever indexed, so naming concepts, tools and problems matters
 * far more than readability.
 */
const ANALYSIS_PROMPT = `Describe this video so it can be found later by someone searching with a vague memory of it.

Write plain prose, no headings or bullet points. Cover:
- what the video is about and what actually happens in it
- the specific topics, technologies, tools, people, and places named
- the problems discussed and the conclusions reached
- concepts a viewer might remember without recalling the title

Use concrete terms rather than generalities. Do not add commentary about the video's quality, and do not mention that you are describing a video.`;

export type AnalysisOutcome =
  | { status: "ready"; analysis: string; model: string }
  /** The video cannot be analysed at all — private, deleted, or region locked. */
  | { status: "unsupported"; error: string }
  | { status: "failed"; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Google reports an unplayable video as an invalid-argument style failure.
 * Those are permanent for that video, so they must not be retried forever.
 */
function isUnsupportedVideoError(error: unknown): boolean {
  const message =
    isRecord(error) && typeof error.message === "string"
      ? error.message.toLowerCase()
      : String(error).toLowerCase();
  return (
    message.includes("invalid_argument") ||
    message.includes("invalid argument") ||
    message.includes("unsupported") ||
    message.includes("not accessible") ||
    message.includes("permission")
  );
}

/**
 * Sends the public video URL to Gemini for analysis. Nothing is downloaded and
 * no OAuth token is involved — the model fetches the public video itself.
 */
export async function analyzeYouTubeVideo(
  videoId: string,
): Promise<AnalysisOutcome> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return { status: "failed", error: "Video analysis is not configured." };
  }

  const model = getYouTubeAnalysisModel();
  try {
    const client = new GoogleGenAI({ apiKey });
    const response = await client.models.generateContent({
      model,
      contents: [
        {
          role: "user",
          parts: [
            { fileData: { fileUri: youtubeWatchUrl(videoId) } },
            { text: ANALYSIS_PROMPT },
          ],
        },
      ],
    });

    const analysis = response.text?.trim();
    if (!analysis) {
      return { status: "failed", error: "Video analysis returned no result." };
    }
    return {
      status: "ready",
      analysis: analysis.slice(0, MAX_ANALYSIS_CHARACTERS),
      model,
    };
  } catch (error) {
    if (isUnsupportedVideoError(error)) {
      return {
        status: "unsupported",
        error: "This video could not be analysed.",
      };
    }
    return {
      status: "failed",
      error: "Video analysis is temporarily unavailable.",
    };
  }
}
