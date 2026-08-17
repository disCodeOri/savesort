"use client";

import { useState } from "react";

import { DesktopSidebar } from "@/components/desktop/desktop-sidebar";
import { DesktopTopNav } from "@/components/desktop/desktop-top-nav";
import { GitHubAutoSync } from "@/components/github-auto-sync";
import { MobileBottomNav } from "@/components/mobile/mobile-bottom-nav";
import { MobileTopBar } from "@/components/mobile/mobile-top-bar";
import { RedditAutoSync } from "@/components/reddit-auto-sync";
import { SaveSheet } from "@/components/save-sheet";

export function AppShell({
  children,
  email,
}: {
  children: React.ReactNode;
  email: string;
}) {
  const [saveOpen, setSaveOpen] = useState(false);

  return (
    <div className="grapplin-app-root">
      {/* 1. Desktop Top Navigation (Visible on Desktop >= 1024px) */}
      <div className="desktop-nav-shell">
        <DesktopTopNav email={email} onSaveClick={() => setSaveOpen(true)} />
      </div>

      {/* 2. Mobile Top Bar (Visible on Mobile <= 640px) */}
      <div className="mobile-nav-shell">
        <MobileTopBar email={email} />
      </div>

      <GitHubAutoSync />
      <RedditAutoSync />

      {/* 3. Main Workspace Layout (Sidebar + Main Application Area) */}
      <div className="grapplin-workspace-layout">
        {/* Desktop Left Sidebar */}
        <div className="desktop-sidebar-shell">
          <DesktopSidebar />
        </div>

        {/* Main Application Content */}
        <main className="grapplin-main-workspace" id="main-content">
          {children}
        </main>
      </div>

      {/* 4. Mobile Floating Bottom Navigation Dock */}
      <div className="mobile-dock-shell">
        <MobileBottomNav onSaveClick={() => setSaveOpen(true)} />
      </div>

      {/* 5. Global Save Modal / Sheet */}
      <SaveSheet open={saveOpen} onClose={() => setSaveOpen(false)} />
    </div>
  );
}
