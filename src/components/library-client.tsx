"use client";

import {
  ExternalLink,
  LoaderCircle,
  MoreHorizontal,
  Pencil,
  RefreshCw,
  Trash2,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

import { EmptyState } from "@/components/empty-state";
import { ResultCard } from "@/components/result-card";
import { SourceFilters, type VisibleSource } from "@/components/source-filters";
import type { SavedItem } from "@/lib/items/types";

export function LibraryClient() {
  const [source, setSource] = useState<VisibleSource | null>(null);
  const [items, setItems] = useState<SavedItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      setLoading(true);
      try {
        const response = await fetch(
          `/api/items${source ? `?source=${source}` : ""}`,
          { signal: controller.signal },
        );
        const body = await response.json();
        if (!response.ok)
          throw new Error(body.error ?? "Your library couldn't be loaded.");
        setItems(body.items ?? []);
        setError(null);
      } catch (caught) {
        if (!(caught instanceof DOMException && caught.name === "AbortError"))
          setError(
            caught instanceof Error
              ? caught.message
              : "Your library couldn't be loaded.",
          );
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    void load();
    return () => controller.abort();
  }, [source, revision]);

  useEffect(() => {
    const refresh = () => setRevision((value) => value + 1);
    window.addEventListener("savesort:changed", refresh);
    return () => window.removeEventListener("savesort:changed", refresh);
  }, []);

  async function remove(item: SavedItem) {
    if (
      !window.confirm(
        `Delete “${item.title ?? "this item"}”? This cannot be undone.`,
      )
    )
      return;
    const response = await fetch(`/api/items/${item.id}`, { method: "DELETE" });
    if (!response.ok) {
      const body = await response.json();
      setError(body.error ?? "Delete failed.");
      return;
    }
    setItems((current) =>
      current.filter((candidate) => candidate.id !== item.id),
    );
  }

  async function retry(id: string) {
    const response = await fetch(`/api/items/${id}/retry`, { method: "POST" });
    if (!response.ok) {
      const body = await response.json();
      setError(body.error ?? "Retry failed.");
      return;
    }
    setOpenMenu(null);
    setRevision((value) => value + 1);
  }

  return (
    <main className="library-page content-width">
      <div className="page-title-row">
        <div>
          <h1>Your saved things</h1>
          <p>Everything you wanted to find again, newest first.</p>
        </div>
        <span>{items.length} saved</span>
      </div>
      <SourceFilters value={source} onChange={setSource} />
      {loading ? (
        <div className="loading-state">
          <LoaderCircle className="spin" /> Loading your library…
        </div>
      ) : null}
      {error ? <div className="notice notice-error">{error}</div> : null}
      {!loading && !error && !items.length ? <EmptyState /> : null}
      <div className="results-list library-list">
        {items.map((item) => (
          <ResultCard
            key={item.id}
            item={item}
            actions={
              <div className="item-menu-wrap">
                <button
                  className="icon-button"
                  aria-label={`Actions for ${item.title}`}
                  onClick={() =>
                    setOpenMenu(openMenu === item.id ? null : item.id)
                  }
                >
                  <MoreHorizontal />
                </button>
                {openMenu === item.id ? (
                  <div className="item-menu">
                    <Link href={`/item/${item.id}`}>
                      <Pencil /> Edit
                    </Link>
                    <button onClick={() => void retry(item.id)}>
                      <RefreshCw /> Retry indexing
                    </button>
                    <a href={item.url} target="_blank" rel="noreferrer">
                      <ExternalLink /> Open original
                    </a>
                    <button
                      className="danger"
                      onClick={() => void remove(item)}
                    >
                      <Trash2 /> Delete
                    </button>
                  </div>
                ) : null}
              </div>
            }
          />
        ))}
      </div>
    </main>
  );
}
