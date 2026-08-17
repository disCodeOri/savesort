"use client";

import { Check, Sparkles, X } from "lucide-react";

export function LandingComparison() {
  const comparisonRows = [
    {
      feature: "Vague & Concept-Based Semantic Search",
      grapplin: "768-dim vector embeddings via Gemini",
      browser: "Exact title string match only",
      readLater: "Basic keyword search",
    },
    {
      feature: "Automatic GitHub Star Sync",
      grapplin: "Yes • Real-time background sync & README indexing",
      browser: "No",
      readLater: "No",
    },
    {
      feature: "Lexical + Vector Hybrid Fusion (RRF)",
      grapplin: "Yes • Reciprocal Rank Fusion ranking",
      browser: "No",
      readLater: "No",
    },
    {
      feature: "Non-Destructive Bookmark Retention",
      grapplin: "Yes • Custom notes/tags survive re-syncs & unstars",
      browser: "Manual only",
      readLater: "Manual only",
    },
    {
      feature: "Zero-Trust SSRF & DNS Ingestion Guard",
      grapplin: "Yes • Strict loopback and private IP blocking",
      browser: "N/A",
      readLater: "Proprietary parser",
    },
    {
      feature: "Privacy & PostgreSQL Row-Level Security",
      grapplin: "100% Private • Database-enforced RLS",
      browser: "Synced to browser vendor account",
      readLater: "Centralized SaaS database",
    },
    {
      feature: "Graceful AI Offline/Quota Fallback",
      grapplin: "Yes • Retains full PostgreSQL full-text search",
      browser: "N/A",
      readLater: "Search degraded",
    },
  ];

  return (
    <section
      className="landing-comparison-section"
      id="comparison"
      aria-labelledby="comparison-heading"
    >
      <div className="section-header">
        <div className="landing-badge">
          <Sparkles size={13} />
          <span>The Grapplin Difference</span>
        </div>
        <h2 id="comparison-heading" className="section-title">
          Why traditional bookmarks are obsolete
        </h2>
        <p className="section-subtitle">
          See how Grapplin solves the fundamental flaw of digital bookmarking:
          saving things is easy, but finding them 6 months later is painful.
        </p>
      </div>

      <div className="comparison-table-wrapper">
        <table className="comparison-table">
          <thead>
            <tr>
              <th className="col-feature">Capabilities</th>
              <th className="col-grapplin">
                <span className="grapplin-header-badge">Grapplin</span>
              </th>
              <th className="col-others">Browser Bookmarks</th>
              <th className="col-others">Generic Read-It-Later</th>
            </tr>
          </thead>
          <tbody>
            {comparisonRows.map((row, idx) => (
              <tr key={idx}>
                <td className="row-feature-title">{row.feature}</td>
                <td className="row-grapplin-val">
                  <div className="val-content">
                    <Check size={16} className="check-icon" />
                    <span>{row.grapplin}</span>
                  </div>
                </td>
                <td className="row-other-val">
                  {row.browser === "No" ? (
                    <div className="val-content muted">
                      <X size={15} className="x-icon" />
                      <span>{row.browser}</span>
                    </div>
                  ) : (
                    <span>{row.browser}</span>
                  )}
                </td>
                <td className="row-other-val">
                  {row.readLater === "No" ? (
                    <div className="val-content muted">
                      <X size={15} className="x-icon" />
                      <span>{row.readLater}</span>
                    </div>
                  ) : (
                    <span>{row.readLater}</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
