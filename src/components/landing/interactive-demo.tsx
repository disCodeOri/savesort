"use client";

import { useState } from "react";
import {
  CheckCircle2,
  Cpu,
  Database,
  ExternalLink,
  Globe,
  Lock,
  Play,
  RefreshCw,
  ShieldCheck,
  Sparkles,
} from "lucide-react";

import { GithubIcon } from "@/components/landing/icons";

interface PipelineStep {
  title: string;
  desc: string;
  status: "pending" | "running" | "completed";
  detail: string;
}

const PRELOADED_LINKS = [
  {
    id: "link-1",
    url: "https://github.com/astral-sh/uv",
    label: "astral-sh / uv (GitHub Repo)",
    type: "github",
    title:
      "astral-sh/uv: An extremely fast Python package and project manager written in Rust",
    summary:
      "A single binary replacing pip, pip-tools, virtualenv, and poetry. Built with Rust for 10-100x speedups, universal lockfiles, and workspace resolution.",
    topics: ["rust", "python", "package-manager", "cli", "fast"],
    vectorPreview: "[-0.041, 0.089, -0.012, 0.054, ... +764 dims]",
    tsvector:
      "'astral':1 'fast':5 'packag':7 'pip':12 'python':6 'rust':11 'uv':2",
  },
  {
    id: "link-2",
    url: "https://arxiv.org/abs/2310.06825",
    label: "Mistral 7B (Research Paper)",
    type: "article",
    title: "Mistral 7B: Efficient Attention & Sliding Window Transformers",
    summary:
      "Introduces a 7B parameter language model outperforming 13B models across all benchmarks, featuring Grouped-query attention (GQA) and Sliding Window Attention (SWA).",
    topics: ["ai", "transformers", "nlp", "llm", "research"],
    vectorPreview: "[0.072, -0.038, 0.091, -0.019, ... +764 dims]",
    tsvector:
      "'attent':4 'benchmark':11 'llm':14 'mistral':1 'model':8 'transform':6",
  },
  {
    id: "link-3",
    url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    label: "Rick Astley - Never Gonna Give You Up (Video)",
    type: "video",
    title:
      "Rick Astley - Never Gonna Give You Up (Official Music Video 4K Remaster)",
    summary:
      "The official music video for Rick Astley’s 1987 global number one hit single, featuring 4K dynamic restoration and nostalgic 80s synth-pop production.",
    topics: ["music", "synth-pop", "classic", "youtube", "80s"],
    vectorPreview: "[0.018, -0.082, 0.044, 0.063, ... +764 dims]",
    tsvector:
      "'1987':9 'astley':2 'music':6 'never':3 'rick':1 'synth-pop':14 'video':7",
  },
];

