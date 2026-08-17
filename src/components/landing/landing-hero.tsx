"use client";

import { useId, useState } from "react";
import Link from "next/link";
import {
  ArrowRight,
  Bookmark,
  CheckCircle2,
  Database,
  ExternalLink,
  Layers,
  Lock,
  Search,
  Shield,
  Sparkles,
  Zap,
} from "lucide-react";

import { GithubIcon } from "@/components/landing/icons";
import { use3DTilt } from "@/components/landing/use-3d-tilt";
import { VectorConstellation3D } from "@/components/landing/vector-constellation-3d";

interface SampleItem {
  id: string;
  title: string;
  url: string;
  source: "github" | "website" | "article" | "video";
  tags: string[];
  description: string;
  matchKeyword: number; // 0 to 1
  matchVector: number; // 0 to 1
  scoreRRF: number; // combined score
  highlightTerm: string;
}

const SAMPLE_DATABASE: SampleItem[] = [
  {
    id: "item-1",
    title: "yt-dlp/yt-dlp",
    url: "https://github.com/yt-dlp/yt-dlp",
    source: "github",
    tags: ["python", "cli", "media-downloader", "youtube"],
    description:
      "A feature-rich command-line audio/video downloader with support for thousands of video sites, audio extraction, format conversion, and metadata embedding.",
    matchKeyword: 0.94,
    matchVector: 0.98,
    scoreRRF: 0.97,
    highlightTerm: "command-line audio/video downloader",
  },
  {
    id: "item-2",
    title: "motion-canvas/motion-canvas",
    url: "https://github.com/motion-canvas/motion-canvas",
    source: "github",
    tags: ["typescript", "animation", "react", "canvas"],
    description:
      "Programmatic animations and interactive motion graphics made with TypeScript and canvas rendering. Fine-tuned frame-by-frame physics.",
    matchKeyword: 0.76,
    matchVector: 0.95,
    scoreRRF: 0.92,
    highlightTerm: "motion graphics made with TypeScript",
  },
  {
    id: "item-3",
    title: "PostgreSQL Full-Text Search vs pgvector",
    url: "https://supabase.com/blog/postgresql-hybrid-search",
    source: "article",
    tags: ["database", "postgres", "pgvector", "rrf"],
    description:
      "A deep architectural guide comparing tsvector inverted indexes with HNSW cosine similarity. How Reciprocal Rank Fusion fuses lexical and semantic relevance.",
    matchKeyword: 0.98,
    matchVector: 0.91,
    scoreRRF: 0.96,
    highlightTerm:
      "Reciprocal Rank Fusion fuses lexical and semantic relevance",
  },
  {
    id: "item-4",
    title: "qdrant/qdrant",
    url: "https://github.com/qdrant/qdrant",
    source: "github",
    tags: ["rust", "vector-search", "database", "hnsw"],
    description:
      "Vector Similarity Search Engine and Vector Database deployed as an API service. Written in Rust for blazingly fast high-dimensional nearest neighbor queries.",
    matchKeyword: 0.88,
    matchVector: 0.96,
    scoreRRF: 0.94,
    highlightTerm: "Vector Similarity Search Engine written in Rust",
  },
  {
    id: "item-5",
    title: "Understanding Modern CSS Layout & Scroll-Driven Animations",
    url: "https://developer.chrome.com/docs/css-ui/scroll-driven-animations",
    source: "website",
    tags: ["css", "web-dev", "animation", "frontend"],
    description:
      "Comprehensive breakdown of native scroll timelines, view timelines, and GPU-accelerated motion without heavy JavaScript overhead.",
    matchKeyword: 0.65,
    matchVector: 0.89,
    scoreRRF: 0.84,
    highlightTerm: "GPU-accelerated motion without heavy JavaScript",
  },
];

const PRESET_QUERIES = [
  {
    label: "CLI tool for downloading audio/video",
    query: "that terminal tool for downloading youtube audio",
  },
  {
    label: "React & TypeScript animation physics",
    query: "typescript canvas animation library with springs",
  },
  {
    label: "Postgres hybrid vector search guide",
    query: "article explaining rrf hybrid search in postgresql",
  },
  {
    label: "Fast Rust vector similarity engine",
    query: "fast rust vector database with hnsw index",
  },
];

