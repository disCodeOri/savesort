"use client";

import {
  Activity,
  Bookmark,
  Boxes,
  Camera,
  Code2,
  FileText,
  Globe2,
  Home,
  MessageCircle,
  MoreHorizontal,
  Play,
  Search,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";

export function DesktopSidebar({
  activeSource,
  onSelectSource,
}: {
  activeSource?: string | null;
  onSelectSource?: (source: string | null) => void;
}) {
  const pathname = usePathname();
  const router = useRouter();

  const quickAccessItems = [
    { label: "Home", href: "/search", icon: Home },
    { label: "Search", href: "/search", icon: Search },
    { label: "Library", href: "/library", icon: Bookmark },
    { label: "Collections", href: "/library?tab=collections", icon: Boxes },
    { label: "Activity", href: "/library?tab=activity", icon: Activity },
    { label: "Sources", href: "/library?tab=sources", icon: Globe2 },
  ];

  const memoryCapsuleItems = [
    {
      label: "GitHub",
      source: "github",
      icon: Code2,
      badgeClass: "source-badge-github",
    },
    {
      label: "YouTube",
      source: "youtube",
      icon: Play,
      badgeClass: "source-badge-youtube",
    },
    {
      label: "Articles",
      source: "website",
      icon: FileText,
      badgeClass: "source-badge-article",
    },
    {
      label: "Reddit",
      source: "reddit",
      icon: MessageCircle,
      badgeClass: "source-badge-reddit",
    },
    {
      label: "Instagram",
      source: "instagram",
      icon: Camera,
      badgeClass: "source-badge-instagram",
    },
  ];

  function handleSourceClick(src: string) {
    if (onSelectSource) {
      onSelectSource(activeSource === src ? null : src);
    } else {
      router.push(`/search?source=${src}`);
    }
  }

  return (
    <aside className="desktop-left-sidebar" aria-label="Sidebar navigation">
      {/* 1. Quick Access Section */}
      <div className="sidebar-group">
        <h3 className="sidebar-group-title">QUICK ACCESS</h3>
        <nav className="sidebar-nav-list">
          {quickAccessItems.map((item) => {
            const Icon = item.icon;
            const isHome =
              item.label === "Home" && pathname === "/search" && !activeSource;
            const isActive = isHome || (pathname === item.href && !isHome);

            return (
              <Link
                key={item.label}
                href={item.href}
                className={`sidebar-nav-item ${isActive ? "sidebar-item-active" : ""}`}
              >
                <Icon size={18} />
                <span>{item.label}</span>
              </Link>
            );
          })}
        </nav>
      </div>

      {/* 2. Memory Capsules Section */}
      <div className="sidebar-group">
        <h3 className="sidebar-group-title">MEMORY CAPSULES</h3>
        <div className="sidebar-nav-list">
          {memoryCapsuleItems.map((item) => {
            const Icon = item.icon;
            const isSelected = activeSource === item.source;

            return (
              <button
                key={item.label}
                type="button"
                className={`sidebar-capsule-item ${isSelected ? "capsule-item-selected" : ""}`}
                onClick={() => handleSourceClick(item.source)}
              >
                <div className={`capsule-source-icon ${item.badgeClass}`}>
                  <Icon size={14} />
                </div>
                <span className="capsule-item-label">{item.label}</span>
              </button>
            );
          })}

          <button
            type="button"
            className="sidebar-capsule-item capsule-more-btn"
            onClick={() => {
              if (onSelectSource) onSelectSource(null);
            }}
          >
            <div className="capsule-source-icon source-badge-more">
              <MoreHorizontal size={14} />
            </div>
            <span className="capsule-item-label">More</span>
          </button>
        </div>
      </div>
    </aside>
  );
}
