"use client";

export default function AppError({ reset }: { reset: () => void }) {
  return (
    <div className="empty-state">
      <h2>Something went wrong.</h2>
      <p>
        Your saved items are still private and safe. Try loading this page
        again.
      </p>
      <button className="button button-ink" onClick={reset}>
        Try again
      </button>
    </div>
  );
}
