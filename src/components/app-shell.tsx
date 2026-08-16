"use client";

import { Bookmark, LogOut, Menu, Plus, Search, X } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";

import { signOutAction } from "@/app/auth/actions";
import { GitHubAutoSync } from "@/components/github-auto-sync";
import { SaveSheet } from "@/components/save-sheet";

export function AppShell({
  children,
  email,
}: {
  children: React.ReactNode;
  email: string;
}) {
  const pathname = usePathname();
  const [saveOpen, setSaveOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <div className="app-frame">
      <header className="topbar">
        <Link className="brand-logo-link" href="/search" aria-label="Grapplin home">
          <Image
            src="/grapplin-logo.png"
            alt="Grapplin"
            width={180}
            height={90}
            className="app-brand-logo"
            priority
          />
        </Link>
        <nav className="desktop-nav" aria-label="Primary navigation">
          <Link
            className={pathname === "/search" ? "active" : ""}
            href="/search"
          >
            <Search size={18} /> Search
          </Link>
          <Link
            className={pathname === "/library" ? "active" : ""}
            href="/library"
          >
            <Bookmark size={18} /> Library
          </Link>
        </nav>
        <div className="topbar-actions">
          <button
            className="button button-ink save-top"
            onClick={() => setSaveOpen(true)}
          >
            Save something <Plus size={18} />
          </button>
          <button
            className="menu-button"
            aria-expanded={menuOpen}
            aria-label="Open account menu"
            onClick={() => setMenuOpen((open) => !open)}
          >
            {menuOpen ? <X size={20} /> : <Menu size={20} />}
          </button>
          {menuOpen ? (
            <div className="account-menu">
              <span>{email}</span>
              <form action={signOutAction}>
                <button type="submit">
                  <LogOut size={17} /> Log out
                </button>
              </form>
            </div>
          ) : null}
        </div>
      </header>

      <GitHubAutoSync />
      <div className="page-canvas">{children}</div>

      <button
        className="mobile-save"
        aria-label="Save something"
        onClick={() => setSaveOpen(true)}
      >
        <Plus />
      </button>
      <nav className="mobile-nav" aria-label="Mobile navigation">
        <Link className={pathname === "/search" ? "active" : ""} href="/search">
          <Search />
          <span>Search</span>
        </Link>
        <Link
          className={pathname === "/library" ? "active" : ""}
          href="/library"
        >
          <Bookmark />
          <span>Library</span>
        </Link>
      </nav>
      <SaveSheet open={saveOpen} onClose={() => setSaveOpen(false)} />
    </div>
  );
}
