import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  headers: vi.fn(),
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
  createClient: vi.fn(),
}));

vi.mock("next/headers", () => ({
  headers: mocks.headers,
}));

vi.mock("next/navigation", () => ({
  redirect: mocks.redirect,
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: mocks.createClient,
}));

import {
  signInAction,
  signInWithGoogleAction,
  signOutAction,
  signUpAction,
} from "@/app/auth/actions";

describe("auth actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.headers.mockResolvedValue(
      new Headers({ origin: "http://localhost:3000" }),
    );
  });

  describe("signInWithGoogleAction", () => {
    it("redirects to OAuth URL on successful initialization", async () => {
      const signInWithOAuth = vi.fn().mockResolvedValue({
        data: { url: "https://accounts.google.com/o/oauth2/v2/auth?test=1" },
        error: null,
      });
      mocks.createClient.mockResolvedValue({
        auth: { signInWithOAuth },
      });

      await expect(signInWithGoogleAction()).rejects.toThrow(
        "REDIRECT:https://accounts.google.com/o/oauth2/v2/auth?test=1",
      );

      expect(signInWithOAuth).toHaveBeenCalledWith({
        provider: "google",
        options: {
          redirectTo:
            "http://localhost:3000/auth/callback?next=%2Fsearch%3FgithubSync%3Dlogin%26redditSync%3Dlogin",
        },
      });
    });

    it("redirects to login with error when OAuth initiation fails", async () => {
      const signInWithOAuth = vi.fn().mockResolvedValue({
        data: { url: null },
        error: { message: "OAuth provider error" },
      });
      mocks.createClient.mockResolvedValue({
        auth: { signInWithOAuth },
      });

      await expect(signInWithGoogleAction()).rejects.toThrow(
        "REDIRECT:/login?error=OAuth%20provider%20error",
      );
    });
  });

  describe("signInAction", () => {
    it("redirects on validation failure", async () => {
      const formData = new FormData();
      formData.set("email", "invalid");
      formData.set("password", "short");

      await expect(signInAction(formData)).rejects.toThrow(
        "REDIRECT:/login?error=Enter%20a%20valid%20email%20address.",
      );
    });

    it("redirects to search with a sync trigger for each provider", async () => {
      const signInWithPassword = vi.fn().mockResolvedValue({
        data: { session: {} },
        error: null,
      });
      mocks.createClient.mockResolvedValue({
        auth: { signInWithPassword },
      });

      const formData = new FormData();
      formData.set("email", "user@example.com");
      formData.set("password", "password123");

      await expect(signInAction(formData)).rejects.toThrow(
        "REDIRECT:/search?githubSync=login&redditSync=login",
      );
      expect(signInWithPassword).toHaveBeenCalledWith({
        email: "user@example.com",
        password: "password123",
      });
    });
  });

  describe("signUpAction", () => {
    it("redirects to login with message when confirmation is required", async () => {
      const signUp = vi.fn().mockResolvedValue({
        data: { user: {}, session: null },
        error: null,
      });
      mocks.createClient.mockResolvedValue({
        auth: { signUp },
      });

      const formData = new FormData();
      formData.set("email", "user@example.com");
      formData.set("password", "password123");

      await expect(signUpAction(formData)).rejects.toThrow(
        "REDIRECT:/login?message=Check%20your%20email%20to%20confirm%20your%20account.",
      );
    });

    it("redirects to search when signup creates active session immediately", async () => {
      const signUp = vi.fn().mockResolvedValue({
        data: { user: {}, session: {} },
        error: null,
      });
      mocks.createClient.mockResolvedValue({
        auth: { signUp },
      });

      const formData = new FormData();
      formData.set("email", "user@example.com");
      formData.set("password", "password123");

      await expect(signUpAction(formData)).rejects.toThrow("REDIRECT:/search");
    });
  });

  describe("signOutAction", () => {
    it("signs out and redirects to login", async () => {
      const signOut = vi.fn().mockResolvedValue({ error: null });
      mocks.createClient.mockResolvedValue({
        auth: { signOut },
      });

      await expect(signOutAction()).rejects.toThrow("REDIRECT:/login");
      expect(signOut).toHaveBeenCalled();
    });
  });
});
