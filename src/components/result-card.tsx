import { ArrowUpRight, CalendarDays } from "lucide-react";

import { SourceIcon, SOURCE_LABELS } from "@/components/source-icon";
import type { SavedItem } from "@/lib/items/types";

function domainOf(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function savedDate(value: string) {
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value));
}

export function ResultCard({
  item,
  actions,
}: {
  item: SavedItem;
  actions?: React.ReactNode;
}) {
  return (
    <article className={`result-card source-${item.source}`}>
      <div className="source-tile">
        <SourceIcon source={item.source} size={25} />
      </div>
      <div className="result-main">
        <span className="result-source">{SOURCE_LABELS[item.source]}</span>
        <h2>
          <a href={item.url} target="_blank" rel="noreferrer">
            {item.title || domainOf(item.url)}
          </a>
        </h2>
        {item.description || item.content ? (
          <p className="result-excerpt">
            {item.description || item.content?.slice(0, 190)}
          </p>
        ) : null}
        {item.notes ? <p className="result-notes">“{item.notes}”</p> : null}
        {item.tags.length ? (
          <div className="tag-list">
            {item.tags.slice(0, 6).map((tag) => (
              <span key={tag}>{tag}</span>
            ))}
          </div>
        ) : null}
      </div>
      <div className="result-meta">
        <a href={item.url} target="_blank" rel="noreferrer">
          {domainOf(item.url)} <ArrowUpRight size={14} />
        </a>
        <span>
          <CalendarDays size={14} /> Saved {savedDate(item.created_at)}
        </span>
        {item.indexing_status !== "ready" ? (
          <small>Keyword indexed</small>
        ) : null}
      </div>
      {actions ? (
        <div className="result-actions">{actions}</div>
      ) : (
        <a
          className="open-button"
          aria-label={`Open ${item.title ?? "saved item"}`}
          href={item.url}
          target="_blank"
          rel="noreferrer"
        >
          <ArrowUpRight />
        </a>
      )}
    </article>
  );
}
