"use client";

import { Bookmark, Boxes, Plus, Search, User } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

export function MobileBottomNav({
  onSaveClick,
  onAccountClick,
}: {
  onSaveClick: () => void;
  onAccountClick?: () => void;
}) {
  const pathname = usePathname();

  return (
    <nav
      className="mobile-floating-dock-v2 mobile-glass"
      aria-label="Mobile navigation dock"
    >
      <Link
        href="/search"
        className={`mobile-dock-item-v2 ${pathname === "/search" ? "dock-item-active" : ""}`}
        aria-label="Search"
      >
        <Search size={20} />
        <span>Search</span>
      </Link>

      <Link
        href="/library"
        className={`mobile-dock-item-v2 ${pathname === "/library" ? "dock-item-active" : ""}`}
        aria-label="Library"
      >
        <Bookmark size={20} />
        <span>Library</span>
      </Link>

      <button
        type="button"
        className="mobile-dock-save-btn-v2"
        onClick={onSaveClick}
        aria-label="Save something"
      >
        <Plus size={22} strokeWidth={2.5} />
      </button>

      <Link
        href="/library?tab=collections"
        className={`mobile-dock-item-v2 ${pathname.includes("collections") ? "dock-item-active" : ""}`}
        aria-label="Collections"
      >
        <Boxes size={20} />
        <span>Collections</span>
      </Link>

      {onAccountClick ? (
        <button
          type="button"
          className="mobile-dock-item-v2"
          onClick={onAccountClick}
          aria-label="Account details"
        >
          <User size={20} />
          <span>Me</span>
        </button>
      ) : (
        <Link
          href="/library?tab=me"
          className="mobile-dock-item-v2"
          aria-label="Me"
        >
          <User size={20} />
          <span>Me</span>
        </Link>
      )}
    </nav>
  );
}
