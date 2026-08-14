"use client";

import { AlertCircle, LoaderCircle, Search } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { FormEvent, useEffect, useState } from "react";

import { EmptyState } from "@/components/empty-state";
import { ResultCard } from "@/components/result-card";
import { SourceFilters, type VisibleSource } from "@/components/source-filters";
import type { SavedItem } from "@/lib/items/types";

export function SearchClient() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const initialQuery = searchParams.get("q") ?? "";
  const initialSource =
    (searchParams.get("source") as VisibleSource | null) ?? null;
  const [inputQuery, setInputQuery] = useState(initialQuery);
  const [activeQuery, setActiveQuery] = useState(initialQuery);
  const [source, setSource] = useState<VisibleSource | null>(initialSource);
  const [items, setItems] = useState<SavedItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [warning, setWarning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const response = activeQuery
          ? await fetch("/api/search", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                query: activeQuery,
                source: source ?? undefined,
                limit: 20,
              }),
              signal: controller.signal,
            })
          : await fetch(`/api/items${source ? `?source=${source}` : ""}`, {
              signal: controller.signal,
            });
        const body = await response.json();
        if (!response.ok)
          throw new Error(body.error ?? "Search couldn't be completed.");
        setItems(body.items ?? []);
        setWarning(body.warning ?? null);
      } catch (caught) {
        if (!(caught instanceof DOMException && caught.name === "AbortError"))
          setError(
            caught instanceof Error
              ? caught.message
              : "Search couldn't be completed.",
          );
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    void load();
    return () => controller.abort();
  }, [activeQuery, source, revision]);

  useEffect(() => {
    const refresh = () => setRevision((value) => value + 1);
    window.addEventListener("savesort:changed", refresh);
    return () => window.removeEventListener("savesort:changed", refresh);
  }, []);

  function submit(event: FormEvent) {
    event.preventDefault();
    const trimmed = inputQuery.trim();
    setActiveQuery(trimmed);
    const params = new URLSearchParams();
    if (trimmed) params.set("q", trimmed);
    if (source) params.set("source", source);
    router.replace(`/search${params.size ? `?${params}` : ""}`);
  }

  function changeSource(next: VisibleSource | null) {
    setSource(next);
    const params = new URLSearchParams();
    if (activeQuery) params.set("q", activeQuery);
    if (next) params.set("source", next);
    router.replace(`/search${params.size ? `?${params}` : ""}`);
  }

  return (
    <main className="search-page content-width">
      <h1>Find the thing you saved.</h1>
      <form className="search-box" onSubmit={submit}>
        <Search aria-hidden="true" />
        <input
          value={inputQuery}
          onChange={(event) => setInputQuery(event.target.value)}
          placeholder="Search anything you've saved..."
          aria-label="Search saved items"
        />
        <button aria-label="Run search">
          <Search />
        </button>
      </form>
      <SourceFilters value={source} onChange={changeSource} />
      {warning ? (
        <div className="notice notice-info">
          <AlertCircle size={18} />
          {warning}
        </div>
      ) : null}
      <div className="results-heading">
        <strong>
          {activeQuery
            ? `${items.length} results for “${activeQuery}”`
            : "Recently saved"}
        </strong>
        <span>{activeQuery ? "Most relevant" : "Newest first"}</span>
      </div>
      {loading ? (
        <div className="loading-state">
          <LoaderCircle className="spin" /> Searching your saved things…
        </div>
      ) : null}
      {error ? (
        <div className="notice notice-error">
          <AlertCircle size={18} />
          {error}
        </div>
      ) : null}
      {!loading && !error && !items.length ? (
        <EmptyState searched={Boolean(activeQuery)} />
      ) : null}
      <div className="results-list">
        {items.map((item) => (
          <ResultCard item={item} key={item.id} />
        ))}
      </div>
    </main>
  );
}
