"use client";

import Image from "next/image";
import Link from "next/link";
import { ArrowRight, LogIn, Sparkles } from "lucide-react";

interface LandingNavProps {
  isAuthenticated: boolean;
}

export function LandingNav({ isAuthenticated }: LandingNavProps) {
  return (
    <header className="landing-nav-wrapper">
      <nav className="landing-nav" aria-label="Main Navigation">
        <Link
          href="/"
          className="landing-brand-logo-link"
          aria-label="Grapplin home"
        >
          <Image
            src="/grapplin-logo.png"
            alt="Grapplin"
            width={200}
            height={100}
            className="landing-nav-logo"
            priority
          />
        </Link>

        <div className="landing-nav-links">
          <a href="#demo" className="landing-nav-link">
            Live Demo
          </a>
          <a href="#features" className="landing-nav-link">
            Features
          </a>
          <a href="#how-it-works" className="landing-nav-link">
            How It Works
          </a>
          <a href="#github-sync" className="landing-nav-link">
            GitHub Sync
          </a>
          <a href="#comparison" className="landing-nav-link">
            Comparison
          </a>
          <a href="#faq" className="landing-nav-link">
            FAQ
          </a>
        </div>

        <div className="landing-nav-actions">
          {isAuthenticated ? (
            <Link
              href="/search"
              className="button button-accent landing-cta-btn"
            >
              <span>Open Grapplin</span>
              <ArrowRight size={16} />
            </Link>
          ) : (
            <>
              <Link href="/login" className="landing-login-link">
                <LogIn size={15} />
                <span>Sign in</span>
              </Link>
              <Link
                href="/login"
                className="button button-primary landing-cta-btn"
              >
                <span>Get Started</span>
                <Sparkles size={15} />
              </Link>
            </>
          )}
        </div>
      </nav>
    </header>
  );
}
