import {
  Camera,
  Code2,
  Globe2,
  MessageCircle,
  Package,
  Play,
} from "lucide-react";

import type { Source } from "@/lib/sources/detect-source";

export const SOURCE_LABELS: Record<Source, string> = {
  github: "GitHub",
  instagram: "Instagram",
  youtube: "YouTube",
  reddit: "Reddit",
  x: "X",
  website: "Web",
  other: "Other",
};

export function SourceIcon({
  source,
  size = 22,
}: {
  source: Source;
  size?: number;
}) {
  if (source === "github") return <Code2 size={size} />;
  if (source === "instagram") return <Camera size={size} />;
  if (source === "youtube") return <Play size={size} fill="currentColor" />;
  if (source === "reddit") return <MessageCircle size={size} />;
  if (source === "x")
    return (
      <span className="x-icon" style={{ fontSize: size }}>
        𝕏
      </span>
    );
  if (source === "other") return <Package size={size} />;
  return <Globe2 size={size} />;
}
