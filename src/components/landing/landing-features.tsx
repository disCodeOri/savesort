"use client";

import { useState } from "react";
import {
  Database,
  KeyRound,
  Lock,
  RefreshCw,
  Shield,
  Sparkles,
  Zap,
} from "lucide-react";

import { GithubIcon } from "@/components/landing/icons";

interface FeatureDetail {
  id: string;
  badge: string;
  title: string;
  subtitle: string;
  description: string;
  highlights: string[];
  visualType: "hybrid-diagram" | "sync-flow" | "security-shield" | "rls-code";
}

const FEATURES: FeatureDetail[] = [
  {
    id: "hybrid-search",
    badge: "Dual-Engine Retrieval",
    title: "Hybrid Search with Reciprocal Rank Fusion",
    subtitle: "Why choose between keywords and AI when you can have both working in unison?",
    description:
      "Grapplin doesn't force a tradeoff between exact keyword precision and fuzzy semantic recall. It runs PostgreSQL full-text search and 768-dimension pgvector cosine distance simultaneously, fusing their rank orders with mathematical Reciprocal Rank Fusion (RRF).",
    highlights: [
      "PostgreSQL GIN tsvector inverted index for exact keywords, acronyms, and code terms",
      "pgvector HNSW index for high-dimensional semantic clustering (Gemini 768-dim embeddings)",
      "Reciprocal Rank Fusion merges lexical & vector ranks: Score = Σ (1 / (60 + rank))",
      "Deterministic keyword-only fallback if AI quota or network drops",
    ],
    visualType: "hybrid-diagram",
  },
  {
    id: "github-sync",
    badge: "Automated Synchronization",
    title: "Zero-Friction GitHub Star Sync",
    subtitle: "Star on your phone or laptop. Find it instantly in Grapplin.",
    description:
      "Connect your GitHub account with read-only starring permissions. Grapplin continuously syncs your starred repositories, extracts topics, primary language, and README summaries without exposing your tokens to the client.",
    highlights: [
      "Separate GitHub OAuth connection using PKCE & server-side encrypted tokens",
      "Atomic page leasing & heartbeat recovery for bulletproof sync reliability",
      "User notes, tags, and edits survive future re-sync merges cleanly",
      "Non-destructive: unstarring on GitHub never wipes your saved library item",
    ],
    visualType: "sync-flow",
  },
  {
    id: "safe-ingestion",
    badge: "Zero-Trust Architecture",
    title: "SSRF-Guarded Safe Ingestion",
    subtitle: "Ingest any public web link without security vulnerabilities.",
    description:
      "Untrusted URLs can pose SSRF threats, malicious redirects, and payload attacks. Grapplin wraps every URL fetch in a multi-layer security perimeter before indexing.",
    highlights: [
      "Strict DNS resolution check blocking private, localhost (127.0.0.1), and link-local IP addresses",
      "Manual redirect validation preventing redirect-based intranet probing",
      "Content-Type validation, strict timeouts, and 2MB payload size boundaries",
      "No script execution or HTML injection: external content is sanitized to pure text",
    ],
    visualType: "security-shield",
  },
  {
    id: "rls-privacy",
    badge: "Data Sovereignty",
    title: "PostgreSQL Row-Level Security & Encrypted Secrets",
    subtitle: "Your bookmarks belong to you alone. No telemetry, no data sharing.",
    description:
      "All saved items, notes, tags, and search vectors are isolated by PostgreSQL Row Level Security (RLS). Every query requires authenticated ownership (`auth.uid() = user_id`).",
    highlights: [
      "PostgreSQL RLS policies on SELECT, INSERT, UPDATE, and DELETE",
      "GitHub OAuth tokens encrypted at rest using 256-bit AES-GCM",
      "Zero secret leakage: Service-role and API keys never exposed to browser bundles",
      "Single-command export & deletion anytime",
    ],
    visualType: "rls-code",
  },
];

