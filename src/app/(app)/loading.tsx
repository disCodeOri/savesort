import { LoaderCircle } from "lucide-react";

export default function Loading() {
  return (
    <div className="loading-state">
      <LoaderCircle className="spin" /> Loading Grapplin…
    </div>
  );
}