export function LandingHero() {
  const [searchQuery, setSearchQuery] = useState(PRESET_QUERIES[0].query);
  const [searchMode, setSearchMode] = useState<
    "hybrid" | "semantic" | "keyword"
  >("hybrid");
  const [heroView, setHeroView] = useState<"sandbox" | "hyperspace">("sandbox");
  const searchInputId = useId();

  // 3D Tilt Hook for the Hero Visual
  const tiltContainerRef = use3DTilt<HTMLDivElement>({
    maxTilt: 8,
    perspective: 1400,
    scale: 1.015,
    speed: 0.35,
  });

  const queryLower = searchQuery.toLowerCase();
  const sortedItems = [...SAMPLE_DATABASE]
    .map((item) => {
      let dynamicScore = item.scoreRRF;
      if (searchMode === "semantic") dynamicScore = item.matchVector;
      if (searchMode === "keyword") dynamicScore = item.matchKeyword;

      const words = queryLower.split(" ").filter((w) => w.length > 2);
      const text = (
        item.title +
        " " +
        item.description +
        " " +
        item.tags.join(" ")
      ).toLowerCase();
      const hits = words.filter((w) => text.includes(w)).length;
      const boost = words.length > 0 ? (hits / words.length) * 0.15 : 0;

      return {
        ...item,
        finalScore: Math.min(0.99, dynamicScore + boost),
      };
    })
    .sort((a, b) => b.finalScore - a.finalScore);

  return (
    <section className="landing-hero-section" aria-labelledby="hero-heading">
      <div className="landing-hero-content">
        <div className="landing-badge hero-fade-in">
          <span className="landing-badge-dot" />
          <span className="landing-badge-text">
            The 3D Spatial Knowledge Engine
          </span>
        </div>

        <h1 id="hero-heading" className="landing-hero-title hero-fade-in">
          Grapple the web.
          <br />
          <span className="hero-title-accent">Recall with a whisper.</span>
        </h1>

        <p className="landing-hero-subtitle hero-fade-in">
          A private, hybrid search engine for everything you save across the
          internet. Ingest URLs in seconds, auto-sync GitHub stars, and
          rediscover anything with exact keywords or vague thoughts in
          768-dimensional space.
        </p>

        <div className="landing-hero-cta-group hero-fade-in">
          <Link href="/login" className="button button-accent hero-primary-btn">
            <span>Start Grapplin&apos; Free</span>
            <ArrowRight size={18} />
          </Link>
          <a
            href="#demo"
            className="button button-secondary hero-secondary-btn"
          >
            <Sparkles size={17} />
            <span>Explore 3D Sandbox</span>
          </a>
        </div>

        <div className="hero-metrics-strip hero-fade-in">
          <div className="hero-metric-item">
            <span className="hero-metric-num">768</span>
            <span className="hero-metric-label">Embedding Dimensions</span>
          </div>
          <div className="hero-metric-divider" />
          <div className="hero-metric-item">
            <span className="hero-metric-num">RRF</span>
            <span className="hero-metric-label">Reciprocal Rank Fusion</span>
          </div>
          <div className="hero-metric-divider" />
          <div className="hero-metric-item">
            <span className="hero-metric-num">100%</span>
            <span className="hero-metric-label">PostgreSQL RLS Privacy</span>
          </div>
          <div className="hero-metric-divider" />
          <div className="hero-metric-item">
            <span className="hero-metric-num">0 ms</span>
            <span className="hero-metric-label">Client Token Leakage</span>
          </div>
        </div>
      </div>

      {/* 3D Interactive Hero Visual Stage */}
      <div className="landing-hero-visual hero-fade-in" id="demo">
        <div className="hero-3d-stage" ref={tiltContainerRef}>
          {/* Main 3D Simulator Window */}
          <div className="hero-simulator-window" data-depth="25">
            <div className="simulator-topbar">
              <div className="simulator-traffic-lights">
                <span className="light light-red" />
                <span className="light light-yellow" />
                <span className="light light-green" />
              </div>
              <div className="simulator-view-switcher">
                <button
                  type="button"
                  onClick={() => setHeroView("sandbox")}
                  className={`view-switch-btn ${heroView === "sandbox" ? "view-switch-active" : ""}`}
                >
                  <Search size={13} />
                  <span>Hybrid Search</span>
                </button>
                <button
                  type="button"
                  onClick={() => setHeroView("hyperspace")}
                  className={`view-switch-btn ${heroView === "hyperspace" ? "view-switch-active" : ""}`}
                >
                  <Layers size={13} />
                  <span>3D Hyperspace</span>
                </button>
              </div>
              {heroView === "sandbox" && (
                <div className="simulator-mode-pills">
                  <button
                    type="button"
                    onClick={() => setSearchMode("hybrid")}
                    className={`mode-pill ${searchMode === "hybrid" ? "mode-pill-active" : ""}`}
                  >
                    RRF
                  </button>
                  <button
                    type="button"
                    onClick={() => setSearchMode("semantic")}
                    className={`mode-pill ${searchMode === "semantic" ? "mode-pill-active" : ""}`}
                  >
                    Vector
                  </button>
                  <button
                    type="button"
                    onClick={() => setSearchMode("keyword")}
                    className={`mode-pill ${searchMode === "keyword" ? "mode-pill-active" : ""}`}
                  >
                    Lexical
                  </button>
                </div>
              )}
            </div>

            {heroView === "hyperspace" ? (
              <div className="simulator-constellation-view">
                <VectorConstellation3D />
              </div>
            ) : (
              <>
                <div className="simulator-search-container">
                  <div className="simulator-input-box">
                    <Search size={18} className="simulator-search-icon" />
                    <label htmlFor={searchInputId} className="visually-hidden">
                      Test search query
                    </label>
                    <input
                      id={searchInputId}
                      type="text"
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      placeholder="Type a vague thought or exact keyword..."
                      className="simulator-input"
                    />
                    {searchQuery ? (
                      <button
                        type="button"
                        onClick={() => setSearchQuery("")}
                        className="simulator-clear-btn"
                        aria-label="Clear search query"
                      >
                        ×
                      </button>
                    ) : null}
                  </div>

                  <div className="simulator-presets">
                    <span className="presets-label">Try vague memories:</span>
                    <div className="presets-scroll">
                      {PRESET_QUERIES.map((preset, idx) => (
                        <button
                          key={idx}
                          type="button"
                          onClick={() => setSearchQuery(preset.query)}
                          className={`preset-chip ${searchQuery === preset.query ? "preset-chip-active" : ""}`}
                        >
                          {preset.label}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                <div className="simulator-results-list" role="list">
                  {sortedItems.slice(0, 3).map((item, idx) => (
                    <div
                      key={item.id}
                      className="simulator-card"
                      role="listitem"
                      style={{ animationDelay: `${idx * 0.08}s` }}
                    >
                      <div className="simulator-card-header">
                        <div className="simulator-card-meta">
                          {item.source === "github" ? (
                            <span className="source-tag source-github">
                              <GithubIcon size={13} />
                              <span>GitHub</span>
                            </span>
                          ) : item.source === "article" ? (
                            <span className="source-tag source-article">
                              <Database size={13} />
                              <span>Article</span>
                            </span>
                          ) : (
                            <span className="source-tag source-web">
                              <Bookmark size={13} />
                              <span>Website</span>
                            </span>
                          )}
                          <span className="card-url">
                            {new URL(item.url).hostname}
                          </span>
                        </div>
                        <div className="simulator-card-scores">
                          <span className="hybrid-badge">
                            <Zap size={12} />
                            <span>
                              {Math.round(item.finalScore * 100)}% match
                            </span>
                          </span>
                        </div>
                      </div>

                      <h3 className="simulator-card-title">
                        <a
                          href={item.url}
                          target="_blank"
                          rel="noreferrer"
                          className="simulator-title-link"
                        >
                          {item.title}
                          <ExternalLink size={13} />
                        </a>
                      </h3>

                      <p className="simulator-card-desc">{item.description}</p>

                      <div className="simulator-card-footer">
                        <div className="simulator-tag-list">
                          {item.tags.map((t) => (
                            <span key={t} className="simulator-tag">
                              #{t}
                            </span>
                          ))}
                        </div>
                        <div className="simulator-debug-badges">
                          <span className="debug-badge">
                            Vector: {Math.round(item.matchVector * 100)}%
                          </span>
                          <span className="debug-badge">
                            Lexical: {Math.round(item.matchKeyword * 100)}%
                          </span>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}

            <div className="simulator-footer-bar">
              <div className="simulator-status-indicator">
                <CheckCircle2 size={14} className="status-icon" />
                <span>3D Spatial Index Live • 0.03s latency</span>
              </div>
              <Link href="/login" className="simulator-test-link">
                Search your own library →
              </Link>
            </div>
          </div>

          {/* Floating 3D Satellite Cards (Mounted in front of window) */}
          <div
            className="floating-satellite satellite-top-left"
            data-depth="55"
            aria-hidden="true"
          >
            <Zap size={14} className="sat-icon sat-accent" />
            <div className="sat-text">
              <strong>Hybrid RRF Fused</strong>
              <span>Cosine + tsvector</span>
            </div>
          </div>

          <div
            className="floating-satellite satellite-top-right"
            data-depth="75"
            aria-hidden="true"
          >
            <Lock size={14} className="sat-icon sat-purple" />
            <div className="sat-text">
              <strong>PostgreSQL RLS</strong>
              <span>Owner Isolated</span>
            </div>
          </div>

          <div
            className="floating-satellite satellite-bottom-left"
            data-depth="65"
            aria-hidden="true"
          >
            <GithubIcon size={14} className="sat-icon" />
            <div className="sat-text">
              <strong>GitHub Auto-Sync</strong>
              <span>AES-256 Encrypted</span>
            </div>
          </div>

          <div
            className="floating-satellite satellite-bottom-right"
            data-depth="85"
            aria-hidden="true"
          >
            <Shield size={14} className="sat-icon sat-green" />
            <div className="sat-text">
              <strong>SSRF Guarded</strong>
              <span>DNS Validated</span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