export function LandingFeatures() {
  const [activeTab, setActiveTab] = useState(FEATURES[0].id);
  const currentFeature = FEATURES.find((f) => f.id === activeTab) || FEATURES[0];

  return (
    <section className="landing-features-section" id="features" aria-labelledby="features-heading">
      <div className="section-header">
        <div className="landing-badge">
          <Sparkles size={13} />
          <span>Core Capabilities</span>
        </div>
        <h2 id="features-heading" className="section-title">
          Engineered for speed, recall, and total privacy
        </h2>
        <p className="section-subtitle">
          Built on PostgreSQL, pgvector, and Gemini embeddings — structured as a
          lean, single-binary architecture without bloated microservices.
        </p>
      </div>

      {/* Feature Navigation Tabs */}
      <div className="features-tab-nav" role="tablist" aria-label="Feature Tabs">
        {FEATURES.map((feature) => (
          <button
            key={feature.id}
            type="button"
            role="tab"
            aria-selected={activeTab === feature.id}
            onClick={() => setActiveTab(feature.id)}
            className={`feature-tab-btn ${activeTab === feature.id ? "feature-tab-active" : ""}`}
          >
            {feature.id === "hybrid-search" ? (
              <Zap size={16} />
            ) : feature.id === "github-sync" ? (
              <GithubIcon size={16} />
            ) : feature.id === "safe-ingestion" ? (
              <Shield size={16} />
            ) : (
              <Lock size={16} />
            )}
            <span>{feature.badge}</span>
          </button>
        ))}
      </div>

      {/* Feature Showcase Showcase Card */}
      <div className="feature-showcase-box">
        <div className="feature-text-col">
          <span className="feature-detail-badge">{currentFeature.badge}</span>
          <h3 className="feature-detail-title">{currentFeature.title}</h3>
          <p className="feature-detail-subtitle">{currentFeature.subtitle}</p>
          <p className="feature-detail-desc">{currentFeature.description}</p>

          <ul className="feature-highlight-list">
            {currentFeature.highlights.map((h, i) => (
              <li key={i} className="feature-highlight-item">
                <span className="highlight-bullet">✓</span>
                <span>{h}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="feature-visual-col">
          {currentFeature.visualType === "hybrid-diagram" && (
            <div className="visual-hybrid-card">
              <div className="visual-panel-header">
                <Database size={15} />
                <span>Reciprocal Rank Fusion Visualizer</span>
              </div>
              <div className="hybrid-pipeline-visual">
                <div className="hybrid-branch-box branch-keyword">
                  <span className="branch-title">PostgreSQL Full-Text (tsvector)</span>
                  <span className="branch-meta">Lexical Inverted Index</span>
                  <div className="branch-score-pill">Rank #1: Score 1/61 = 0.0163</div>
                </div>

                <div className="hybrid-fuse-icon">
                  <Sparkles size={20} />
                  <span>RRF Fusion</span>
                </div>

                <div className="hybrid-branch-box branch-vector">
                  <span className="branch-title">pgvector Cosine (768-dim)</span>
                  <span className="branch-meta">Gemini Semantic Distance</span>
                  <div className="branch-score-pill">Rank #1: Score 1/61 = 0.0163</div>
                </div>
              </div>
              <div className="hybrid-combined-result">
                <span className="result-label">Fused Top Result:</span>
                <span className="result-title">yt-dlp/yt-dlp (Composite RRF Score: 0.0327)</span>
              </div>
            </div>
          )}

          {currentFeature.visualType === "sync-flow" && (
            <div className="visual-sync-card">
              <div className="visual-panel-header">
                <GithubIcon size={15} />
                <span>GitHub OAuth & Star Sync Engine</span>
              </div>
              <div className="sync-nodes-list">
                <div className="sync-node">
                  <div className="sync-node-icon"><KeyRound size={16} /></div>
                  <div className="sync-node-text">
                    <strong>PKCE State Authorization</strong>
                    <span>Read-only starring scope • Encrypted AES-256 tokens</span>
                  </div>
                </div>
                <div className="sync-arrow">↓</div>
                <div className="sync-node">
                  <div className="sync-node-icon"><RefreshCw size={16} /></div>
                  <div className="sync-node-text">
                    <strong>Atomic Page Leasing</strong>
                    <span>100 items/page • Heartbeat lease recovery</span>
                  </div>
                </div>
                <div className="sync-arrow">↓</div>
                <div className="sync-node">
                  <div className="sync-node-icon"><Database size={16} /></div>
                  <div className="sync-node-text">
                    <strong>Non-Destructive Upsert</strong>
                    <span>Preserves your custom notes, tags, and thumbnails</span>
                  </div>
                </div>
              </div>
            </div>
          )}

          {currentFeature.visualType === "security-shield" && (
            <div className="visual-security-card">
              <div className="visual-panel-header">
                <Shield size={15} />
                <span>Multi-Layer SSRF Defense</span>
              </div>
              <div className="security-checks-list">
                <div className="security-check-item pass">
                  <span className="check-status">PASS</span>
                  <span>DNS Public IPv4/IPv6 Validation</span>
                </div>
                <div className="security-check-item block">
                  <span className="check-status">BLOCKED</span>
                  <span>127.0.0.1, 10.0.0.0/8, 192.168.0.0/16</span>
                </div>
                <div className="security-check-item pass">
                  <span className="check-status">PASS</span>
                  <span>Manual Redirect Destination Inspection</span>
                </div>
                <div className="security-check-item pass">
                  <span className="check-status">PASS</span>
                  <span>Max 2MB Response Size Cap & 8s Timeout</span>
                </div>
              </div>
            </div>
          )}

          {currentFeature.visualType === "rls-code" && (
            <div className="visual-code-card">
              <div className="visual-panel-header">
                <Lock size={15} />
                <span>PostgreSQL Security Invariant</span>
              </div>
              <pre className="sql-snippet">
                <code>{`-- Mandatory Database Boundary
CREATE POLICY "Users can only access own items"
ON public.saved_items
FOR ALL
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);

-- Zero browser access to OAuth secrets
REVOKE ALL ON github_connection_secrets
FROM anon, authenticated;`}</code>
              </pre>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
