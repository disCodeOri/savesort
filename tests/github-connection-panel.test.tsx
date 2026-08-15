import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ runGitHubSync: vi.fn() }));

vi.mock("@/lib/github/sync-client", () => ({
  runGitHubSync: mocks.runGitHubSync,
}));

import { GitHubConnectionPanel } from "@/components/github-connection-panel";

const connectedConnection = {
  connected: true,
  githubLogin: "octocat",
  githubAvatarUrl: "https://avatars.githubusercontent.com/u/1?v=4",
  connectionStatus: "connected",
  syncStatus: "idle",
  lastSyncedAt: "2026-08-15T10:30:00.000Z",
  discoveredCount: 3,
  savedCount: 3,
  skippedCount: 0,
  lastSyncError: null,
};

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function renderPanel(onLibraryChanged = vi.fn()) {
  return render(<GitHubConnectionPanel onLibraryChanged={onLibraryChanged} />);
}

describe("GitHubConnectionPanel", () => {
  beforeEach(() => {
    mocks.runGitHubSync.mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("explains how to connect when GitHub is disconnected", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(response({ connection: null })),
    );

    renderPanel();

    expect(
      await screen.findByText(
        "Connect GitHub to keep your starred repositories searchable.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Connect GitHub" }),
    ).toHaveAttribute("href", "/api/github/connect");
  });

  it("shows the connected account and enables a manual sync", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(response({ connection: connectedConnection })),
    );

    renderPanel();

    expect(
      await screen.findByAltText("octocat's GitHub avatar"),
    ).toHaveAttribute("src", connectedConnection.githubAvatarUrl);
    expect(screen.getByText("octocat")).toBeInTheDocument();
    expect(screen.getByText(/Last synced/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sync now" })).toBeEnabled();
  });

  it("refreshes its connection status when the library changes", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        response({
          connection: { ...connectedConnection, syncStatus: "running" },
        }),
      )
      .mockResolvedValueOnce(response({ connection: connectedConnection }));
    vi.stubGlobal("fetch", fetchMock);

    renderPanel();

    expect(
      await screen.findByText("Syncing GitHub stars…"),
    ).toBeInTheDocument();
    window.dispatchEvent(new Event("savesort:changed"));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("button", { name: "Sync now" })).toBeEnabled();
    expect(screen.queryByText("Syncing GitHub stars…")).not.toBeInTheDocument();
  });

  it("allows manual recovery from a persisted running sync", async () => {
    mocks.runGitHubSync.mockImplementation(() => new Promise(() => undefined));
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        response({
          connection: { ...connectedConnection, syncStatus: "running" },
        }),
      ),
    );

    renderPanel();

    const syncButton = await screen.findByRole("button", { name: "Sync now" });
    expect(syncButton).toBeEnabled();
    expect(screen.getByText("Syncing GitHub stars…")).toBeInTheDocument();

    fireEvent.click(syncButton);

    expect(mocks.runGitHubSync).toHaveBeenCalledTimes(1);
    expect(syncButton).toBeDisabled();
  });

  it("disables manual sync and announces progress while syncing", async () => {
    mocks.runGitHubSync.mockImplementation(() => new Promise(() => undefined));
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(response({ connection: connectedConnection })),
    );

    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: "Sync now" }));

    expect(screen.getByRole("button", { name: "Sync now" })).toBeDisabled();
    expect(screen.getByText("Syncing GitHub stars…")).toHaveAttribute(
      "aria-live",
      "polite",
    );
  });

  it("asks the user to reconnect when GitHub access has expired", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        response({
          connection: {
            ...connectedConnection,
            connected: false,
            connectionStatus: "reconnect_required",
          },
        }),
      ),
    );

    renderPanel();

    expect(
      await screen.findByText(
        "GitHub access expired. Reconnect to resume syncing.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Reconnect GitHub" }),
    ).toHaveAttribute("href", "/api/github/connect");
    expect(screen.queryByText("octocat")).not.toBeInTheDocument();
  });

  it("disconnects after confirmation and returns to the connection prompt", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response({ connection: connectedConnection }))
      .mockResolvedValueOnce(response({ disconnected: true }));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(window, "confirm").mockReturnValue(true);

    renderPanel();
    fireEvent.click(
      await screen.findByRole("button", { name: "Disconnect GitHub" }),
    );

    expect(window.confirm).toHaveBeenCalledWith(
      "Disconnect GitHub? Your saved repositories will stay in SaveSort.",
    );
    await waitFor(() => {
      expect(fetchMock).toHaveBeenLastCalledWith("/api/github/connection", {
        method: "DELETE",
      });
    });
    expect(
      await screen.findByRole("link", { name: "Connect GitHub" }),
    ).toBeInTheDocument();
  });

  it("reports newly saved repositories and refreshes the library after manual sync", async () => {
    const onLibraryChanged = vi.fn();
    mocks.runGitHubSync.mockResolvedValue({
      status: "complete",
      discoveredCount: 4,
      savedCount: 3,
      skippedCount: 1,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(response({ connection: connectedConnection })),
    );

    renderPanel(onLibraryChanged);
    fireEvent.click(await screen.findByRole("button", { name: "Sync now" }));

    expect(
      await screen.findByText("Saved 3 new repositories"),
    ).toBeInTheDocument();
    expect(mocks.runGitHubSync).toHaveBeenCalledTimes(1);
    expect(onLibraryChanged).toHaveBeenCalledTimes(1);
  });
});
