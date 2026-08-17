"use client";

import Image from "next/image";
import Link from "next/link";
import { Heart } from "lucide-react";

import { GithubIcon } from "@/components/landing/icons";

export function LandingFooter() {
  return (
    <footer className="landing-footer">
      <div className="landing-footer-inner">
        <div className="footer-brand-col">
          <Link
            href="/"
            className="landing-brand-logo-link"
            aria-label="Grapplin home"
          >
            <Image
              src="/grapplin-logo.png"
              alt="Grapplin"
              width={180}
              height={90}
              className="landing-footer-logo"
            />
          </Link>
          <p className="footer-brand-tagline">
            The intelligent grapple for the web. Snag any link and recall it
            effortlessly with exact words or vague memories.
          </p>
        </div>

        <div className="footer-links-group">
          <div className="footer-col">
            <h4 className="footer-col-title">Navigation</h4>
            <ul className="footer-list">
              <li>
                <a href="#demo">Live Sandbox</a>
              </li>
              <li>
                <a href="#pipeline-demo">Ingestion Pipeline</a>
              </li>
              <li>
                <a href="#features">Core Features</a>
              </li>
              <li>
                <a href="#how-it-works">How It Works</a>
              </li>
              <li>
                <a href="#comparison">Comparison</a>
              </li>
              <li>
                <a href="#faq">FAQ</a>
              </li>
            </ul>
          </div>

          <div className="footer-col">
            <h4 className="footer-col-title">Stack</h4>
            <ul className="footer-list">
              <li>
                <span>Next.js 16 App Router</span>
              </li>
              <li>
                <span>Supabase PostgreSQL</span>
              </li>
              <li>
                <span>pgvector Cosine Search</span>
              </li>
              <li>
                <span>Gemini 768d Embeddings</span>
              </li>
              <li>
                <span>GSAP Motion</span>
              </li>
            </ul>
          </div>

          <div className="footer-col">
            <h4 className="footer-col-title">Access</h4>
            <ul className="footer-list">
              <li>
                <Link href="/login">Sign In / Sign Up</Link>
              </li>
              <li>
                <Link href="/search">Search Library</Link>
              </li>
              <li>
                <Link href="/library">Manage Stars</Link>
              </li>
            </ul>
          </div>
        </div>
      </div>

      <div className="footer-bottom-bar">
        <p className="footer-copy">
          © {new Date().getFullYear()} Grapplin. Built with precision, privacy,
          and open standards.
        </p>
        <div className="footer-badges">
          <span className="footer-badge">
            <GithubIcon size={13} />
            <span>GitHub Sync Enabled</span>
          </span>
          <span className="footer-badge">
            <Heart size={13} color="#c22929" />
            <span>100% Private</span>
          </span>
        </div>
      </div>
    </footer>
  );
}
