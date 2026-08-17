"use client";

import { useEffect, useRef, useState } from "react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import {
  ArrowRight,
  Bookmark,
  CheckCircle2,
  Cpu,
  Database,
  ExternalLink,
  Search,
  Sparkles,
  Zap,
} from "lucide-react";

import { GithubIcon } from "@/components/landing/icons";

interface StepData {
  id: number;
  navTitle: string;
  navSubtitle: string;
  heading: string;
  description: string;
  highlightPill: string;
}

const STEPS: StepData[] = [
  {
    id: 0,
    navTitle: "Think naturally",
    navSubtitle: "Hazy thoughts & broken phrases",
    heading: "Search the way your memory actually works",
    description:
      "Ramble, use vague descriptions, or remember just one detail. Grapplin doesn't demand exact filenames or boolean query syntax. It passes your thoughts through Gemini to extract 768-dimensional semantic meaning instantly.",
    highlightPill: "Semantic Vectorization Active",
  },
  {
    id: 1,
    navTitle: "Dual-engine fusion",
    navSubtitle: "Keywords + 768d vectors combined",
    heading: "PostgreSQL full-text meets pgvector cosine ranking",
    description:
      "Why rely on AI alone or old-fashioned keywords? Grapplin runs PostgreSQL tsvector inverted index search in parallel with high-dimensional vector cosine distance, fusing the rankings with Reciprocal Rank Fusion (RRF).",
    highlightPill: "RRF Mathematical Fusion",
  },
  {
    id: 2,
    navTitle: "Instant recall",
    navSubtitle: "Full context & zero secret leakage",
    heading: "Your saved knowledge, surfaced in 0.03 seconds",
    description:
      "The exact repository or article is restored with its original metadata, extracted README excerpts, custom tags, and personal notes — safely protected by PostgreSQL Row-Level Security.",
    highlightPill: "100% Context Restored",
  },
];

