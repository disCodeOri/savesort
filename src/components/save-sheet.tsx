"use client";

import { Info, LoaderCircle, X } from "lucide-react";
import { FormEvent, useState } from "react";

import { isRestrictedPlatformUrl } from "@/lib/sources/detect-source";

export function SaveSheet({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [url, setUrl] = useState("");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const restricted = isRestrictedPlatformUrl(url);

  if (!open) return null;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setMessage("Saving and indexing…");
    const form = new FormData(event.currentTarget);
    try {
      const response = await fetch("/api/items", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: form.get("url"),
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
      if (!response.ok)
        throw new Error(body.error ?? "We couldn't save that item.");
      setMessage(
        body.item.indexing_status === "ready"
          ? "Saved and indexed."
          : "Saved with keyword search.",
      );
      window.dispatchEvent(new Event("savesort:changed"));
      window.setTimeout(() => {
        setUrl("");
        setMessage(null);
        onClose();
      }, 700);
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "We couldn't save that item.",
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <div
      className="sheet-backdrop"
      role="presentation"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <aside className="save-sheet" aria-label="Save something">
        <div className="sheet-header">
          <div>
            <h2>Save something</h2>
            <p>Add the context that future-you will remember.</p>
          </div>
          <button aria-label="Close" onClick={onClose}>
            <X />
          </button>
        </div>
        <form onSubmit={submit} className="save-form">
          <label>
            URL <span>required</span>
            <input
              name="url"
              type="url"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              required
              placeholder="https://github.com/owner/repository"
            />
          </label>
          <label>
            Custom title <span>optional</span>
            <input name="title" placeholder="A name you'll remember" />
          </label>
          <label>
            Notes <span>optional</span>
            <textarea
              name="notes"
              rows={4}
              placeholder="Why did you save this?"
            />
          </label>
          <label>
            Pasted caption or transcript <span>optional</span>
            <textarea
              name="content"
              rows={6}
              placeholder="Paste useful text from restricted sources here"
            />
          </label>
          <label>
            Tags <span>comma separated</span>
            <input name="tags" placeholder="cli, research, productivity" />
          </label>
          <div className="sheet-tip">
            <Info size={18} />
            <span>
              {restricted
                ? "We won't scrape this platform. Adding notes or pasted text makes it much easier to find later."
                : "We'll make one safe attempt to fetch public title and description metadata."}
            </span>
          </div>
          {message ? (
            <div className="notice">
              {pending ? <LoaderCircle className="spin" size={17} /> : null}
              {message}
            </div>
          ) : null}
          <div className="sheet-actions">
            <button
              type="button"
              className="button button-secondary"
              onClick={onClose}
            >
              Cancel
            </button>
            <button className="button button-accent" disabled={pending}>
              {pending ? "Saving…" : "Save item"}
            </button>
          </div>
        </form>
      </aside>
    </div>
  );
}
