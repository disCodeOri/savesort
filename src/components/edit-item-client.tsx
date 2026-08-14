"use client";

import { ArrowLeft, LoaderCircle, RefreshCw } from "lucide-react";
import Link from "next/link";
import { FormEvent, useEffect, useState } from "react";

import type { SavedItem } from "@/lib/items/types";

export function EditItemClient({ id }: { id: string }) {
  const [item, setItem] = useState<SavedItem | null>(null);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    void fetch(`/api/items/${id}`)
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error);
        setItem(body.item);
      })
      .catch((error) => setMessage(error.message ?? "Item couldn't be loaded."))
      .finally(() => setLoading(false));
  }, [id]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setMessage("Updating search index…");
    const form = new FormData(event.currentTarget);
    const response = await fetch(`/api/items/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: form.get("title"),
        notes: form.get("notes"),
        content: form.get("content"),
        tags: String(form.get("tags") ?? "")
          .split(",")
          .map((tag) => tag.trim())
          .filter(Boolean),
      }),
    });
    const body = await response.json();
    if (response.ok) {
      setItem(body.item);
      setMessage(
        body.item.indexing_status === "ready"
          ? "Saved and reindexed."
          : "Saved with keyword indexing.",
      );
      window.dispatchEvent(new Event("savesort:changed"));
    } else setMessage(body.error ?? "Update failed.");
    setLoading(false);
  }

  async function retry() {
    setLoading(true);
    setMessage("Retrying semantic indexing…");
    const response = await fetch(`/api/items/${id}/retry`, { method: "POST" });
    const body = await response.json();
    if (response.ok) {
      setItem(body.item);
      setMessage(
        body.item.indexing_status === "ready"
          ? "Semantic index is ready."
          : body.item.indexing_error,
      );
    } else setMessage(body.error ?? "Retry failed.");
    setLoading(false);
  }

  if (loading && !item)
    return (
      <div className="loading-state">
        <LoaderCircle className="spin" /> Loading item…
      </div>
    );
  if (!item)
    return (
      <main className="edit-page content-narrow">
        <Link href="/library">
          <ArrowLeft /> Back to library
        </Link>
        <div className="notice notice-error">{message}</div>
      </main>
    );

  return (
    <main className="edit-page content-narrow">
      <Link className="back-link" href="/library">
        <ArrowLeft /> Back to library
      </Link>
      <div className="edit-heading">
        <div>
          <span>{item.source}</span>
          <h1>Edit saved item</h1>
          <a href={item.url} target="_blank" rel="noreferrer">
            {item.url}
          </a>
        </div>
        <button
          className="button button-secondary"
          disabled={loading}
          onClick={() => void retry()}
        >
          <RefreshCw /> Retry indexing
        </button>
      </div>
      <form className="edit-form" onSubmit={submit}>
        <label>
          Title
          <input name="title" defaultValue={item.title ?? ""} maxLength={300} />
        </label>
        <label>
          Notes
          <textarea
            name="notes"
            rows={5}
            defaultValue={item.notes ?? ""}
            maxLength={5000}
          />
        </label>
        <label>
          Pasted content or transcript
          <textarea
            name="content"
            rows={10}
            defaultValue={item.content ?? ""}
            maxLength={12000}
          />
        </label>
        <label>
          Tags
          <input name="tags" defaultValue={item.tags.join(", ")} />
        </label>
        {message ? (
          <div className="notice">
            {loading ? <LoaderCircle className="spin" size={17} /> : null}
            {message}
          </div>
        ) : null}
        <div className="edit-actions">
          <Link className="button button-secondary" href="/library">
            Cancel
          </Link>
          <button className="button button-accent" disabled={loading}>
            Save changes
          </button>
        </div>
      </form>
    </main>
  );
}
