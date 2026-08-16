"use client";

import { useEffect, useRef } from "react";
import Image from "next/image";
import Link from "next/link";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { ArrowRight, BookOpen, Sparkles } from "lucide-react";

const THOUGHT_CAPSULES = [
  {
    id: 1,
    text: "“that python tool for extracting clean audio from 4k videos”",
    tag: "yt-dlp",
    position: "thought-pos-1",
    depth: 40,
    delay: 0,
  },
  {
    id: 2,
    text: "“typescript canvas framework with spring physics”",
    tag: "motion-canvas",
    position: "thought-pos-2",
    depth: 60,
    delay: 0.4,
  },
  {
    id: 3,
    text: "“article explaining postgres hybrid vector search math”",
    tag: "supabase-rrf",
    position: "thought-pos-3",
    depth: 45,
    delay: 0.8,
  },
  {
    id: 4,
    text: "“fast rust vector similarity engine with hnsw”",
    tag: "qdrant",
    position: "thought-pos-4",
    depth: 70,
    delay: 1.2,
  },
];

export function CinematicThoughtBanner() {
  const bannerRef = useRef<HTMLDivElement>(null);
  const bgImageRef = useRef<HTMLDivElement>(null);
  const pathRef = useRef<SVGPathElement>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    gsap.registerPlugin(ScrollTrigger);

    const banner = bannerRef.current;
    if (!banner) return;

    const ctx = gsap.context(() => {
      // 1. Subtle Parallax Zoom on Background Image as you scroll
      if (bgImageRef.current) {
        gsap.fromTo(
          bgImageRef.current,
          { scale: 1.05, y: -20 },
          {
            scale: 1.15,
            y: 20,
            ease: "none",
            scrollTrigger: {
              trigger: banner,
              start: "top bottom",
              end: "bottom top",
              scrub: 1,
            },
          },
        );
      }

      // 2. Animate the Dotted SVG Loop Path
      if (pathRef.current) {
        gsap.to(pathRef.current, {
          strokeDashoffset: -400,
          duration: 20,
          repeat: -1,
          ease: "none",
        });
      }

      // 3. Floating Sine Waves on Thought Capsules
      const capsules = banner.querySelectorAll(".thought-capsule");
      capsules.forEach((capsule, i) => {
        gsap.to(capsule, {
          y: i % 2 === 0 ? -12 : 12,
          x: i % 3 === 0 ? 6 : -6,
          rotateZ: i % 2 === 0 ? 1.5 : -1.5,
          duration: 3.5 + i * 0.4,
          repeat: -1,
          yoyo: true,
          ease: "sine.inOut",
          delay: i * 0.3,
        });
      });

      // 4. Staggered Entrance on Scroll
      gsap.fromTo(
        banner.querySelectorAll(".cinematic-fade-in"),
        { opacity: 0, y: 35, scale: 0.96 },
        {
          opacity: 1,
          y: 0,
          scale: 1,
          stagger: 0.15,
          duration: 0.9,
          ease: "power3.out",
          scrollTrigger: {
            trigger: banner,
            start: "top 78%",
            toggleActions: "play none none none",
          },
        },
      );
    }, banner);

    return () => ctx.revert();
  }, []);

  return (
    <section className="cinematic-banner-section" ref={bannerRef} aria-label="Start Grapplin flow">
      <div className="cinematic-banner-wrapper">
        {/* Background Image with Parallax & Cinematic Gradient */}
        <div className="cinematic-bg-container" ref={bgImageRef}>
          <Image
            src="/city-night-flow.jpg"
            alt="Thoughtful focus and creative flow"
            fill
            priority={false}
            className="cinematic-bg-img"
            sizes="(max-width: 1200px) 100vw, 1200px"
          />
          <div className="cinematic-gradient-overlay" />
        </div>

        {/* Animated Dotted SVG Flow Loop (Inspired by Wispr Loop) */}
        <svg
          className="cinematic-svg-trajectory"
          viewBox="0 0 1000 600"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          aria-hidden="true"
        >
          <path
            ref={pathRef}
            d="M -50,450 C 200,480 350,220 500,280 C 650,340 750,120 900,180 C 980,220 1020,400 880,500 C 740,600 600,480 480,420 C 320,340 100,500 50,560"
            stroke="rgba(255, 255, 255, 0.4)"
            strokeWidth="3"
            strokeDasharray="8 12"
            strokeLinecap="round"
          />
        </svg>

        {/* Floating Thought / Memory Capsules */}
        <div className="cinematic-thoughts-layer" aria-hidden="true">
          {THOUGHT_CAPSULES.map((thought) => (
            <div
              key={thought.id}
              className={`thought-capsule ${thought.position}`}
              data-depth={thought.depth}
            >
              <div className="capsule-bubble">
                <Sparkles size={12} className="capsule-icon" />
                <span className="capsule-text">{thought.text}</span>
              </div>
              <span className="capsule-match-tag">#{thought.tag}</span>
            </div>
          ))}
        </div>

        {/* Central Editorial Content */}
        <div className="cinematic-content-box">
          <div className="cinematic-badge cinematic-fade-in">
            <span className="badge-glow-dot" />
            <span>Effortless Recall Everywhere</span>
          </div>

          <h2 className="cinematic-headline cinematic-fade-in">
            Start grapplin’
            <span className="cinematic-dots">
              <span className="dot-pulse d-1">.</span>
              <span className="dot-pulse d-2">.</span>
              <span className="dot-pulse d-3">.</span>
              <span className="dot-pulse d-4">.</span>
              <span className="dot-pulse d-5">.</span>
            </span>
          </h2>

          <p className="cinematic-subtext cinematic-fade-in">
            Never lose a breakthrough link, open-source gem, or research article again.
            Save in a keystroke, recall in a whisper.
          </p>

          <div className="cinematic-cta-row cinematic-fade-in">
            <Link href="/login" className="button button-accent cinematic-primary-btn">
              <span>Claim Your Private Library</span>
              <ArrowRight size={17} />
            </Link>
            <a href="#pipeline-demo" className="button cinematic-secondary-btn">
              <BookOpen size={16} />
              <span>Explore Ingestion Pipeline</span>
            </a>
          </div>
        </div>
      </div>
    </section>
  );
}
