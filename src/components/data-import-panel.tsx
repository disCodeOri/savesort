"use client";

import { useEffect, useRef, useState } from "react";

import {
  analyzeImportFile,
  ImportAnalysisError,
  ImportFileError,
  runDataImport,
  type AnalysisResult,
  type ImportProgress,
  type ImportSummary,
} from "@/lib/data-import/import-client";
import {
  CATEGORY_LABELS,
  SAVED_CATEGORIES,
  type ImportCategory,
  type ImportPlatform,
} from "@/lib/data-import/types";

/**
 * Import a Reddit or LinkedIn account-data export.
 *
 * Three steps, in the same panel: choose a file, confirm what was found in it,
 * watch it import. The analysis step exists so nothing is written until the
 * user has seen the real categories and counts from their own export.
 */

interface DataImportPanelProps {
  onLibraryChanged(): void;
}

const PLATFORM_LABEL: Record<ImportPlatform, string> = {
  reddit: "Reddit",
  linkedin: "LinkedIn",
};

const STAGE_LABEL: Record<ImportProgress["stage"], string> = {
  reading: "Reading export…",
  merging: "Recovering available context…",
  importing: "Importing…",
  classifying: "Preparing items for search…",
  done: "Complete",
};

interface StoredImport {
  importId: string;
  platform: string;
  status: string;
  itemsCreated: number;
  completedAt: string | null;
}

