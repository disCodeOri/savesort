import { Suspense } from "react";

import { SearchClient } from "@/components/search-client";

export default function SearchPage() {
  return (
    <Suspense fallback={<div className="loading-state">Loading search…</div>}>
      <SearchClient />
    </Suspense>
  );
}
