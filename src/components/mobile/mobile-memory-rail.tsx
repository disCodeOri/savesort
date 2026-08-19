"use client";

import { Grid2X2 } from "lucide-react";

import { SourceIcon } from "@/components/source-icon";
import type { VisibleSource } from "@/components/source-filters";

const SOURCE_OPTIONS: Array<{ value: VisibleSource | null; label: string }> = [
  { value: null, label: "All" },
  { value: "github", label: "GitHub" },
  { value: "website", label: "Web" },
  { value: "youtube", label: "YouTube" },
  { value: "reddit", label: "Reddit" },
  { value: "linkedin", label: "LinkedIn" },
  { value: "instagram", label: "Instagram" },
  { value: "other", label: "Other" },
];

export function MobileMemoryRail({
  value,
  onChange,
}: {
  value: VisibleSource | null;
  onChange: (source: VisibleSource | null) => void;
}) {
  return (
    <div
      className="mobile-memory-rail-wrap"
      role="region"
      aria-label="Filter resources by source"
    >
      <div className="mobile-memory-rail">
        {SOURCE_OPTIONS.map((opt) => {
          const isSelected = value === opt.value;
          return (
            <button
              key={opt.label}
              type="button"
              className={`mobile-rail-pill ${isSelected ? "rail-pill-active" : ""}`}
              onClick={() => onChange(opt.value)}
              aria-pressed={isSelected}
            >
              <div className="mobile-rail-icon">
                {opt.value ? (
                  <SourceIcon source={opt.value} size={14} />
                ) : (
                  <Grid2X2 size={14} />
                )}
              </div>
              <span className="mobile-rail-label">{opt.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
