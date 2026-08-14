import { BookmarkPlus } from "lucide-react";

export function EmptyState({ searched = false }: { searched?: boolean }) {
  return (
    <div className="empty-state">
      <BookmarkPlus />
      <h2>
        {searched
          ? "Nothing matched that memory."
          : "You haven't saved anything yet."}
      </h2>
      <p>
        {searched
          ? "Try fewer words, another source, or a more general description."
          : "Paste a GitHub repo, article, useful website, or a link you want to remember."}
      </p>
    </div>
  );
}
