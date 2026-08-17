"use client";

import { ChevronRight } from "lucide-react";
import { useRef } from "react";

export interface StoryCapsule {
  id: string;
  title: string;
  badgeCount?: number;
  isActive?: boolean;
  query?: string;
  source?: string;
  gradient?: string;
  imageSrc?: string;
  dualImageSrc?: string;
}

const DEFAULT_STORY_CAPSULES: StoryCapsule[] = [
  {
    id: "story-1",
    title: "Dual AI Models",
    badgeCount: 37,
    isActive: true,
    query: "hybrid vector search embedding models",
    gradient: "linear-gradient(135deg, #2d3748, #1a202c)",
  },
  {
    id: "story-2",
    title: "Warm Studio",
    badgeCount: 4,
    query: "rust command line tools audio video",
    gradient: "linear-gradient(135deg, #d97706, #78350f)",
  },
  {
    id: "story-3",
    title: "Design Systems",
    badgeCount: 4,
    query: "typescript animation spring physics canvas",
    gradient: "linear-gradient(135deg, #ec4899, #be185d)",
  },
  {
    id: "story-4",
    title: "Dark Systems",
    badgeCount: 1,
    query: "postgres rls row level security multi tenant",
    gradient: "linear-gradient(135deg, #1e293b, #0f172a)",
  },
  {
    id: "story-5",
    title: "Vector Sphere",
    badgeCount: 98,
    query: "semantic search embeddings cosine similarity",
    gradient: "linear-gradient(135deg, #dc2626, #991b1b)",
  },
];

export function MemoryStoryRow({
  capsules = DEFAULT_STORY_CAPSULES,
  onSelectCapsule,
  activeId,
}: {
  capsules?: StoryCapsule[];
  onSelectCapsule?: (capsule: StoryCapsule) => void;
  activeId?: string;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);

  function handleScrollRight() {
    if (scrollRef.current) {
      scrollRef.current.scrollBy({ left: 180, behavior: "smooth" });
    }
  }

  return (
    <div
      className="memory-story-carousel-container"
      role="region"
      aria-label="Visual Memory Capsules"
    >
      <div className="memory-story-scroll-wrap" ref={scrollRef}>
        {capsules.map((capsule, index) => {
          const isSelected = activeId ? activeId === capsule.id : index === 0;

          return (
            <button
              key={capsule.id}
              type="button"
              className={`memory-story-pill ${isSelected ? "story-pill-active" : ""}`}
              onClick={() => onSelectCapsule?.(capsule)}
              title={capsule.title}
              aria-label={`Memory Capsule: ${capsule.title}`}
            >
              <div
                className="story-thumbnail-surface"
                style={{ background: capsule.gradient }}
              >
                {/* Fallback abstract visual graphic */}
                <div className="story-graphic-mesh">
                  <span className="story-inner-circle" />
                  {index === 0 && <span className="story-inner-circle-alt" />}
                </div>
              </div>

              {capsule.badgeCount !== undefined && (
                <span className="story-badge-count">{capsule.badgeCount}</span>
              )}
            </button>
          );
        })}
      </div>

      <button
        type="button"
        className="story-carousel-next-btn desktop-only-btn"
        onClick={handleScrollRight}
        aria-label="Scroll more memory capsules"
      >
        <ChevronRight size={16} />
      </button>
    </div>
  );
}
