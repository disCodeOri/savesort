"use client";

import { Bookmark, Cpu, Search, Sparkles } from "lucide-react";

export function LandingHowItWorks() {
  const steps = [
    {
      num: "01",
      title: "Snag Any Link",
      subtitle: "Save once, keep forever",
      desc: "Paste a URL manually, add quick notes, or let Grapplin automatically synchronize your GitHub starred repositories in the background.",
      icon: Bookmark,
      tag: "Ingest",
    },
    {
      num: "02",
      title: "Enrich & Embed",
      subtitle: "Dual-layer indexing",
      desc: "Our server-side worker extracts clean metadata and generates 768-dimension semantic embeddings alongside inverted full-text indexes.",
      icon: Cpu,
      tag: "Index",
    },
    {
      num: "03",
      title: "Recall With a Whisper",
      subtitle: "Hybrid search precision",
      desc: "Search using hazy descriptions ('that rust database engine') or exact keywords. Reciprocal Rank Fusion returns exactly what you meant.",
      icon: Search,
      tag: "Retrieve",
    },
  ];

  return (
    <section
      className="landing-how-section"
      id="how-it-works"
      aria-labelledby="how-heading"
    >
      <div className="section-header">
        <div className="landing-badge">
          <Sparkles size={13} />
          <span>Simple Workflow</span>
        </div>
        <h2 id="how-heading" className="section-title">
          Three steps to an infallible second brain
        </h2>
        <p className="section-subtitle">
          Designed with zero friction so you can focus on building, learning,
          and collecting without organizational burnout.
        </p>
      </div>

      <div className="how-steps-grid">
        {steps.map((step, idx) => {
          const Icon = step.icon;
          return (
            <div key={idx} className="how-step-card">
              <div className="step-card-top">
                <span className="step-number">{step.num}</span>
                <span className="step-tag">{step.tag}</span>
              </div>
              <div className="step-icon-wrapper">
                <Icon size={24} />
              </div>
              <h3 className="step-title">{step.title}</h3>
              <span className="step-subtitle">{step.subtitle}</span>
              <p className="step-desc">{step.desc}</p>
            </div>
          );
        })}
      </div>
    </section>
  );
}
