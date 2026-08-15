"use client";

import { useEffect, useRef, useState } from "react";

import { runGitHubSync } from "@/lib/github/sync-client";

const FALLBACK_ERROR = "GitHub sync failed. Try again later.";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : FALLBACK_ERROR;
}

function terminalError(status: string): string | null {
  if (status === "complete") return null;
  if (status === "reconnect_required") {
    return "GitHub access expired. Reconnect to resume syncing.";
  }
  if (status === "not_connected") {
    return "Connect GitHub to start syncing.";
  }
  return FALLBACK_ERROR;
}

export function GitHubAutoSync() {
  const started = useRef(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (started.current) return;

    const searchParams = new URLSearchParams(window.location.search);
    const trigger = searchParams.get("githubSync");
    if (trigger !== "login" && trigger !== "connect") return;

    started.current = true;
    searchParams.delete("githubSync");
    const search = searchParams.toString();
    window.history.replaceState(
      window.history.state,
      "",
      `${window.location.pathname}${search ? `?${search}` : ""}${window.location.hash}`,
    );

    let mounted = true;
    queueMicrotask(() => {
      if (mounted) setRunning(true);
    });
    void runGitHubSync(() => undefined)
      .then((progress) => {
        const terminalErrorMessage = terminalError(progress.status);
        if (terminalErrorMessage) {
          if (mounted) {
            setRunning(false);
            setError(terminalErrorMessage);
          }
          return;
        }

        if (mounted) setRunning(false);
        window.dispatchEvent(new Event("savesort:changed"));
      })
      .catch((syncError: unknown) => {
        if (!mounted) return;
        setRunning(false);
        setError(errorMessage(syncError));
      });

    return () => {
      mounted = false;
    };
  }, []);

  return (
    <>
      {running ? (
        <p className="notice notice-info" aria-live="polite">
          Syncing GitHub stars…
        </p>
      ) : null}
      {error ? (
        <div className="notice notice-error" role="alert">
          <span>{error}</span>
          <button type="button" onClick={() => setError(null)}>
            Dismiss
          </button>
        </div>
      ) : null}
    </>
  );
}
