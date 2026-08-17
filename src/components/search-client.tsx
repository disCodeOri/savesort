"use client";

import {
  AlertCircle,
  Command,
  Grid2X2,
  List,
  LoaderCircle,
  Search,
  Sparkles,
  X,
} from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { FormEvent, useEffect, useRef, useState } from "react";

import { EmptyState } from "@/components/empty-state";
import { ItemDetailModal } from "@/components/item-detail-modal";
import { CollectionClusterRail } from "@/components/mobile/collection-cluster-rail";
import { FeaturedMemoryRail } from "@/components/mobile/featured-memory-rail";
import { MobileMemoryCard } from "@/components/mobile/mobile-memory-card";
import { ResultCard } from "@/components/result-card";
import {
  MemoryStoryRow,
  type StoryCapsule,
} from "@/components/shared/memory-story-row";
import type { VisibleSource } from "@/components/source-filters";
import type { SavedItem } from "@/lib/items/types";

type ResultTab = "for_you" | "recent" | "starred" | "shared";

export function SearchClient() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);

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
  const [selectedItem, setSelectedItem] = useState<SavedItem | null>(null);
  const [activeTab, setActiveTab] = useState<ResultTab>("for_you");
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid");
  const [activeStoryId, setActiveStoryId] = useState<string>("story-1");

  // Keyboard shortcut listener (Cmd+K / Ctrl+K or /)
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (
        (e.key === "k" && (e.metaKey || e.ctrlKey)) ||
        (e.key === "/" &&
          document.activeElement?.tagName !== "INPUT" &&
          document.activeElement?.tagName !== "TEXTAREA")
      ) {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  // Fetch items
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
                limit: 24,
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

  function handleStoryCapsuleClick(capsule: StoryCapsule) {
    setActiveStoryId(capsule.id);
    if (capsule.source) {
      setSource(capsule.source as VisibleSource);
    }
    if (capsule.query) {
      setInputQuery(capsule.query);
      setActiveQuery(capsule.query);
      const params = new URLSearchParams();
      params.set("q", capsule.query);
      if (capsule.source || source)
        params.set("source", (capsule.source || source) as string);
      router.replace(`/search?${params}`);
    }
  }

  function handleDiscoveryQuery(query: string) {
    setInputQuery(query);
    setActiveQuery(query);
    const params = new URLSearchParams();
    params.set("q", query);
    if (source) params.set("source", source);
    router.replace(`/search?${params}`);
  }

  function clearSearch() {
    setInputQuery("");
    setActiveQuery("");
    const params = new URLSearchParams();
    if (source) params.set("source", source);
    router.replace(`/search${params.size ? `?${params}` : ""}`);
    inputRef.current?.focus();
  }

  return (
    <div className="search-experience-container">
      {/* 1. Hero Search Headline (Matching Desktop & Mobile specifications) */}
      <section className="search-editorial-hero">
        <h1 className="search-big-headline">
          What are <span className="headline-purple-accent">you</span>
          <br />
          looking for?
        </h1>
        <p className="search-hero-subtitle">
          Search your library, vague thoughts, or try a memory.
        </p>

        {/* 2. Floating Search Box */}
        <form className="search-floating-bar-box" onSubmit={submit}>
          <Search className="search-bar-icon-left" size={20} />
          <input
            ref={inputRef}
            value={inputQuery}
            onChange={(e) => setInputQuery(e.target.value)}
            placeholder="Search anything you've saved..."
            aria-label="Search saved knowledge"
            className="search-bar-input"
          />

          <div className="search-bar-right-controls">
            {inputQuery ? (
              <button
                type="button"
                className="search-bar-clear"
                onClick={clearSearch}
                aria-label="Clear query"
              >
                <X size={16} />
              </button>
            ) : (
              <Sparkles size={16} className="search-sparkle-glyph" />
            )}

            <div
              className="search-kbd-chip desktop-only-badge"
              aria-hidden="true"
            >
              <Command size={11} />
              <span>K</span>
            </div>
          </div>
        </form>

        {/* 3. Memory Capsule / Story Row */}
        <div className="search-story-row-wrapper">
          <MemoryStoryRow
            activeId={activeStoryId}
            onSelectCapsule={handleStoryCapsuleClick}
          />
        </div>
      </section>

      {/* =========================================================================
          MOBILE-ONLY SECTIONS (Matching Mobile UI Reference)
          ========================================================================= */}
      <div className="mobile-only-discovery-flow">
        {/* Mobile Section 2: People / Featured Recommendation Cards */}
        <FeaturedMemoryRail onSelectQuery={handleDiscoveryQuery} />

        {/* Mobile Section 3: Communities / Clustered Category Row */}
        <CollectionClusterRail onSelectCluster={handleDiscoveryQuery} />

        {/* Mobile Section 4: Recent Memories Feed */}
        <section
          className="mobile-recent-memories-section"
          aria-label="Recent memories"
        >
          <h2 className="mobile-section-heading">Recent memories</h2>

          {loading ? (
            <div className="loading-state">
              <LoaderCircle className="spin" size={20} />
              <span>Recalling saved memories…</span>
            </div>
          ) : error ? (
            <div className="notice notice-error">{error}</div>
          ) : !items.length ? (
            <EmptyState searched={Boolean(activeQuery)} />
          ) : (
            <div className="mobile-recent-list">
              {items.map((item) => (
                <MobileMemoryCard
                  key={item.id}
                  item={item}
                  onSelect={(selected) => setSelectedItem(selected)}
                />
              ))}
            </div>
          )}
        </section>
      </div>

      {/* =========================================================================
          DESKTOP-ONLY SECTIONS (Matching Desktop UI Reference)
          ========================================================================= */}
      <div className="desktop-only-results-flow">
        {/* Desktop Tab Switcher & Controls */}
        <div className="desktop-results-toolbar">
          <div className="desktop-tab-switcher">
            <button
              type="button"
              className={`desktop-tab-btn ${activeTab === "for_you" ? "tab-btn-active" : ""}`}
              onClick={() => setActiveTab("for_you")}
            >
              For you
            </button>
            <button
              type="button"
              className={`desktop-tab-btn ${activeTab === "recent" ? "tab-btn-active" : ""}`}
              onClick={() => setActiveTab("recent")}
            >
              Recent
            </button>
            <button
              type="button"
              className={`desktop-tab-btn ${activeTab === "starred" ? "tab-btn-active" : ""}`}
              onClick={() => setActiveTab("starred")}
            >
              Starred
            </button>
            <button
              type="button"
              className={`desktop-tab-btn ${activeTab === "shared" ? "tab-btn-active" : ""}`}
              onClick={() => setActiveTab("shared")}
            >
              Shared with you
            </button>
          </div>

          <div className="desktop-toolbar-right">
            <span className="sort-label">Sort by:</span>
            <select
              className="sort-dropdown"
              defaultValue="relevance"
              aria-label="Sort search results"
            >
              <option value="relevance">Relevance</option>
              <option value="newest">Newest</option>
              <option value="oldest">Oldest</option>
            </select>

            <div
              className="view-mode-toggle"
              role="group"
              aria-label="View layout"
            >
              <button
                type="button"
                className={`view-toggle-btn ${viewMode === "grid" ? "toggle-btn-active" : ""}`}
                onClick={() => setViewMode("grid")}
                aria-label="Grid layout"
              >
                <Grid2X2 size={16} />
              </button>
              <button
                type="button"
                className={`view-toggle-btn ${viewMode === "list" ? "toggle-btn-active" : ""}`}
                onClick={() => setViewMode("list")}
                aria-label="List layout"
              >
                <List size={16} />
              </button>
            </div>
          </div>
        </div>

        {/* Warning notification */}
        {warning && (
          <div className="notice notice-info">
            <AlertCircle size={18} />
            <span>{warning}</span>
          </div>
        )}

        {/* Loading state */}
        {loading && (
          <div className="loading-state">
            <LoaderCircle className="spin" size={24} />
            <span>Querying vector hyperspace & tsvector catalog…</span>
          </div>
        )}

        {/* Error state */}
        {error && (
          <div className="notice notice-error">
            <AlertCircle size={18} />
            <span>{error}</span>
          </div>
        )}

        {/* Empty state */}
        {!loading && !error && !items.length && (
          <EmptyState searched={Boolean(activeQuery)} />
        )}

        {/* Immersive 3-Column Result Grid */}
        <div
          className={`desktop-immersive-grid ${viewMode === "list" ? "grid-mode-list" : ""}`}
        >
          {items.map((item) => (
            <ResultCard
              key={item.id}
              item={item}
              onSelect={(selected) => setSelectedItem(selected)}
            />
          ))}
        </div>
      </div>

      {/* Quick View Item Detail Modal / Sheet */}
      <ItemDetailModal
        item={selectedItem}
        onClose={() => setSelectedItem(null)}
      />
    </div>
  );
}