export function DataImportPanel({ onLibraryChanged }: DataImportPanelProps) {
  const fileInput = useRef<HTMLInputElement>(null);
  // State rather than a ref: the platform-choice prompt renders from it, and
  // a ref read during render would not re-render when it changes.
  const [pendingFile, setPendingFile] = useState<File | null>(null);

  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);
  const [selected, setSelected] = useState<ImportCategory[]>([]);
  const [crossReference, setCrossReference] = useState(true);
  const [choosePlatform, setChoosePlatform] = useState(false);
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const [previous, setPrevious] = useState<StoredImport | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // Restores the last import so a completed run is still visible after a
    // reload, and an interrupted one is not silently forgotten.
    async function loadPrevious() {
      try {
        const response = await fetch("/api/imports/status");
        if (!response.ok) return;
        const body = await response.json();
        setPrevious(body.import ?? null);
      } catch {
        // A missing status is not worth surfacing; the panel still works.
      }
    }
    void loadPrevious();
  }, []);

  function reset() {
    setAnalysis(null);
    setSelected([]);
    setChoosePlatform(false);
    setPendingFile(null);
    if (fileInput.current) fileInput.current.value = "";
  }

  async function analyze(file: File, forcedPlatform?: ImportPlatform) {
    setBusy(true);
    setMessage(null);
    setSummary(null);
    setProgress({ stage: "reading", itemsTotal: 0, itemsProcessed: 0 });

    try {
      const result = await analyzeImportFile(file, forcedPlatform);
      setPendingFile(file);
      setAnalysis(result);
      setSelected(result.defaultSelection);
      setChoosePlatform(false);
    } catch (error) {
      if (error instanceof ImportAnalysisError && error.candidates) {
        // Detection scored both platforms. Ask rather than guess.
        setPendingFile(file);
        setChoosePlatform(true);
        setMessage(error.message);
      } else {
        reset();
        setMessage(
          error instanceof ImportAnalysisError ||
            error instanceof ImportFileError
            ? error.message
            : "We couldn't read that file.",
        );
      }
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  async function startImport() {
    if (!analysis || selected.length === 0) return;
    setBusy(true);
    setMessage(null);

    try {
      const result = await runDataImport({
        analysis,
        selected,
        crossReference,
        onProgress: setProgress,
      });
      setSummary(result);
      reset();
      onLibraryChanged();
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "The export could not be imported.",
      );
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  async function revert() {
    const importId = summary?.importId ?? previous?.importId;
    if (!importId) return;
    if (
      !window.confirm(
        "Remove this import? Items that also came from a connected account stay in your library, along with any notes and tags you added.",
      )
    )
      return;

    setBusy(true);
    try {
      const response = await fetch("/api/imports/status", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ importId }),
      });
      const body = await response.json();
      if (!response.ok) {
        throw new Error(body.error ?? "The import could not be removed.");
      }
      setMessage(`Removed ${body.itemsRemoved ?? 0} imported items.`);
      setSummary(null);
      setPrevious(null);
      onLibraryChanged();
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "The import could not be removed.",
      );
    } finally {
      setBusy(false);
    }
  }

  function toggle(category: ImportCategory) {
    setSelected((current) =>
      current.includes(category)
        ? current.filter((value) => value !== category)
        : [...current, category],
    );
  }

  return (
    <section
      className="connection-panel"
      aria-label="Reddit and LinkedIn data export import"
    >
      <div className="connection-panel-status">
        <div>
          <strong>Import a Reddit or LinkedIn export</strong>
          <p>
            Upload the data download Reddit or LinkedIn gave you to bring your
            saved posts and items into GRAPPlin. The file is read on this device
            — messages, connections and account data are never opened or
            uploaded.
          </p>
          {previous?.completedAt ? (
            <small>
              Last import: {new Date(previous.completedAt).toLocaleDateString()}
              {previous.itemsCreated
                ? ` · ${previous.itemsCreated} items`
                : null}
            </small>
          ) : null}
        </div>
        <div className="connection-panel-actions">
          <input
            ref={fileInput}
            type="file"
            accept=".zip,.csv,.json,.jsonl,application/zip,text/csv,application/json"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void analyze(file);
            }}
          />
          <button
            className="button button-secondary"
            type="button"
            disabled={busy}
            onClick={() => fileInput.current?.click()}
          >
            Choose export…
          </button>
          {summary || previous ? (
            <button
              className="connection-panel-disconnect"
              type="button"
              disabled={busy}
              onClick={() => void revert()}
            >
              Remove import
            </button>
          ) : null}
        </div>
      </div>

      {choosePlatform && pendingFile ? (
        <div className="data-import-choose">
          <p>Which platform is this export from?</p>
          <div className="connection-panel-actions">
            {(["reddit", "linkedin"] as const).map((platform) => (
              <button
                key={platform}
                className="button button-secondary"
                type="button"
                disabled={busy}
                onClick={() => {
                  if (pendingFile) void analyze(pendingFile, platform);
                }}
              >
                {PLATFORM_LABEL[platform]}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {analysis && !progress ? (
        <div className="data-import-preview">
          <p>
            <strong>
              {PLATFORM_LABEL[analysis.platform]} export detected.
            </strong>{" "}
            Choose what to import.
          </p>
          <ul className="data-import-categories">
            {/* Only categories genuinely present in this export are listed. */}
            {analysis.datasets.map((dataset) => (
              <li key={dataset.category}>
                <label>
                  <input
                    type="checkbox"
                    checked={selected.includes(dataset.category)}
                    onChange={() => toggle(dataset.category)}
                  />
                  <span>{CATEGORY_LABELS[dataset.category]}</span>
                  <small>{dataset.recordCount}</small>
                </label>
              </li>
            ))}
          </ul>
          <label className="data-import-toggle">
            <input
              type="checkbox"
              checked={crossReference}
              onChange={(event) => setCrossReference(event.target.checked)}
            />
            <span>
              Use the other files in this export to add context to the items I
              import. Those files never become items of their own.
            </span>
          </label>
          {analysis.datasets.every(
            (dataset) => !SAVED_CATEGORIES.includes(dataset.category),
          ) ? (
            <p className="notice notice-info" role="status">
              This export contains no saved items, only activity history.
            </p>
          ) : null}
          <div className="connection-panel-actions">
            <button
              className="button"
              type="button"
              disabled={busy || selected.length === 0}
              onClick={() => void startImport()}
            >
              Import selected
            </button>
            <button
              className="connection-panel-disconnect"
              type="button"
              disabled={busy}
              onClick={() => {
                reset();
                setMessage(null);
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      {progress ? (
        <p className="connection-panel-progress" aria-live="polite">
          {STAGE_LABEL[progress.stage]}
          {(progress.stage === "importing" ||
            progress.stage === "classifying") &&
          progress.itemsTotal > 0
            ? ` ${progress.itemsProcessed} / ${progress.itemsTotal}`
            : null}
        </p>
      ) : null}

      {summary ? <ImportReport summary={summary} /> : null}

      {message ? (
        <p className="notice notice-info" role="status">
          {message}
        </p>
      ) : null}
    </section>
  );
}

/**
 * The completion report.
 *
 * Every number is an outcome, not a discovery count: "imported" is what was
 * actually written, and the content breakdown says plainly how much of each
 * item the export contained.
 */
function ImportReport({ summary }: { summary: ImportSummary }) {
  const rows: Array<[string, number]> = [
    ...Object.entries(summary.byCategory).map(
      ([category, count]) =>
        [
          CATEGORY_LABELS[category as ImportCategory] ?? category,
          count ?? 0,
        ] as [string, number],
    ),
    ["Added to your library", summary.created],
    ["Already in GRAPPlin", summary.updated],
    ["Full content", summary.full],
    ["Partial content", summary.partial],
    ["Reference only", summary.referenceOnly],
    ["Enriched from other files", summary.enrichedFromOtherFiles],
    ["Prepared for vague search", summary.classified],
    ["Not enough text to enrich", summary.insufficient],
    ["Enrichment failed", summary.classificationFailed],
    ["Records that couldn't be identified", summary.unresolved],
    ["Files skipped", summary.filesSkipped],
  ];

  return (
    <div className="x-archive-report">
      <p>
        <strong>{PLATFORM_LABEL[summary.platform]} import complete.</strong>{" "}
        {summary.itemsImported} items from {summary.filesProcessed} files.
      </p>
      <ul>
        {rows
          .filter(([, count]) => count > 0)
          .map(([label, count]) => (
            <li key={label}>
              <span>{label}</span>
              <small>{count}</small>
            </li>
          ))}
      </ul>
      {summary.referenceOnly > 0 ? (
        <p className="connection-panel-progress">
          Some items arrived as a link and a date only — that is all{" "}
          {PLATFORM_LABEL[summary.platform]} included in the export. They are
          saved and you can open them, but there was no text to index.
        </p>
      ) : null}
      {summary.warnings.length > 0 ? (
        <p className="notice notice-info" role="status">
          {summary.warnings[0]}
        </p>
      ) : null}
    </div>
  );
}
