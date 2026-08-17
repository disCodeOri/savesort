"use client";

import { useEffect, useState } from "react";
import {
  ArrowUpRight,
  CalendarDays,
  Check,
  Copy,
  FileText,
  Globe,
  Tag,
  X,
} from "lucide-react";

import { SourceIcon, SOURCE_LABELS } from "@/components/source-icon";
import type { SavedItem } from "@/lib/items/types";

function domainOf(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value));
}

export function MobileQuickViewSheet({
  item,
  onClose,
}: {
  item: SavedItem | null;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!item) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };

    window.addEventListener("keydown", handleKeyDown);
    document.body.style.overflow = "hidden";

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = "";
    };
  }, [item, onClose]);

  if (!item) return null;

  async function handleCopy() {
    if (!item) return;
    try {
      await navigator.clipboard.writeText(item.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Ignore clipboard write failure
    }
  }

  return (
    <div
      className="mobile-sheet-backdrop"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="mobile-sheet-title"
    >
      <div
        className="mobile-sheet-container"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Drag handle affordance */}
        <div className="mobile-sheet-handle-bar">
          <div className="mobile-sheet-handle" />
        </div>

        {/* Sheet Header */}
        <div className="mobile-sheet-header">
          <div className="mobile-sheet-source">
            <SourceIcon source={item.source} size={16} />
            <span>{SOURCE_LABELS[item.source]}</span>
          </div>

          <div className="mobile-sheet-top-actions">
            <button
              type="button"
              className="mobile-sheet-icon-btn mobile-glass"
              onClick={handleCopy}
              title="Copy URL"
              aria-label="Copy item URL"
            >
              {copied ? (
                <Check size={15} className="copied-icon" />
              ) : (
                <Copy size={15} />
              )}
            </button>
            <button
              type="button"
              className="mobile-sheet-close-btn"
              onClick={onClose}
              aria-label="Close sheet"
            >
              <X size={18} />
            </button>
          </div>
        </div>

        {/* Sheet Content Scrollable Area */}
        <div className="mobile-sheet-body">
          <h2 id="mobile-sheet-title" className="mobile-sheet-title">
            {item.title || domainOf(item.url)}
          </h2>

          <div className="mobile-sheet-meta-pills">
            <a
              href={item.url}
              target="_blank"
              rel="noreferrer"
              className="mobile-sheet-pill"
            >
              <Globe size={13} />
              <span>{domainOf(item.url)}</span>
              <ArrowUpRight size={12} />
            </a>

            <span className="mobile-sheet-pill">
              <CalendarDays size={13} />
              <span>{formatDate(item.created_at)}</span>
            </span>

            <span className="mobile-sheet-pill">
              <span
                className={`status-dot ${item.indexing_status === "ready" ? "status-ready" : "status-indexed"}`}
              />
              <span>
                {item.indexing_status === "ready"
                  ? "Fused & Embedded"
                  : "Keyword Indexed"}
              </span>
            </span>
          </div>

          {item.notes && (
            <div className="mobile-sheet-section mobile-sheet-notes-card">
              <h3 className="mobile-sheet-section-title">Your Notes</h3>
              <p className="mobile-sheet-notes-text">“{item.notes}”</p>
            </div>
          )}

          {item.tags.length > 0 && (
            <div className="mobile-sheet-section">
              <h3 className="mobile-sheet-section-title">
                <Tag size={13} />
                <span>Tags</span>
              </h3>
              <div className="mobile-sheet-tags-list">
                {item.tags.map((tag) => (
                  <span key={tag} className="mobile-sheet-tag">
                    #{tag}
                  </span>
                ))}
              </div>
            </div>
          )}

          {item.description && (
            <div className="mobile-sheet-section">
              <h3 className="mobile-sheet-section-title">
                <FileText size={13} />
                <span>Summary</span>
              </h3>
              <p className="mobile-sheet-desc">{item.description}</p>
            </div>
          )}

          {item.content && (
            <div className="mobile-sheet-section">
              <h3 className="mobile-sheet-section-title">Extracted Text</h3>
              <div className="mobile-sheet-code-preview">
                <pre>{item.content}</pre>
              </div>
            </div>
          )}
        </div>

        {/* Bottom Floating Action Bar */}
        <div className="mobile-sheet-footer">
          <a
            href={item.url}
            target="_blank"
            rel="noreferrer"
            className="mobile-sheet-launch-btn"
          >
            <span>Open Original Link</span>
            <ArrowUpRight size={18} />
          </a>
        </div>
      </div>
    </div>
  );
}