export function InteractiveDemo() {
  const [selectedLink, setSelectedLink] = useState(PRELOADED_LINKS[0]);
  const [customUrl, setCustomUrl] = useState("");
  const [isGrappling, setIsGrappling] = useState(false);
  const [activeStepIndex, setActiveStepIndex] = useState(3); // 0..3

  const handleSimulateGrapple = (linkItem: (typeof PRELOADED_LINKS)[0]) => {
    setSelectedLink(linkItem);
    setIsGrappling(true);
    setActiveStepIndex(0);

    const stepTimers = [
      setTimeout(() => setActiveStepIndex(1), 500),
      setTimeout(() => setActiveStepIndex(2), 1100),
      setTimeout(() => {
        setActiveStepIndex(3);
        setIsGrappling(false);
      }, 1700),
    ];

    return () => stepTimers.forEach(clearTimeout);
  };

  const steps: PipelineStep[] = [
    {
      title: "1. SSRF Guard & URL Validation",
      desc: "Validates protocol, resolves DNS, blocks private/loopback IPs, and verifies content-type.",
      status:
        activeStepIndex > 0
          ? "completed"
          : activeStepIndex === 0
            ? "running"
            : "pending",
      detail: `Checked DNS for ${new URL(selectedLink.url).hostname} • Status: 200 OK (Public IPv4 Verified)`,
    },
    {
      title: "2. Safe Metadata & README Extraction",
      desc: "Fetches OpenGraph title, tags, description, and capped README excerpts without running untrusted scripts.",
      status:
        activeStepIndex > 1
          ? "completed"
          : activeStepIndex === 1
            ? "running"
            : "pending",
      detail: `Extracted ${selectedLink.topics.length} tags • Length: ${selectedLink.summary.length} chars`,
    },
    {
      title: "3. Dual-Engine Vector & tsvector Indexing",
      desc: "Generates 768-dimension normalized Gemini embedding and PostgreSQL tsvector lexeme mapping.",
      status: activeStepIndex >= 2 ? "completed" : "pending",
      detail: `pgvector: 768 dims • tsvector: ${selectedLink.tsvector.split(" ").length} lexemes`,
    },
  ];

  return (
    <section
      className="interactive-demo-section"
      id="pipeline-demo"
      aria-labelledby="pipeline-heading"
    >
      <div className="section-header">
        <div className="landing-badge">
          <Cpu size={13} />
          <span>Ingestion & Embedding Engine</span>
        </div>
        <h2 id="pipeline-heading" className="section-title">
          How Grapplin digests any URL in 1.2 seconds
        </h2>
        <p className="section-subtitle">
          Watch the zero-trust ingestion pipeline normalize external content,
          block SSRF vulnerabilities, extract rich metadata, and build
          768-dimension semantic representations.
        </p>
      </div>

      <div className="demo-playground-grid">
        {/* Left Column: Preset Link Selection */}
        <div className="demo-left-panel">
          <h3 className="panel-title">Choose a sample link to grapple:</h3>
          <div className="sample-links-list">
            {PRELOADED_LINKS.map((link) => (
              <button
                key={link.id}
                type="button"
                onClick={() => handleSimulateGrapple(link)}
                className={`sample-link-btn ${selectedLink.id === link.id ? "sample-link-active" : ""}`}
                disabled={isGrappling}
              >
                <div className="sample-link-icon">
                  {link.type === "github" ? (
                    <GithubIcon size={18} />
                  ) : link.type === "article" ? (
                    <Database size={18} />
                  ) : (
                    <Globe size={18} />
                  )}
                </div>
                <div className="sample-link-meta">
                  <span className="sample-link-label">{link.label}</span>
                  <span className="sample-link-url">{link.url}</span>
                </div>
                <Play size={14} className="sample-link-play" />
              </button>
            ))}
          </div>

          <div className="demo-custom-box">
            <span className="custom-box-title">Or test any custom URL:</span>
            <div className="custom-input-group">
              <input
                type="url"
                value={customUrl}
                onChange={(e) => setCustomUrl(e.target.value)}
                placeholder="https://github.com/..."
                className="custom-url-input"
              />
              <button
                type="button"
                onClick={() => {
                  if (!customUrl) return;
                  handleSimulateGrapple({
                    id: "custom",
                    url: customUrl,
                    label: "Custom Public URL",
                    type: "website",
                    title: "Custom Ingested Resource: " + customUrl,
                    summary:
                      "Auto-extracted public page metadata and bounded text parsed by Grapplin server-side ingestion worker.",
                    topics: ["custom-url", "web-resource"],
                    vectorPreview: "[0.021, -0.044, 0.078, ... +765 dims]",
                    tsvector: "'custom':1 'page':3 'resource':2 'web':4",
                  });
                }}
                disabled={!customUrl || isGrappling}
                className="button button-accent custom-grapple-btn"
              >
                {isGrappling ? (
                  <RefreshCw size={14} className="spin" />
                ) : (
                  <Sparkles size={14} />
                )}
                <span>Grapple</span>
              </button>
            </div>
          </div>
        </div>

        {/* Right Column: Real-Time Pipeline Inspection */}
        <div className="demo-right-panel">
          <div className="pipeline-steps-wrapper">
            <div className="pipeline-header-row">
              <span className="pipeline-header-title">
                Live Ingestion Inspector
              </span>
              <span className="pipeline-security-tag">
                <ShieldCheck size={13} />
                <span>Zero-Trust SSRF Shield Active</span>
              </span>
            </div>

            <div className="pipeline-steps-list">
              {steps.map((step, idx) => (
                <div
                  key={idx}
                  className={`pipeline-step-card ${
                    step.status === "completed"
                      ? "step-completed"
                      : step.status === "running"
                        ? "step-running"
                        : "step-pending"
                  }`}
                >
                  <div className="step-indicator">
                    {step.status === "completed" ? (
                      <CheckCircle2 size={16} className="step-icon-done" />
                    ) : step.status === "running" ? (
                      <RefreshCw size={16} className="step-icon-running spin" />
                    ) : (
                      <div className="step-icon-idle" />
                    )}
                  </div>
                  <div className="step-body">
                    <h4 className="step-title">{step.title}</h4>
                    <p className="step-desc">{step.desc}</p>
                    {step.status !== "pending" && (
                      <div className="step-detail-pill">
                        <code>{step.detail}</code>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>

            {/* Ingestion Stored Result Preview */}
            <div className="pipeline-output-preview">
              <div className="output-header">
                <span className="output-label">
                  Final Stored Searchable Record
                </span>
                <span className="output-rls-badge">
                  <Lock size={12} />
                  <span>RLS Protected (auth.uid = owner)</span>
                </span>
              </div>

              <div className="output-card-box">
                <h4 className="output-title">
                  {selectedLink.title}
                  <ExternalLink size={13} />
                </h4>
                <p className="output-summary">{selectedLink.summary}</p>
                <div className="output-meta-row">
                  <div className="output-tags">
                    {selectedLink.topics.map((t) => (
                      <span key={t} className="output-tag">
                        #{t}
                      </span>
                    ))}
                  </div>
                  <span className="output-vector-meta">
                    Vector: <code>{selectedLink.vectorPreview}</code>
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