export function ScrollShowcase() {
  const [activeStep, setActiveStep] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const indicatorRef = useRef<HTMLDivElement>(null);

  // ScrollTrigger Pinned Scrollytelling Setup
  useEffect(() => {
    if (typeof window === "undefined") return;
    gsap.registerPlugin(ScrollTrigger);

    const container = containerRef.current;
    if (!container) return;

    const ctx = gsap.context(() => {
      // Create a scrubbed ScrollTrigger pinned sequence
      ScrollTrigger.create({
        trigger: container,
        start: "top top+=70",
        end: "+=1800",
        pin: true,
        scrub: 0.5,
        onUpdate: (self) => {
          const progress = self.progress;
          if (progress < 0.33) {
            setActiveStep(0);
          } else if (progress < 0.67) {
            setActiveStep(1);
          } else {
            setActiveStep(2);
          }
        },
      });
    }, container);

    return () => ctx.revert();
  }, []);

  // Update vertical stepper indicator position
  useEffect(() => {
    if (!indicatorRef.current) return;
    gsap.to(indicatorRef.current, {
      y: activeStep * 68,
      duration: 0.35,
      ease: "power2.out",
    });
  }, [activeStep]);

  const currentStep = STEPS[activeStep];

  return (
    <section
      className="scroll-showcase-section"
      ref={containerRef}
      aria-labelledby="showcase-heading"
    >
      <div className="showcase-inner-container">
        {/* Left Column: Vertical Scrollytelling Nav */}
        <div className="showcase-left-col">
          <div className="showcase-stepper-track">
            <div className="showcase-stepper-indicator" ref={indicatorRef} />
            {STEPS.map((step) => (
              <button
                key={step.id}
                type="button"
                onClick={() => setActiveStep(step.id)}
                className={`showcase-nav-item ${activeStep === step.id ? "nav-item-active" : ""}`}
                aria-current={activeStep === step.id ? "step" : undefined}
              >
                <span className="nav-item-title">{step.navTitle}</span>
                <span className="nav-item-sub">{step.navSubtitle}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Center Column: Animated Dynamic Mockup Card */}
        <div className="showcase-center-col">
          <div className="showcase-mockup-card">
            {/* Visual Header */}
            <div className="mockup-header-bar">
              <div className="mockup-dots">
                <span className="dot dot-red" />
                <span className="dot dot-yellow" />
                <span className="dot dot-green" />
              </div>
              <div className="mockup-title">
                <Sparkles size={13} className="sparkle-accent" />
                <span>Grapplin Neural Pipeline</span>
              </div>
              <span className="mockup-step-tag">
                Step {activeStep + 1} of 3
              </span>
            </div>

            {/* Visual Body based on Active Step */}
            <div className="mockup-display-area">
              {activeStep === 0 && (
                <div className="step-visual step-0-visual">
                  <div className="vague-query-box">
                    <span className="query-meta-label">
                      User Query (Messy Human Memory):
                    </span>
                    <div className="query-text-stream">
                      <Search size={16} className="query-search-icon" />
                      <span className="query-typing">
                        &ldquo;that{" "}
                        <mark className="hl-pink">fast rust cli tool</mark> for{" "}
                        <mark className="hl-orange">
                          downloading &amp; converting 4k audio/video
                        </mark>{" "}
                        I starred last month&rdquo;
                      </span>
                    </div>
                  </div>

                  <div className="audio-wave-pill">
                    <div className="wave-bars">
                      <span className="bar bar-1" />
                      <span className="bar bar-2" />
                      <span className="bar bar-3" />
                      <span className="bar bar-4" />
                      <span className="bar bar-5" />
                      <span className="bar bar-6" />
                    </div>
                    <span className="wave-text">
                      768-dim Vector Projection Generating
                    </span>
                  </div>

                  <div className="floating-concept-tags">
                    <span className="f-tag tag-rust">#rust-cli</span>
                    <span className="f-tag tag-yt">#media-downloader</span>
                    <span className="f-tag tag-audio">#audio-extraction</span>
                    <span className="f-tag tag-speed">#high-perf</span>
                  </div>
                </div>
              )}

              {activeStep === 1 && (
                <div className="step-visual step-1-visual">
                  <div className="dual-engine-streams">
                    {/* Stream 1: PostgreSQL Keyword Rank */}
                    <div className="engine-stream-box stream-keyword">
                      <div className="stream-header">
                        <Database size={14} />
                        <span>PostgreSQL Inverted tsvector</span>
                      </div>
                      <div className="stream-calc">
                        <code>
                          SELECT ts_rank_cd(text_vector, &apos;cli &amp;
                          download&apos;)
                        </code>
                        <span className="stream-score">
                          Rank #1 (Score: 0.94)
                        </span>
                      </div>
                    </div>

                    {/* Fusion Connector */}
                    <div className="fusion-junction">
                      <div className="junction-line" />
                      <div className="junction-badge">
                        <Zap size={15} />
                        <span>RRF = Σ 1 / (60 + r)</span>
                      </div>
                      <div className="junction-line" />
                    </div>

                    {/* Stream 2: pgvector Cosine Search */}
                    <div className="engine-stream-box stream-vector">
                      <div className="stream-header">
                        <Cpu size={14} />
                        <span>pgvector 768-dim Cosine Distance</span>
                      </div>
                      <div className="stream-calc">
                        <code>
                          ORDER BY embedding &lt;=&gt; query_vector LIMIT 20
                        </code>
                        <span className="stream-score">
                          Cosine: 0.982 (Distance: 0.018)
                        </span>
                      </div>
                    </div>
                  </div>

                  <div className="fusion-result-banner">
                    <CheckCircle2 size={15} className="banner-check" />
                    <span>
                      RRF Fused Rank #1: Score 0.0327 • Confidence 99.4%
                    </span>
                  </div>
                </div>
              )}

              {activeStep === 2 && (
                <div className="step-visual step-2-visual">
                  <div className="retrieved-hero-card">
                    <div className="card-top-status">
                      <span className="card-source-pill">
                        <GithubIcon size={14} />
                        <span>GitHub Starred Repository</span>
                      </span>
                      <span className="card-match-badge">
                        <Zap size={12} />
                        <span>99% Match</span>
                      </span>
                    </div>

                    <h4 className="card-title">yt-dlp / yt-dlp</h4>
                    <p className="card-desc">
                      A feature-rich command-line audio/video downloader with
                      support for thousands of video sites, audio extraction,
                      format conversion, and metadata embedding.
                    </p>

                    <div className="card-meta-row">
                      <div className="meta-tags">
                        <span className="meta-tag">#python</span>
                        <span className="meta-tag">#cli</span>
                        <span className="meta-tag">#youtube</span>
                        <span className="meta-tag">#audio</span>
                      </div>
                      <span className="retrieval-time">Retrieved in 32ms</span>
                    </div>

                    <div className="card-actions-row">
                      <a
                        href="https://github.com/yt-dlp/yt-dlp"
                        target="_blank"
                        rel="noreferrer"
                        className="button button-accent card-open-btn"
                      >
                        <span>Open Resource</span>
                        <ExternalLink size={14} />
                      </a>
                      <span className="card-rls-note">
                        <Bookmark size={13} />
                        <span>Saved on 2026-08-15</span>
                      </span>
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Visual Footer */}
            <div className="mockup-footer-bar">
              <div className="footer-status-pill">
                <span className="status-dot-live" />
                <span>{currentStep.highlightPill}</span>
              </div>
              <span className="footer-latency">0.03s Latency</span>
            </div>
          </div>
        </div>

        {/* Right Column: Step Descriptive Content */}
        <div className="showcase-right-col">
          <div className="showcase-content-pane">
            <span className="showcase-step-label">Stage 0{activeStep + 1}</span>
            <h3 id="showcase-heading" className="showcase-heading">
              {currentStep.heading}
            </h3>
            <p className="showcase-description">{currentStep.description}</p>

            <div className="showcase-action-box">
              <a
                href="#demo"
                className="button button-secondary showcase-try-btn"
              >
                <span>Try In Sandbox Below</span>
                <ArrowRight size={15} />
              </a>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
