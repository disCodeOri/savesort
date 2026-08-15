import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  continueGitHubSync: vi.fn(),
  requireUser: vi.fn(),
  startGitHubSync: vi.fn(),
}));

vi.mock("server-only", () => ({}));

vi.mock("@/lib/auth/require-user", () => ({
  requireUser: mocks.requireUser,
}));

vi.mock("@/lib/github/sync", () => ({
  continueGitHubSync: mocks.continueGitHubSync,
  GitHubSyncError: class GitHubSyncError extends Error {
    constructor(public readonly kind: string) {
      super(
        kind === "conflict"
          ? "This GitHub sync is no longer active. Start a new sync."
          : kind === "rate_limited"
            ? "GitHub is rate limited. Try again later."
            : "GitHub sync is temporarily unavailable. Try again later.",
      );
      this.name = "GitHubSyncError";
    }
  },
  startGitHubSync: mocks.startGitHubSync,
}));

import { POST } from "@/app/api/github/sync/route";
import { GitHubSyncError } from "@/lib/github/sync";

const userId = "a17f824a-0d1f-48fe-8d2e-6a4777c9d113";
const syncId = "1e4d9e32-169e-42a2-98b2-ddb82c27d261";

function request(body: unknown): NextRequest {
  return new NextRequest("http://localhost:3000/api/github/sync", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/github/sync", () => {
  beforeEach(() => {
    mocks.requireUser.mockReset().mockResolvedValue({
      supabase: {},
      user: { id: userId },
    });
    mocks.startGitHubSync.mockReset().mockResolvedValue({
      status: "complete",
      discoveredCount: 0,
      savedCount: 0,
      skippedCount: 0,
    });
    mocks.continueGitHubSync.mockReset();
  });

  it("requires a user before parsing or starting a sync", async () => {
    mocks.requireUser.mockRejectedValue(new Error("AUTH_REQUIRED"));

    const response = await POST(request({ action: "start" }));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: "Please sign in to continue.",
    });
    expect(mocks.startGitHubSync).not.toHaveBeenCalled();
    expect(mocks.continueGitHubSync).not.toHaveBeenCalled();
  });

  it.each([
    {},
    { action: "unknown" },
    { action: "continue" },
    { action: "continue", syncId: "not-a-uuid" },
  ])("rejects an invalid sync request body %#", async (body) => {
    const response = await POST(request(body));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Check the sync request and try again.",
    });
    expect(mocks.startGitHubSync).not.toHaveBeenCalled();
    expect(mocks.continueGitHubSync).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON as an invalid request", async () => {
    const malformed = new NextRequest("http://localhost:3000/api/github/sync", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });

    const response = await POST(malformed);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Check the sync request and try again.",
    });
  });

  it("starts one page and returns bounded running progress", async () => {
    mocks.startGitHubSync.mockResolvedValue({
      status: "running",
      syncId,
      nextPage: 2,
      discoveredCount: 100,
      savedCount: 98,
      skippedCount: 2,
    });

    const response = await POST(request({ action: "start" }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      status: "running",
      syncId,
      nextPage: 2,
      discoveredCount: 100,
      savedCount: 98,
      skippedCount: 2,
    });
    expect(mocks.startGitHubSync).toHaveBeenCalledWith(userId);
    expect(JSON.stringify(body)).not.toMatch(/token|ciphertext|secret/i);
  });

  it("continues the requested sync and returns cursor-free completion", async () => {
    mocks.continueGitHubSync.mockResolvedValue({
      status: "complete",
      discoveredCount: 102,
      savedCount: 100,
      skippedCount: 2,
    });

    const response = await POST(request({ action: "continue", syncId }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      status: "complete",
      discoveredCount: 102,
      savedCount: 100,
      skippedCount: 2,
    });
    expect(mocks.continueGitHubSync).toHaveBeenCalledWith(userId, syncId);
    expect(body).not.toHaveProperty("syncId");
    expect(body).not.toHaveProperty("nextPage");
    expect(JSON.stringify(body)).not.toMatch(/token|ciphertext|secret/i);
  });

  it.each([
    [
      "conflict",
      409,
      "This GitHub sync is no longer active. Start a new sync.",
    ],
    ["rate_limited", 429, "GitHub is rate limited. Try again later."],
    [
      "unavailable",
      503,
      "GitHub sync is temporarily unavailable. Try again later.",
    ],
  ] as const)(
    "maps %s sync failures to safe HTTP errors",
    async (kind, status, message) => {
      mocks.startGitHubSync.mockRejectedValue(new GitHubSyncError(kind));

      const response = await POST(request({ action: "start" }));

      expect(response.status).toBe(status);
      await expect(response.json()).resolves.toEqual({ error: message });
    },
  );

  it("sends unknown failures through the shared safe error response", async () => {
    mocks.startGitHubSync.mockRejectedValue(
      new Error("database string containing a secret"),
    );

    const response = await POST(request({ action: "start" }));
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toEqual({
      error: "Something went wrong. Please try again.",
    });
    expect(JSON.stringify(body)).not.toContain("database string");
    expect(JSON.stringify(body)).not.toContain("secret");
  });
});
