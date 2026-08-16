"use client";

import Image from "next/image";
import Link from "next/link";
import { ArrowRight, Sparkles } from "lucide-react";

export function LandingCTA() {
  return (
    <section className="landing-cta-section" aria-labelledby="cta-heading">
      <div className="landing-cta-box">
        <div className="cta-graphic-backdrop" aria-hidden="true">
          <Image
            src="/grapplin-logo.png"
            alt=""
            width={320}
            height={320}
            className="cta-bg-logo"
          />
        </div>

        <div className="cta-content">
          <div className="landing-badge cta-badge">
            <Sparkles size={13} />
            <span>Get Started in Under 60 Seconds</span>
          </div>

          <h2 id="cta-heading" className="cta-title">
            Stop losing the best things you find on the internet.
          </h2>

          <p className="cta-subtitle">
            Join developers, researchers, and creators using Grapplin to build a
            permanent, instantly searchable second brain.
          </p>

          <div className="cta-button-row">
            <Link href="/login" className="button button-accent cta-main-btn">
              <span>Start Grapplin&apos; Now</span>
              <ArrowRight size={18} />
            </Link>
          </div>

          <div className="cta-perks">
            <span>✓ No credit card required</span>
            <span>✓ 100% Private PostgreSQL RLS</span>
            <span>✓ Automatic GitHub Star Sync</span>
          </div>
        </div>
      </div>
    </section>
  );
}
