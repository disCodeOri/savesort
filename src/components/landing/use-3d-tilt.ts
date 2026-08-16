"use client";

import { useEffect, useRef } from "react";
import gsap from "gsap";

interface Use3DTiltOptions {
  maxTilt?: number;
  perspective?: number;
  scale?: number;
  speed?: number;
}

export function use3DTilt<T extends HTMLElement>(options: Use3DTiltOptions = {}) {
  const ref = useRef<T>(null);
  const {
    maxTilt = 7,
    perspective = 1400,
    scale = 1.012,
    speed = 0.35,
  } = options;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    // Hardware acceleration & 3D context
    el.style.transformStyle = "preserve-3d";
    el.style.perspective = `${perspective}px`;
    el.style.willChange = "transform";

    const handleMouseMove = (e: MouseEvent) => {
      const rect = el.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      const centerX = rect.width / 2;
      const centerY = rect.height / 2;

      const rotateX = ((y - centerY) / centerY) * -maxTilt;
      const rotateY = ((x - centerX) / centerX) * maxTilt;

      gsap.to(el, {
        rotateX,
        rotateY,
        scale,
        duration: speed,
        ease: "power2.out",
        overwrite: "auto",
        transformPerspective: perspective,
      });
    };

    const handleMouseLeave = () => {
      gsap.to(el, {
        rotateX: 0,
        rotateY: 0,
        scale: 1,
        duration: 0.45,
        ease: "power2.out",
        overwrite: "auto",
      });
    };

    el.addEventListener("mousemove", handleMouseMove, { passive: true });
    el.addEventListener("mouseleave", handleMouseLeave);

    return () => {
      el.removeEventListener("mousemove", handleMouseMove);
      el.removeEventListener("mouseleave", handleMouseLeave);
      gsap.killTweensOf(el);
    };
  }, [maxTilt, perspective, scale, speed]);

  return ref;
}
