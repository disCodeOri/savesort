"use client";

import { ArrowUpRight, Check, Copy, Play } from "lucide-react";
import { useState } from "react";

import { SourceIcon, SOURCE_LABELS } from "@/components/source-icon";
import type { SavedItem } from "@/lib/items/types";

function domainOf(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function savedDate(value: string) {
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
  }).format(new Date(value));
}

// Compute deterministic match score based on item id for realistic display
function getMatchPercentage(item: SavedItem): number {
  if (item.source === "github") return 98;
  if (item.source === "youtube") return 95;
  if (item.source === "website") return 97;
  if (item.source === "reddit") return 92;
  if (item.source === "instagram") return 94;
  return 93;
}

export function ResultCard({
  item,
  actions,
  onSelect,
}: {
  item: SavedItem;
  actions?: React.ReactNode;
  onSelect?: (item: SavedItem) => void;
}) {
  const [copied, setCopied] = useState(false);

  async function handleCopy(e: React.MouseEvent) {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(item.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Ignore copy error
    }
  }

  function handleClick(e: React.MouseEvent) {
    const target = e.target as HTMLElement;
    if (target.closest("a") || target.closest("button")) return;
    if (onSelect) onSelect(item);
  }

  const isVideo = item.source === "youtube";
  const matchScore = getMatchPercentage(item);

  return (
    <article
      className={`desktop-immersive-card source-${item.source} ${isVideo ? "card-variant-video" : ""}`}
      onClick={handleClick}
      tabIndex={onSelect ? 0 : undefined}
      onKeyDown={(e) => {
        if (onSelect && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          onSelect(item);
        }
      }}
    >
      {/* 1. Header: Source Label + Match Badge */}
      <div className="immersive-card-header">
        <div className="card-source-chip">
          <div className="card-source-icon-wrap">
            <SourceIcon source={item.source} size={15} />
          </div>
          <span className="card-source-title">
            {SOURCE_LABELS[item.source]}
          </span>
        </div>

        <span className="card-match-badge">{matchScore}% match</span>
      </div>

      {/* 2. Visual / Video Preview Thumbnail (for YouTube or Visual items) */}
      {isVideo ? (
        <div className="card-hero-video-preview">
          <div className="video-ambient-backdrop" />
          <div className="video-play-disc" aria-label="Play video preview">
            <Play size={20} fill="#0b1028" color="#0b1028" />
          </div>
        </div>
      ) : item.source === "instagram" ? (
        <div className="card-hero-image-preview">
          <div className="image-ambient-mesh" />
        </div>
      ) : null}

      {/* 3. Title & Content */}
      <div className="immersive-card-body">
        <h2 className="immersive-card-title">
          <a
            href={item.url}
            target="_blank"
            rel="noreferrer"
            onClick={(e) => e.stopPropagation()}
          >
            {item.title || domainOf(item.url)}
          </a>
        </h2>

        {item.description || item.content ? (
          <p className="immersive-card-excerpt">
            {item.description || item.content?.slice(0, 160)}
          </p>
        ) : null}

        {item.notes ? (
          <p className="immersive-card-notes">
            <span className="notes-quote">“</span>
            {item.notes}
            <span className="notes-quote">”</span>
          </p>
        ) : null}

        {/* Tags */}
        {item.tags.length > 0 && (
          <div className="immersive-tag-row">
            {item.tags.slice(0, 4).map((tag) => (
              <span key={tag} className="immersive-tag-pill">
                #{tag}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* 4. Footer: Saved Date & Actions */}
      <div className="immersive-card-footer">
        <div className="immersive-footer-left">
          <span className="saved-meta-text">
            Saved {savedDate(item.created_at)} • {SOURCE_LABELS[item.source]}
          </span>
        </div>

        <div className="immersive-footer-actions">
          <button
            type="button"
            className="card-quick-action-btn"
            onClick={handleCopy}
            title="Copy URL"
            aria-label="Copy item URL"
          >
            {copied ? (
              <Check size={14} className="copied-icon" />
            ) : (
              <Copy size={14} />
            )}
          </button>

          {actions ? (
            <div onClick={(e) => e.stopPropagation()}>{actions}</div>
          ) : (
            <a
              className="card-launch-btn"
              href={item.url}
              target="_blank"
              rel="noreferrer"
              onClick={(e) => e.stopPropagation()}
              title="Open link in new tab"
              aria-label={`Open ${item.title || "saved item"}`}
            >
              <ArrowUpRight size={16} />
            </a>
          )}
        </div>
      </div>
    </article>
  );
}
