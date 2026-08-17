"use client";

import {
  Brush,
  ChevronRight,
  Code2,
  Cpu,
  Gamepad2,
  Layers,
  Palette,
  Smile,
  Sparkles,
  Zap,
} from "lucide-react";

export interface CollectionCluster {
  id: string;
  label: string;
  query: string;
  icons: Array<React.ComponentType<{ size?: number }>>;
  colors: string[];
}

const CLUSTERS: CollectionCluster[] = [
  {
    id: "cluster-games",
    label: "Games",
    query: "gaming game dev physics engine rust",
    icons: [Gamepad2, Sparkles, Zap, Gamepad2],
    colors: ["#1e293b", "#0f766e", "#be185d", "#4338ca"],
  },
  {
    id: "cluster-art",
    label: "Art",
    query: "ui design creative direction typography css",
    icons: [Palette, Brush, Layers, Palette],
    colors: ["#047857", "#374151", "#1e1b4b", "#6b21a8"],
  },
  {
    id: "cluster-tech",
    label: "Technology",
    query: "software engineering vector database postgres ai",
    icons: [Code2, Cpu, Zap, Code2],
    colors: ["#1e293b", "#b91c1c", "#1e3a8a", "#0f172a"],
  },
  {
    id: "cluster-humor",
    label: "Humor",
    query: "reddit funny memes engineering humor tech stories",
    icons: [Smile, Sparkles, Smile, Sparkles],
    colors: ["#78350f", "#854d0e", "#1c1917", "#451a03"],
  },
];

export function CollectionClusterRail({
  onSelectCluster,
}: {
  onSelectCluster?: (query: string) => void;
}) {
  return (
    <section
      className="mobile-communities-section"
      aria-label="Collections and Topics"
    >
      <div className="mobile-section-header">
        <div>
          <h2 className="mobile-section-heading">Communities</h2>
          <p className="mobile-section-sub">Popular chat rooms</p>
        </div>
        <button type="button" className="mobile-see-all-btn">
          <span>See all</span>
          <ChevronRight size={15} />
        </button>
      </div>

      <div className="mobile-clusters-row">
        {CLUSTERS.map((cluster) => {
          return (
            <button
              key={cluster.id}
              type="button"
              className="cluster-item-btn"
              onClick={() => onSelectCluster?.(cluster.query)}
              aria-label={`Collection cluster: ${cluster.label}`}
            >
              <div className="cluster-2x2-circle-grid">
                {cluster.icons.map((Icon, idx) => (
                  <div
                    key={idx}
                    className="cluster-mini-circle"
                    style={{ background: cluster.colors[idx] }}
                  >
                    <Icon size={12} />
                  </div>
                ))}
              </div>
              <span className="cluster-item-label">{cluster.label}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
