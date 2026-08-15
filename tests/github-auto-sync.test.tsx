import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ runGitHubSync: vi.fn() }));

vi.mock("@/lib/github/sync-client", () => ({
  runGitHubSync: mocks.runGitHubSync,
}));

import { GitHubAutoSync } from "@/components/github-auto-sync";

const completeProgress = {
  status: "complete",
  discoveredCount: 0,
  savedCount: 0,
  skippedCount: 0,
};

describe("GitHubAutoSync", () => {
  beforeEach(() => {
    mocks.runGitHubSync.mockReset().mockResolvedValue(completeProgress);
  });

  afterEach(() => {
    window.history.replaceState({}, "", "/search");
    vi.restoreAllMocks();
  });

  it("syncs once after a login marker, clears only that marker, and announces completion", async () => {
    window.history.replaceState({}, "", "/search?githubSync=login");
    const onChanged = vi.fn();
    window.addEventListener("savesort:changed", onChanged);

    const view = render(<GitHubAutoSync />);

    await waitFor(() => {
      expect(mocks.runGitHubSync).toHaveBeenCalledTimes(1);
      expect(onChanged).toHaveBeenCalledTimes(1);
    });
    view.rerender(<GitHubAutoSync />);

    expect(window.location.pathname + window.location.search).toBe("/search");
    expect(mocks.runGitHubSync).toHaveBeenCalledTimes(1);
    window.removeEventListener("savesort:changed", onChanged);
  });

  it("does not sync without a supported marker", async () => {
    window.history.replaceState({}, "", "/search");

    render(<GitHubAutoSync />);

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mocks.runGitHubSync).not.toHaveBeenCalled();
  });

  it("shows a safe error without announcing a failed sync as a change", async () => {
    mocks.runGitHubSync.mockResolvedValue({
      status: "failed",
      discoveredCount: 0,
      savedCount: 0,
      skippedCount: 0,
    });
    window.history.replaceState({}, "", "/search?githubSync=login");
    const onChanged = vi.fn();
    window.addEventListener("savesort:changed", onChanged);

    render(<GitHubAutoSync />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "GitHub sync failed. Try again later.",
    );
    expect(onChanged).not.toHaveBeenCalled();
    window.removeEventListener("savesort:changed", onChanged);
  });
});
