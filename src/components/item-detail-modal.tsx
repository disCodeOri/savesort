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

import { MobileQuickViewSheet } from "@/components/mobile/mobile-quick-view-sheet";
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

export function ItemDetailModal({
  item,
  onClose,
}: {
  item: SavedItem | null;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const checkMobile = () => {
      setIsMobile(window.innerWidth <= 640);
    };
    checkMobile();
    window.addEventListener("resize", checkMobile);
    return () => window.removeEventListener("resize", checkMobile);
  }, []);

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

  // On mobile devices, render purpose-built bottom sheet
  if (isMobile) {
    return <MobileQuickViewSheet item={item} onClose={onClose} />;
  }

  async function handleCopy() {
    if (!item) return;
    try {
      await navigator.clipboard.writeText(item.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Ignore clipboard write failures
    }
  }

  return (
    <div
      className="detail-modal-backdrop"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="detail-modal-title"
    >
      <div className="detail-modal-card" onClick={(e) => e.stopPropagation()}>
        {/* Modal Header */}
        <div className="detail-modal-header">
          <div className="detail-source-badge">
            <SourceIcon source={item.source} size={18} />
            <span>{SOURCE_LABELS[item.source]}</span>
          </div>

          <div className="detail-header-actions">
            <button
              type="button"
              className="button button-ghost button-sm copy-link-btn"
              onClick={handleCopy}
              title="Copy URL"
            >
              {copied ? (
                <>
                  <Check size={14} className="copied-icon" />
                  <span>Copied</span>
                </>
              ) : (
                <>
                  <Copy size={14} />
                  <span>Copy Link</span>
                </>
              )}
            </button>

            <button
              type="button"
              className="detail-close-btn"
              onClick={onClose}
              aria-label="Close details"
            >
              <X size={20} />
            </button>
          </div>
        </div>

        {/* Modal Body */}
        <div className="detail-modal-body">
          <h2 id="detail-modal-title" className="detail-title">
            {item.title || domainOf(item.url)}
          </h2>

          <div className="detail-meta-row">
            <a
              href={item.url}
              target="_blank"
              rel="noreferrer"
              className="detail-domain-pill"
            >
              <Globe size={14} />
              <span>{domainOf(item.url)}</span>
              <ArrowUpRight size={13} />
            </a>

            <span className="detail-date-pill">
              <CalendarDays size={14} />
              <span>Saved {formatDate(item.created_at)}</span>
            </span>

            <span className="detail-status-pill">
              <span
                className={`status-dot ${item.indexing_status === "ready" ? "status-ready" : "status-indexed"}`}
              />
              <span>
                {item.indexing_status === "ready"
                  ? "Vector & Lexical Ready"
                  : "Keyword Indexed"}
              </span>
            </span>
          </div>

          {item.notes ? (
            <div className="detail-section detail-notes-box">
              <h3 className="detail-section-title">Your Notes</h3>
              <p className="detail-notes-text">“{item.notes}”</p>
            </div>
          ) : null}

          {item.tags.length ? (
            <div className="detail-section">
              <h3 className="detail-section-title">
                <Tag size={14} />
                <span>Tags</span>
              </h3>
              <div className="detail-tags-list">
                {item.tags.map((tag) => (
                  <span key={tag} className="detail-tag-chip">
                    #{tag}
                  </span>
                ))}
              </div>
            </div>
          ) : null}

          {item.description ? (
            <div className="detail-section">
              <h3 className="detail-section-title">
                <FileText size={14} />
                <span>Summary Excerpt</span>
              </h3>
              <p className="detail-description-text">{item.description}</p>
            </div>
          ) : null}

          {item.content ? (
            <div className="detail-section">
              <h3 className="detail-section-title">Indexed Content</h3>
              <div className="detail-content-preview">
                <pre>{item.content}</pre>
              </div>
            </div>
          ) : null}
        </div>

        {/* Modal Footer */}
        <div className="detail-modal-footer">
          <button
            type="button"
            className="button button-ghost"
            onClick={onClose}
          >
            Close
          </button>
          <a
            href={item.url}
            target="_blank"
            rel="noreferrer"
            className="button button-ink detail-launch-btn"
          >
            <span>Open Link</span>
            <ArrowUpRight size={16} />
          </a>
        </div>
      </div>
    </div>
  );
}
