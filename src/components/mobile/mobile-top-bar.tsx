"use client";

import { LogOut, Search, User, X } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { signOutAction } from "@/app/auth/actions";

export function MobileTopBar({
  email,
  onSearchClick,
}: {
  email: string;
  onSearchClick?: () => void;
}) {
  const [accountOpen, setAccountOpen] = useState(false);

  return (
    <header className="mobile-topbar-v2" aria-label="Mobile header">
      <Link
        href="/search"
        className="mobile-brand-title-link"
        aria-label="Grapplin home"
      >
        <span className="mobile-brand-text">GRAPPLIN</span>
      </Link>

      <div className="mobile-topbar-right-actions">
        <button
          type="button"
          className="mobile-top-search-btn"
          onClick={onSearchClick}
          aria-label="Search items"
        >
          <Search size={19} />
        </button>

        <button
          type="button"
          className="mobile-top-avatar-btn"
          onClick={() => setAccountOpen((prev) => !prev)}
          aria-expanded={accountOpen}
          aria-label="Account details"
        >
          <div className="avatar-circle-sm">
            <User size={16} />
            <span className="online-dot-sm" />
          </div>
        </button>

        {accountOpen && (
          <div
            className="mobile-account-popover"
            role="dialog"
            aria-label="Account menu"
          >
            <div className="mobile-account-header">
              <div className="mobile-account-user-info">
                <span className="account-label">Signed in as</span>
                <strong className="account-email">{email}</strong>
              </div>
              <button
                type="button"
                className="mobile-account-close"
                onClick={() => setAccountOpen(false)}
                aria-label="Close menu"
              >
                <X size={16} />
              </button>
            </div>

            <div className="mobile-account-actions">
              <form action={signOutAction}>
                <button type="submit" className="mobile-logout-btn">
                  <LogOut size={16} />
                  <span>Log out of Grapplin</span>
                </button>
              </form>
            </div>
          </div>
        )}
      </div>
    </header>
  );
}
