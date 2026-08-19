import { Grid2X2 } from "lucide-react";

import { SourceIcon } from "@/components/source-icon";
import type { Source } from "@/lib/sources/detect-source";

export type VisibleSource = Exclude<Source, "x">;

const FILTERS: Array<{ value: VisibleSource | null; label: string }> = [
  { value: null, label: "All" },
  { value: "github", label: "GitHub" },
  { value: "website", label: "Web" },
  { value: "instagram", label: "Instagram" },
  { value: "youtube", label: "YouTube" },
  { value: "reddit", label: "Reddit" },
  { value: "linkedin", label: "LinkedIn" },
  { value: "other", label: "Other" },
];

export function SourceFilters({
  value,
  onChange,
}: {
  value: VisibleSource | null;
  onChange: (source: VisibleSource | null) => void;
}) {
  return (
    <div className="source-filters" role="group" aria-label="Filter by source">
      {FILTERS.map((filter) => (
        <button
          className={value === filter.value ? "selected" : ""}
          key={filter.label}
          onClick={() => onChange(filter.value)}
          type="button"
        >
          {filter.value ? (
            <SourceIcon source={filter.value} size={17} />
          ) : (
            <Grid2X2 size={17} />
          )}
          {filter.label}
        </button>
      ))}
    </div>
  );
}
