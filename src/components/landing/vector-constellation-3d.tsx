"use client";

import { useEffect, useRef, useState } from "react";
import gsap from "gsap";
import { Sparkles } from "lucide-react";

interface Node3D {
  id: string;
  label: string;
  category: "ai" | "db" | "web" | "cli" | "sys";
  x: number;
  y: number;
  z: number;
  radius: number;
}

const INITIAL_NODES: Node3D[] = [
  {
    id: "1",
    label: "768-dim Vectors",
    category: "ai",
    x: 60,
    y: -40,
    z: 80,
    radius: 6,
  },
  {
    id: "2",
    label: "pgvector HNSW",
    category: "db",
    x: 90,
    y: 30,
    z: 50,
    radius: 5,
  },
  {
    id: "3",
    label: "yt-dlp Media CLI",
    category: "cli",
    x: -80,
    y: 70,
    z: 30,
    radius: 5,
  },
  {
    id: "4",
    label: "tsvector GIN",
    category: "db",
    x: -40,
    y: -80,
    z: -40,
    radius: 5,
  },
  {
    id: "5",
    label: "Reciprocal Rank Fusion",
    category: "ai",
    x: 20,
    y: 10,
    z: 100,
    radius: 7,
  },
  {
    id: "6",
    label: "GitHub Star Auto-Sync",
    category: "sys",
    x: -90,
    y: -20,
    z: 60,
    radius: 5,
  },
  {
    id: "7",
    label: "SSRF Zero-Trust Guard",
    category: "sys",
    x: -20,
    y: 90,
    z: -60,
    radius: 5,
  },
  {
    id: "8",
    label: "React Motion Physics",
    category: "web",
    x: 70,
    y: -70,
    z: -30,
    radius: 5,
  },
  {
    id: "9",
    label: "Rust Vector Engine",
    category: "cli",
    x: 100,
    y: -10,
    z: -70,
    radius: 5,
  },
  {
    id: "10",
    label: "PostgreSQL RLS",
    category: "db",
    x: -60,
    y: -60,
    z: 70,
    radius: 6,
  },
];

