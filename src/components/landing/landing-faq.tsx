"use client";

import { useState } from "react";
import { ChevronDown, HelpCircle } from "lucide-react";

interface FAQItem {
  question: string;
  answer: string;
}

const FAQS: FAQItem[] = [
  {
    question: "How does semantic search find links when I only remember a vague description?",
    answer:
      "When a URL is saved, Grapplin passes its title, description, topics, and bounded README excerpts to Gemini embedding models to generate a 768-dimensional normalized mathematical vector. When you search using natural language (e.g. 'that python tool for downloading audio'), Grapplin converts your query into a vector and calculates cosine similarity across your library in pgvector. Even if the words don't match exactly, the semantic concept matches instantly.",
  },
  {
    question: "What happens if Gemini is rate-limited or unavailable?",
    answer:
      "Grapplin has an automatic deterministic keyword fallback. Every item is indexed with PostgreSQL's native tsvector inverted index. If AI embedding generation fails or is offline, your search transparently degrades to full-text lexical ranking. You will never be locked out of finding your saved items.",
  },
  {
    question: "How does GitHub Star Sync protect my GitHub account?",
    answer:
      "Grapplin uses a dedicated GitHub App OAuth flow using PKCE state validation and requests only read-only starring scope. It has zero repository write permissions. Access tokens are encrypted at rest with 256-bit AES-GCM and used exclusively by server-side workers; they are never sent to the browser or stored in client-readable cookies.",
  },
  {
    question: "If I unstar a repository on GitHub, will Grapplin delete my saved bookmark?",
    answer:
      "No. Grapplin uses non-destructive synchronization. When you unstar a repository on GitHub, the saved item remains safely in your Grapplin library along with your personal notes, custom tags, and edits. You have total control to delete items manually from your Grapplin library whenever you choose.",
  },
  {
    question: "How is my saved library isolated from other users?",
    answer:
      "Data isolation is enforced directly at the database engine level via PostgreSQL Row-Level Security (RLS). Every query operates in a secure context verified against `auth.uid() = user_id`. No user can query or discover another user's saved items or search vectors.",
  },
  {
    question: "Can I save restricted social media platforms like X/Twitter or Instagram?",
    answer:
      "Yes. While Grapplin strictly respects platform terms and never scrapes restricted platforms, you can save any link with your own title, summary, notes, or transcript. Grapplin will embed your text and make it fully searchable with both keyword and vector search.",
  },
];

export function LandingFAQ() {
  const [openIndex, setOpenIndex] = useState<number | null>(0);

  const toggle = (idx: number) => {
    setOpenIndex(openIndex === idx ? null : idx);
  };

  return (
    <section className="landing-faq-section" id="faq" aria-labelledby="faq-heading">
      <div className="section-header">
        <div className="landing-badge">
          <HelpCircle size={13} />
          <span>Frequently Asked Questions</span>
        </div>
        <h2 id="faq-heading" className="section-title">
          Everything you need to know about Grapplin
        </h2>
        <p className="section-subtitle">
          Transparent answers about architecture, security, AI embeddings, and data
          retention.
        </p>
      </div>

      <div className="faq-accordion-list">
        {FAQS.map((faq, idx) => {
          const isOpen = openIndex === idx;
          return (
            <div
              key={idx}
              className={`faq-item-card ${isOpen ? "faq-item-open" : ""}`}
            >
              <button
                type="button"
                className="faq-question-btn"
                onClick={() => toggle(idx)}
                aria-expanded={isOpen}
              >
                <span className="faq-question-text">{faq.question}</span>
                <ChevronDown
                  size={18}
                  className={`faq-chevron ${isOpen ? "faq-chevron-rotated" : ""}`}
                />
              </button>
              {isOpen && (
                <div className="faq-answer-pane">
                  <p className="faq-answer-text">{faq.answer}</p>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
