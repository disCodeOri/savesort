"use client";

import { useEffect, useRef } from "react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";

import { CinematicThoughtBanner } from "@/components/landing/cinematic-thought-banner";
import { InteractiveDemo } from "@/components/landing/interactive-demo";
import { LandingComparison } from "@/components/landing/landing-comparison";
import { LandingCTA } from "@/components/landing/landing-cta";
import { LandingFAQ } from "@/components/landing/landing-faq";
import { LandingFeatures } from "@/components/landing/landing-features";
import { LandingFooter } from "@/components/landing/landing-footer";
import { LandingHero } from "@/components/landing/landing-hero";
import { LandingHowItWorks } from "@/components/landing/landing-how-it-works";
import { LandingNav } from "@/components/landing/landing-nav";
import { ScrollShowcase } from "@/components/landing/scroll-showcase";

interface LandingPageProps {
  isAuthenticated: boolean;
}

export function LandingPage({ isAuthenticated }: LandingPageProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;

    gsap.registerPlugin(ScrollTrigger);

    const ctx = gsap.context(() => {
      // 1. Initial 3D Hero Stagger Entrance Animation
      const heroTl = gsap.timeline({ defaults: { ease: "power3.out" } });

      heroTl
        .fromTo(
          ".landing-nav-wrapper",
          { y: -30, opacity: 0 },
          { y: 0, opacity: 1, duration: 0.6 },
        )
        .fromTo(
          ".landing-badge",
          { y: 20, opacity: 0, rotateX: 20 },
          { y: 0, opacity: 1, rotateX: 0, duration: 0.5 },
          "-=0.3",
        )
        .fromTo(
          ".landing-hero-title",
          { y: 35, opacity: 0, rotateX: 15 },
          { y: 0, opacity: 1, rotateX: 0, duration: 0.8 },
          "-=0.3",
        )
        .fromTo(
          ".landing-hero-subtitle",
          { y: 20, opacity: 0 },
          { y: 0, opacity: 1, duration: 0.6 },
          "-=0.4",
        )
        .fromTo(
          ".landing-hero-cta-group",
          { y: 20, opacity: 0 },
          { y: 0, opacity: 1, duration: 0.5 },
          "-=0.4",
        )
        .fromTo(
          ".hero-metrics-strip",
          { y: 20, opacity: 0, scale: 0.96 },
          { y: 0, opacity: 1, scale: 1, duration: 0.6 },
          "-=0.3",
        )
        .fromTo(
          ".landing-hero-visual",
          { y: 50, opacity: 0, rotateX: 18, rotateY: -10, scale: 0.95 },
          { y: 0, opacity: 1, rotateX: 0, rotateY: 0, scale: 1, duration: 1 },
          "-=0.6",
        )
        .fromTo(
          ".floating-satellite",
          { scale: 0.4, opacity: 0, z: 60 },
          { scale: 1, opacity: 1, z: 60, stagger: 0.1, duration: 0.7, ease: "back.out(1.7)" },
          "-=0.5",
        );

      // 2. Continuous 3D Floating Satellites Physics
      const satellites = document.querySelectorAll(".floating-satellite");
      satellites.forEach((sat, i) => {
        gsap.to(sat, {
          y: i % 2 === 0 ? -14 : 14,
          x: i % 3 === 0 ? 8 : -8,
          z: 60,
          rotateZ: i % 2 === 0 ? 2 : -2,
          duration: 3 + (i % 3) * 0.8,
          repeat: -1,
          yoyo: true,
          ease: "sine.inOut",
          delay: i * 0.4,
        });
      });

      // 3. ScrollTrigger 3D Section Reveals with Perspective Tilt
      const revealSections = [
        { selector: ".demo-playground-grid", trigger: "#pipeline-demo" },
        { selector: ".feature-showcase-box", trigger: "#features" },
        { selector: ".how-steps-grid", trigger: "#how-it-works" },
        { selector: ".comparison-table-wrapper", trigger: "#comparison" },
        { selector: ".faq-accordion-list", trigger: "#faq" },
        { selector: ".landing-cta-box", trigger: ".landing-cta-section" },
      ];

      revealSections.forEach(({ selector, trigger }) => {
        const el = document.querySelector(selector);
        if (el) {
          gsap.fromTo(
            el,
            {
              opacity: 0,
              y: 50,
              rotateX: 10,
              scale: 0.97,
              transformPerspective: 1200,
            },
            {
              opacity: 1,
              y: 0,
              rotateX: 0,
              scale: 1,
              duration: 0.9,
              ease: "power3.out",
              scrollTrigger: {
                trigger,
                start: "top 82%",
                toggleActions: "play none none none",
              },
            },
          );
        }
      });

      // 4. Staggered 3D Cards in How It Works Grid
      const stepCards = document.querySelectorAll(".how-step-card");
      if (stepCards.length > 0) {
        gsap.fromTo(
          stepCards,
          { opacity: 0, y: 40, rotateY: 10 },
          {
            opacity: 1,
            y: 0,
            rotateY: 0,
            duration: 0.7,
            stagger: 0.16,
            ease: "power2.out",
            scrollTrigger: {
              trigger: ".how-steps-grid",
              start: "top 80%",
              toggleActions: "play none none none",
            },
          },
        );
      }

      // 5. Section Headers Stagger
      const sectionHeaders = document.querySelectorAll(".section-header");
      sectionHeaders.forEach((header) => {
        gsap.fromTo(
          header,
          { opacity: 0, y: 30 },
          {
            opacity: 1,
            y: 0,
            duration: 0.7,
            ease: "power2.out",
            scrollTrigger: {
              trigger: header,
              start: "top 85%",
              toggleActions: "play none none none",
            },
          },
        );
      });
    }, containerRef);

    return () => ctx.revert();
  }, []);

  return (
    <div className="landing-page-root" ref={containerRef}>
      <LandingNav isAuthenticated={isAuthenticated} />
      <main className="landing-main-container">
        <LandingHero />
        <ScrollShowcase />
        <InteractiveDemo />
        <LandingFeatures />
        <LandingHowItWorks />
        <CinematicThoughtBanner />
        <LandingComparison />
        <LandingFAQ />
        <LandingCTA />
      </main>
      <LandingFooter />
    </div>
  );
}
