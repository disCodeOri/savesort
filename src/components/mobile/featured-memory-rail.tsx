"use client";

import { ChevronRight, FileText, Users } from "lucide-react";
import { useState } from "react";

export interface FeaturedMemory {
  id: string;
  author: string;
  role: string;
  title: string;
  membersCount: string;
  articlesCount: string;
  gradient: string;
  query: string;
}

const FEATURED_ITEMS: FeaturedMemory[] = [
  {
    id: "feat-1",
    author: "Guy Hawkins",
    role: "TECH BLOGGER",
    title: "Green Nature Loving",
    membersCount: "86.50K",
    articlesCount: "329 articles",
    gradient: "linear-gradient(160deg, #0e7490, #042f2e 50%, #064e3b 100%)",
    query: "environmental tech eco computing sustainable architecture",
  },
  {
    id: "feat-2",
    author: "Jerome Bell",
    role: "FASHION INFLUENCER",
    title: "It's 2024, and it's time for you to learn",
    membersCount: "31.07K",
    articlesCount: "58 articles",
    gradient: "linear-gradient(160deg, #4338ca, #312e81 50%, #1e1b4b 100%)",
    query: "modern web trends design systems nextjs spring physics",
  },
  {
    id: "feat-3",
    author: "Alex Morgan",
    role: "SYSTEMS ARCHITECT",
    title: "High Performance Vector Engines",
    membersCount: "44.20K",
    articlesCount: "112 articles",
    gradient: "linear-gradient(160deg, #b91c1c, #7f1d1d 50%, #450a0a 100%)",
    query: "rust postgres vector similarity benchmarks",
  },
];

export function FeaturedMemoryRail({
  onSelectQuery,
}: {
  onSelectQuery?: (query: string) => void;
}) {
  const [savedIds, setSavedIds] = useState<Set<string>>(new Set());

  function toggleSave(id: string, e: React.MouseEvent) {
    e.stopPropagation();
    setSavedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <section
      className="mobile-featured-section"
      aria-label="Featured Recommendations"
    >
      <div className="mobile-section-header">
        <div>
          <h2 className="mobile-section-heading">People</h2>
          <p className="mobile-section-sub">Friends&apos; recommendations</p>
        </div>
        <button type="button" className="mobile-see-all-btn">
          <span>See all</span>
          <ChevronRight size={15} />
        </button>
      </div>

      <div className="mobile-featured-scroll-rail">
        {FEATURED_ITEMS.map((item) => {
          const isSaved = savedIds.has(item.id);

          return (
            <article
              key={item.id}
              className="featured-poster-card"
              style={{ background: item.gradient }}
              onClick={() => onSelectQuery?.(item.query)}
            >
              {/* Poster Top Bar */}
              <div className="featured-poster-top">
                <div className="featured-author-chip">
                  <div className="featured-author-avatar">
                    <span>{item.author[0]}</span>
                  </div>
                  <div className="featured-author-info">
                    <span className="author-name">{item.author}</span>
                    <span className="author-role">{item.role}</span>
                  </div>
                </div>

                <button
                  type="button"
                  className={`featured-follow-btn ${isSaved ? "follow-btn-active" : ""}`}
                  onClick={(e) => toggleSave(item.id, e)}
                  aria-label={isSaved ? "Saved" : "Follow"}
                >
                  {isSaved ? "SAVED" : "FOLLOW"}
                </button>
              </div>

              {/* Poster Title */}
              <h3 className="featured-poster-title">{item.title}</h3>

              {/* Poster Bottom Meta */}
              <div className="featured-poster-meta">
                <span className="poster-meta-badge">
                  <Users size={12} />
                  <span>{item.membersCount}</span>
                </span>
                <span className="poster-meta-badge">
                  <FileText size={12} />
                  <span>{item.articlesCount}</span>
                </span>
              </div>
            </article>
          );
        })}
      </div>

      {/* Pagination Indicators */}
      <div className="mobile-pagination-dots" aria-hidden="true">
        <span className="page-dot dot-active" />
        <span className="page-dot" />
        <span className="page-dot" />
        <span className="page-dot" />
      </div>
    </section>
  );
}
