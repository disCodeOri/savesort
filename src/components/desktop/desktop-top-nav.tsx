"use client";

import { LogOut, Plus, User } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";

import { signOutAction } from "@/app/auth/actions";

export function DesktopTopNav({
  email,
  onSaveClick,
}: {
  email: string;
  onSaveClick: () => void;
}) {
  const pathname = usePathname();
  const [accountOpen, setAccountOpen] = useState(false);

  const navLinks = [
    { href: "/search", label: "Search" },
    { href: "/library", label: "Library" },
    { href: "/search?tab=collections", label: "Collections" },
    { href: "/search?tab=sources", label: "Sources" },
    { href: "/search?tab=activity", label: "Activity" },
  ];

  return (
    <header className="desktop-top-nav-bar">
      <div className="desktop-nav-left">
        <Link
          href="/search"
          className="desktop-brand-link"
          aria-label="Grapplin home"
        >
          <Image
            src="/grapplin-logo.png"
            alt="Grapplin"
            width={140}
            height={36}
            className="desktop-logo-img"
            priority
          />
        </Link>
      </div>

      <nav className="desktop-center-links" aria-label="Main navigation">
        {navLinks.map((link) => {
          const isActive =
            link.href === "/search"
              ? pathname === "/search"
              : link.href === "/library"
                ? pathname === "/library"
                : pathname === "/search" &&
                  typeof window !== "undefined" &&
                  window.location.search.includes(
                    link.href.split("?")[1] || "",
                  );

          return (
            <Link
              key={link.label}
              href={link.href}
              className={`desktop-nav-tab ${isActive ? "nav-tab-active" : ""}`}
            >
              {link.label}
            </Link>
          );
        })}
      </nav>

      <div className="desktop-nav-right">
        <button
          type="button"
          className="desktop-save-cta-btn"
          onClick={onSaveClick}
        >
          <Plus size={16} strokeWidth={2.5} />
          <span>Save</span>
        </button>

        <div className="desktop-avatar-wrap">
          <button
            type="button"
            className="desktop-avatar-btn"
            onClick={() => setAccountOpen((prev) => !prev)}
            aria-expanded={accountOpen}
            aria-label="Account menu"
          >
            <div className="avatar-circle">
              <User size={18} />
              <span className="online-indicator-dot" />
            </div>
          </button>

          {accountOpen && (
            <div className="desktop-account-menu" role="menu">
              <div className="account-menu-email">
                <span>Signed in as</span>
                <strong>{email}</strong>
              </div>
              <form action={signOutAction}>
                <button type="submit" className="account-logout-item">
                  <LogOut size={15} />
                  <span>Log out</span>
                </button>
              </form>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