export function VectorConstellation3D() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [activeNode] = useState<Node3D | null>(INITIAL_NODES[4]);
  const rotationRef = useRef({ rotX: 0.2, rotY: 0.4 });
  const mouseRef = useRef({ x: 0, y: 0 });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let animId: number;
    let width = (canvas.width = canvas.parentElement?.clientWidth || 500);
    let height = (canvas.height = canvas.parentElement?.clientHeight || 360);

    const handleResize = () => {
      if (!canvas || !canvas.parentElement) return;
      width = canvas.width = canvas.parentElement.clientWidth;
      height = canvas.height = canvas.parentElement.clientHeight;
    };

    window.addEventListener("resize", handleResize);

    // Continuous smooth 3D rotation with mouse dampening
    const handleMouseMove = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      const nx = (e.clientX - rect.left) / rect.width - 0.5;
      const ny = (e.clientY - rect.top) / rect.height - 0.5;

      gsap.to(mouseRef.current, {
        x: nx * 1.2,
        y: ny * 1.2,
        duration: 0.8,
        ease: "power2.out",
      });
    };

    canvas.addEventListener("mousemove", handleMouseMove);

    const render = () => {
      ctx.clearRect(0, 0, width, height);

      // Advance base rotation
      rotationRef.current.rotY += 0.004 + mouseRef.current.x * 0.01;
      rotationRef.current.rotX += mouseRef.current.y * 0.01;

      const cosY = Math.cos(rotationRef.current.rotY);
      const sinY = Math.sin(rotationRef.current.rotY);
      const cosX = Math.cos(rotationRef.current.rotX);
      const sinX = Math.sin(rotationRef.current.rotX);

      const fov = 300;
      const centerX = width / 2;
      const centerY = height / 2;

      // Project 3D nodes to 2D
      const projected = INITIAL_NODES.map((node) => {
        // Rotate around Y
        const x1 = node.x * cosY - node.z * sinY;
        const z1 = node.z * cosY + node.x * sinY;

        // Rotate around X
        const y2 = node.y * cosX - z1 * sinX;
        const z2 = z1 * cosX + node.y * sinX;

        // Perspective scale
        const scale = fov / (fov + z2 + 150);
        const projX = centerX + x1 * scale;
        const projY = centerY + y2 * scale;

        return {
          ...node,
          projX,
          projY,
          scale,
          depth: z2,
        };
      });

      // Sort by depth for correct 3D rendering order
      projected.sort((a, b) => a.depth - b.depth);

      // Draw connection vectors between close nodes
      ctx.lineWidth = 1;
      for (let i = 0; i < projected.length; i++) {
        for (let j = i + 1; j < projected.length; j++) {
          const p1 = projected[i];
          const p2 = projected[j];
          const dist3D = Math.hypot(p1.x - p2.x, p1.y - p2.y, p1.z - p2.z);

          if (dist3D < 130) {
            const alpha =
              (1 - dist3D / 130) * 0.35 * Math.min(p1.scale, p2.scale);
            ctx.strokeStyle = `rgba(105, 65, 198, ${alpha})`;
            ctx.beginPath();
            ctx.moveTo(p1.projX, p1.projY);
            ctx.lineTo(p2.projX, p2.projY);
            ctx.stroke();
          }
        }
      }

      // Draw 3D nodes
      projected.forEach((node) => {
        const radius = Math.max(2, node.radius * node.scale);
        const isSelected = activeNode?.id === node.id;

        // Node Glow Ring if selected
        if (isSelected) {
          ctx.beginPath();
          ctx.arc(node.projX, node.projY, radius * 2.4, 0, Math.PI * 2);
          ctx.fillStyle = "rgba(200, 255, 26, 0.25)";
          ctx.fill();
        }

        // Node circle
        ctx.beginPath();
        ctx.arc(node.projX, node.projY, radius, 0, Math.PI * 2);

        if (node.category === "ai") {
          ctx.fillStyle = isSelected ? "#c8ff1a" : "#84cc16";
        } else if (node.category === "db") {
          ctx.fillStyle = isSelected ? "#a855f7" : "#6366f1";
        } else if (node.category === "sys") {
          ctx.fillStyle = isSelected ? "#38bdf8" : "#0284c7";
        } else {
          ctx.fillStyle = isSelected ? "#fb923c" : "#ea580c";
        }

        ctx.fill();
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = 1.5;
        ctx.stroke();

        // Node Label
        if (node.scale > 0.75) {
          ctx.font = `${Math.round(11 * node.scale)}px Inter, sans-serif`;
          ctx.fillStyle = isSelected ? "#0b1028" : "rgba(11, 16, 40, 0.75)";
          ctx.fillText(node.label, node.projX + radius + 5, node.projY + 3);
        }
      });

      animId = requestAnimationFrame(render);
    };

    render();

    return () => {
      cancelAnimationFrame(animId);
      window.removeEventListener("resize", handleResize);
      canvas.removeEventListener("mousemove", handleMouseMove);
    };
  }, [activeNode]);

  return (
    <div className="constellation-3d-wrapper">
      <div className="constellation-header">
        <div className="constellation-badge">
          <Sparkles size={13} />
          <span>768-Dimension Semantic Hyperspace</span>
        </div>
        <span className="constellation-hint">
          Interactive 3D Cosine Cluster
        </span>
      </div>

      <div className="constellation-canvas-container">
        <canvas ref={canvasRef} className="constellation-canvas" />
      </div>

      <div className="constellation-footer">
        <div className="constellation-legend">
          <span className="legend-item">
            <span className="dot dot-ai" /> Gemini Vectors
          </span>
          <span className="legend-item">
            <span className="dot dot-db" /> PostgreSQL HNSW
          </span>
          <span className="legend-item">
            <span className="dot dot-sys" /> Zero-Trust Security
          </span>
        </div>
        <span className="constellation-live-status">
          Cosine Angle: θ ≈ 0.04 rad
        </span>
      </div>
    </div>
  );
}
