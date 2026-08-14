"use client";

import { useFormStatus } from "react-dom";

export function SubmitButton({
  children,
  variant = "primary",
}: {
  children: React.ReactNode;
  variant?: "primary" | "secondary";
}) {
  const { pending } = useFormStatus();
  return (
    <button
      className={`button button-${variant}`}
      disabled={pending}
      type="submit"
    >
      {pending ? "Working…" : children}
    </button>
  );
}
