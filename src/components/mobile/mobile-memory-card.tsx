"use client";

import { ArrowUpRight, Check, Copy, Play } from "lucide-react";
import { useState } from "react";

import { SourceIcon, SOURCE_LABELS } from "@/components/source-icon";
import type { SavedItem } from "@/lib/items/types";
import { resultMatchLabel } from "@/lib/search/match-label";

function domainOf(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export function MobileMemoryCard({
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

  function handleCardClick(e: React.MouseEvent) {
    const target = e.target as HTMLElement;
    if (target.closest("a") || target.closest("button")) return;
    if (onSelect) onSelect(item);
  }

  const isVideo = item.source === "youtube";
  const matchLabel = resultMatchLabel(item);

  return (
    <article
      className={`mobile-recent-memory-card source-${item.source} ${isVideo ? "memory-has-thumb" : ""}`}
      onClick={handleCardClick}
      tabIndex={onSelect ? 0 : undefined}
      onKeyDown={(e) => {
        if (onSelect && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          onSelect(item);
        }
      }}
    >
      {/* 1. Header: Source Label + Match Badge */}
      <div className="mobile-memory-header">
        <div className="mobile-memory-source">
          <div className="mobile-memory-icon-wrap">
            <SourceIcon source={item.source} size={15} />
          </div>
          <span className="mobile-memory-source-name">
            {SOURCE_LABELS[item.source]}
          </span>
        </div>

        {matchLabel && (
          <span className="mobile-memory-match-badge">{matchLabel}</span>
        )}
      </div>

      {/* 2. Main Content Layout (Side-by-side thumbnail if video) */}
      <div className="mobile-memory-main-row">
        <div className="mobile-memory-text-col">
          <h3 className="mobile-memory-title">
            <a
              href={item.url}
              target="_blank"
              rel="noreferrer"
              onClick={(e) => e.stopPropagation()}
            >
              {item.title || domainOf(item.url)}
            </a>
          </h3>

          {item.description || item.content ? (
            <p className="mobile-memory-excerpt">
              {item.description || item.content?.slice(0, 110)}
            </p>
          ) : null}

          {/* Tags */}
          {item.tags.length > 0 && (
            <div className="mobile-memory-tags">
              {item.tags.slice(0, 3).map((tag) => (
                <span key={tag} className="mobile-memory-tag-chip">
                  #{tag}
                </span>
              ))}
            </div>
          )}
        </div>

        {/* Right Video Thumbnail (for YouTube/video sources) */}
        {isVideo && (
          <div className="mobile-memory-thumb-wrap">
            <div className="mobile-video-thumb-ambient" />
            <div className="mobile-video-play-disc">
              <Play size={15} fill="#0b1028" color="#0b1028" />
            </div>
          </div>
        )}
      </div>

      {/* 3. Footer Action */}
      {!isVideo && (
        <div className="mobile-memory-footer">
          <button
            type="button"
            className="mobile-card-copy-btn"
            onClick={handleCopy}
            title="Copy URL"
            aria-label="Copy item URL"
          >
            {copied ? (
              <Check size={13} className="copied-icon" />
            ) : (
              <Copy size={13} />
            )}
          </button>

          {actions ? (
            <div onClick={(e) => e.stopPropagation()}>{actions}</div>
          ) : (
            <a
              className="mobile-card-launch-icon"
              href={item.url}
              target="_blank"
              rel="noreferrer"
              onClick={(e) => e.stopPropagation()}
              title="Open link"
              aria-label={`Open ${item.title || "saved item"}`}
            >
              <ArrowUpRight size={15} />
            </a>
          )}
        </div>
      )}
    </article>
  );
}
