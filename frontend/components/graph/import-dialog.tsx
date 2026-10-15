"use client";

import {
  useEffect,
  useId,
  useRef,
  useState,
  type ChangeEvent,
  type CSSProperties,
  type DragEvent,
  type FormEvent,
  type ReactNode,
} from "react";
import { cn } from "@/lib/utils";
import { toStorableGraph, type TrimReport } from "@/lib/graph/graph-store";
import { computeInsights, type GraphInsights } from "@/lib/graph/insights";
import { countNotes, normalizeGraph, type NormalizedGraph } from "@/lib/graph/normalize";
import { THEME_VARS } from "@/lib/graph/theme";
import type { GraphData } from "@/lib/graph/types";
import {
  DEFAULT_IMPORT_OPTIONS,
  buildGraph,
  filesFromDrop,
  filesFromList,
  readGraphUrl,
  readSelection,
  type ImportOptions,
  type ImportPayload,
  type PickedSelection,
  type ReadProgress,
} from "@/lib/graph/vault-reader";
import styles from "./graph-view.module.css";
import { Icon, IconButton, Switch, focusRing, type IconName } from "./ui";

/** What "Import" hands back: the graph and a label for where it came from. */
export interface ImportedGraph {
  /** Already storable (`toStorableGraph`): what the preview showed is what is kept and saved. */
  graph: GraphData;
  /** E.g. "Obsidian vault: My Vault". */
  source: string;
  /** Short name for headings: the vault or file name. */
  name: string;
  /** The Obsidian vault's own name, for obsidian:// links (Obsidian vaults only). */
  vault?: string;
  notes: number;
}

type SourceKind = "vault" | "files" | "json" | "csv" | "url";
type Step = 1 | 2 | 3;
type Reading =
  | { status: "idle" }
  | { status: "reading"; progress: ReadProgress | null }
  | { status: "ready"; payload: ImportPayload }
  | { status: "error"; message: string };

const SOURCES: readonly { kind: SourceKind; icon: IconName; title: string; description: string; drop: string; choose: string }[] = [
  {
    kind: "vault",
    icon: "folder",
    title: "Obsidian / Markdown vault folder",
    description: "The folder that holds your notes. .obsidian, .git and .trash are skipped.",
    drop: "Drop your vault folder here",
    choose: "Choose folder…",
  },
  { kind: "files", icon: "note", title: "Markdown files", description: "One or more .md notes.", drop: "Drop .md files here", choose: "Choose files…" },
  { kind: "json", icon: "braces", title: "JSON file", description: "GraphData: { nodes, links, groups? }.", drop: "Drop a .json file here", choose: "Choose file…" },
  { kind: "csv", icon: "table", title: "CSV edge list", description: "One source,target[,weight] row per line.", drop: "Drop a .csv or .tsv file here", choose: "Choose file…" },
  { kind: "url", icon: "link", title: "JSON URL", description: "GraphData served with CORS.", drop: "", choose: "" },
];

type Preview =
  | {
      /** Storable: exactly what Import keeps and saves. */
      graph: GraphData;
      normalized: NormalizedGraph;
      insights: GraphInsights;
      /** False on big vaults, where duplicate detection would hold up the preview. */
      duplicatesChecked: boolean;
      notes: number;
      attachments: number;
      trimmed: TrimReport;
      error: null;
    }
  | { error: string };

const STEPS = ["Source", "Options", "Preview"] as const;
// Likely-duplicate detection grows faster than linearly; past this the sidebar finds them after import.
const PREVIEW_DUPLICATES_UP_TO = 3000;

/** Numbers for the Preview step. Runs once per payload and options, after the step has painted. */
function buildPreview(payload: ImportPayload, options: ImportOptions): Preview {
  try {
    const trimmed: TrimReport = { labels: 0, groups: 0, tags: 0, meta: 0 };
    const graph = toStorableGraph(buildGraph(payload, options), trimmed);
    const normalized = normalizeGraph(graph);
    const notes = countNotes(graph);
    const duplicatesChecked = notes <= PREVIEW_DUPLICATES_UP_TO;
    const insights = computeInsights(normalized, 5, { duplicates: duplicatesChecked });
    const attachments = normalized.nodes.reduce((n, node) => n + (node.group === "attachment" ? 1 : 0), 0);
    return { graph, normalized, insights, duplicatesChecked, notes, attachments, trimmed, error: null };
  } catch (error) {
    return { error: errorMessage(error) };
  }
}

function trimSummary(trimmed: TrimReport): string | null {
  const parts = [
    trimmed.labels > 0 && `${plural(trimmed.labels, "title")} over 512 characters`,
    trimmed.tags > 0 && `tags on ${plural(trimmed.tags, "note")} (over 32, or over 120 characters)`,
    trimmed.groups > 0 && `${plural(trimmed.groups, "group name")} over 120 characters`,
    trimmed.meta > 0 && `extra data on ${plural(trimmed.meta, "note")} (over 4 KB)`,
  ].filter(Boolean);
  return parts.length ? `Shortened to fit your account: ${parts.join(", ")}.` : null;
}

const primaryButton = cn(
  "inline-flex h-8 shrink-0 items-center justify-center gap-2 rounded-[6px] bg-(--g-accent) px-3 text-[13px] font-medium text-(--g-bg) transition-[filter,opacity] duration-150 hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:brightness-100",
  focusRing,
);
const secondaryButton = cn(
  "inline-flex h-8 shrink-0 items-center justify-center gap-2 rounded-[6px] border border-(--g-border) bg-(--g-panel) px-3 text-[13px] text-(--g-text) transition-colors duration-150 hover:bg-(--g-hover) disabled:cursor-not-allowed disabled:opacity-40",
  focusRing,
);

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message || error.name : String(error);
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

const formatCount = (n: number) => n.toLocaleString("en-US");
const plural = (n: number, one: string, many = `${one}s`) => `${formatCount(n)} ${n === 1 ? one : many}`;

function Alert({ children }: { children: ReactNode }) {
  return (
    <div
      role="alert"
      className="flex items-start gap-2 rounded-[8px] border border-(--g-danger-border) bg-(--g-danger-soft) px-3 py-2.5 text-[12px] text-(--g-text)"
    >
      <span className="mt-px text-(--g-danger)"><Icon name="alert" size={14} /></span>
      <p className={cn(styles.mono, "min-w-0 break-words")}>{children}</p>
    </div>
  );
}

function ProgressBar({ progress }: { progress: ReadProgress | null }) {
  const total = progress?.total ?? 0, done = progress?.done ?? 0;
  const listing = total === 0;
  return (
    <div>
      <div className="flex items-center justify-between gap-3 text-[12px]">
        <span className="text-(--g-text-2)">
          {listing ? (done > 0 ? `Listing files… ${formatCount(done)} found` : "Listing files…") : done < total ? "Reading notes…" : "Building the graph…"}
        </span>
        {!listing && <span className={cn(styles.mono, "text-(--g-text-3)")}>{formatCount(done)} / {formatCount(total)}</span>}
      </div>
      <div
        role="progressbar"
        aria-label="Reading notes"
        aria-valuemin={0}
        aria-valuemax={listing ? undefined : total}
        aria-valuenow={listing ? undefined : done}
        aria-valuetext={listing ? "Listing files" : `${done} of ${total} files read`}
        className="mt-1.5 h-1 overflow-hidden rounded-full bg-(--g-border)"
      >
        <div
          className={cn("h-full rounded-full bg-(--g-accent) transition-[width] duration-150", listing && cn("w-1/3", styles.pulse))}
          style={listing ? undefined : { width: `${total ? (done / total) * 100 : 0}%` }}
        />
      </div>
      <p className={cn(styles.mono, "mt-1 h-4 truncate text-[11px] text-(--g-text-3)")}>{progress?.path ?? ""}</p>
    </div>
  );
}

function Stat({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: ReactNode; tone?: "warn" }) {
  return (
    <div className="min-w-0 rounded-[10px] border border-(--g-border) bg-(--g-panel) px-3 py-2.5">
      <dt className="truncate text-[12px] text-(--g-text-3)">{label}</dt>
      <dd className={cn(styles.mono, "mt-0.5 text-[20px] leading-7", tone === "warn" ? "text-(--g-warn)" : "text-(--g-text)")}>
        {value}
      </dd>
      {hint && <dd className="truncate text-[11px] text-(--g-text-3)">{hint}</dd>}
    </div>
  );
}

/**
 * "Connect your knowledge graph": pick or drop an Obsidian vault, Markdown files, a JSON graph, a
 * CSV edge list or a JSON URL; choose how it becomes a graph; check the numbers; import. Everything
 * is read in the browser. Mount it to open it; it calls `onClose` on Esc, the close button or a
 * click outside, and focus goes back to whatever opened it.
 */
export function ImportDialog({ onClose, onImport }: { onClose: () => void; onImport: (result: ImportedGraph) => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const filesInput = useRef<HTMLInputElement>(null);
  const jsonInput = useRef<HTMLInputElement>(null);
  const csvInput = useRef<HTMLInputElement>(null);
  const controller = useRef<AbortController | null>(null);
  const dragDepth = useRef(0);
  const pressedBackdrop = useRef(false);
  const id = useId();

  const [kind, setKind] = useState<SourceKind>("vault");
  const [step, setStep] = useState<Step>(1);
  const [reading, setReading] = useState<Reading>({ status: "idle" });
  const [options, setOptions] = useState<ImportOptions>(DEFAULT_IMPORT_OPTIONS);
  const [url, setUrl] = useState("");
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    const dialog = dialogRef.current!;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!dialog.open) dialog.showModal();
    dialog.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    return () => {
      controller.current?.abort();
      if (dialog.open) dialog.close();
      // Back to the button that opened the dialog, if it is still on the page.
      if (opener?.isConnected) opener.focus();
    };
  }, []);

  // A new step replaces the controls that had focus, so focus moves to the step's heading.
  const lastStep = useRef(step);
  useEffect(() => {
    if (lastStep.current === step) return;
    lastStep.current = step;
    headingRef.current?.focus();
  }, [step]);

  const close = () => {
    controller.current?.abort();
    onClose();
  };

  const begin = (run: (signal: AbortSignal, onProgress: (progress: ReadProgress) => void) => Promise<ImportPayload>) => {
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;
    setReading({ status: "reading", progress: null });
    const onProgress = (progress: ReadProgress) => {
      if (current.signal.aborted) return;
      setReading({ status: "reading", progress });
      // Listed: set options while the notes are read.
      if (progress.total > 1) setStep((at) => (at === 1 ? 2 : at));
    };
    run(current.signal, onProgress).then(
      (payload) => {
        if (current.signal.aborted) return;
        setReading({ status: "ready", payload });
        setStep((at) => (at === 1 ? 2 : at));
      },
      (error: unknown) => {
        if (current.signal.aborted || isAbort(error)) return;
        setReading({ status: "error", message: errorMessage(error) });
        setStep(1);
      },
    );
  };

  const readPicked = (selection: PickedSelection | ((signal: AbortSignal, onListed: (count: number) => void) => Promise<PickedSelection>)) =>
    begin(async (signal, onProgress) => {
      // While a dropped folder is listed, `done` counts the files found so far (total stays 0).
      const listed = typeof selection === "function" ? await selection(signal, (count) => onProgress({ done: count, total: 0 })) : selection;
      return readSelection(listed, { signal, onProgress });
    });

  const onPick = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    // Cleared so picking the same folder again still fires a change.
    event.target.value = "";
    if (files.length > 0) readPicked(filesFromList(files));
  };

  const cancelReading = () => {
    controller.current?.abort();
    controller.current = null;
    setReading({ status: "idle" });
    setStep(1);
  };

  const onDragEnter = (event: DragEvent) => {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    dragDepth.current++;
    setDragging(true);
  };
  const onDragOver = (event: DragEvent) => {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  };
  const onDragLeave = () => {
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragging(false);
  };
  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    if (event.dataTransfer.files.length === 0 && event.dataTransfer.items.length === 0) return;
    // filesFromDrop takes the entries now, while the drop event still owns them.
    const data = event.dataTransfer;
    readPicked((signal, onListed) => filesFromDrop(data, signal, onListed));
  };

  const loadUrl = (event: FormEvent) => {
    event.preventDefault();
    const target = url.trim();
    if (!target) {
      setReading({ status: "error", message: "Enter the URL of a GraphData JSON file first" });
      return;
    }
    begin((signal, onProgress) => {
      onProgress({ done: 0, total: 1, path: target });
      return readGraphUrl(target, signal);
    });
  };

  const choose = () => {
    const input = kind === "vault" ? folderInput : kind === "files" ? filesInput : kind === "json" ? jsonInput : csvInput;
    input.current?.click();
  };

  const payload = reading.status === "ready" ? reading.payload : null;
  const markdown = payload?.kind === "markdown";
  // The preview is built only on the Preview step, a frame after it paints, so reading a big vault
  // or changing options on step 2 never stalls the dialog (and Cancel/Esc keep working there).
  const [built, setBuilt] = useState<{ payload: ImportPayload; options: ImportOptions; preview: Preview } | null>(null);
  useEffect(() => {
    if (step !== 3 || !payload) return;
    const timer = window.setTimeout(() => setBuilt({ payload, options, preview: buildPreview(payload, options) }), 16);
    return () => window.clearTimeout(timer);
  }, [step, payload, options]);
  const preview = built && built.payload === payload ? built.preview : null;
  // Built for other options: shown dimmed until the new numbers are in.
  const stale = !!built && built.payload === payload && built.options !== options;
  const building = step === 3 && !!payload && (!preview || stale);

  const source = SOURCES.find((s) => s.kind === kind)!;
  const busy = reading.status === "reading";
  const ready = preview && preview.error === null ? preview : null;
  const notes = ready ? ready.notes : 0;
  const trimmed = ready ? trimSummary(ready.trimmed) : null;

  const finish = () => {
    if (!payload || !ready || notes === 0 || stale) return;
    const vault = payload.kind === "markdown" && payload.obsidian && payload.name ? payload.name : undefined;
    onImport({ graph: ready.graph, source: payload.source, name: payload.name || payload.source, notes, ...(vault && { vault }) });
  };

  const announcement =
    reading.status === "reading"
      ? reading.progress && reading.progress.total > 0 ? `Reading ${formatCount(reading.progress.total)} files…` : "Reading…"
      : payload
        ? `Read ${payload.source}.`
        : "";
  const status =
    reading.status === "reading"
      ? reading.progress && reading.progress.total > 0
        ? `Reading ${formatCount(reading.progress.done)} of ${formatCount(reading.progress.total)}…`
        : "Listing files…"
      : payload
        ? `${payload.source} · ${payload.kind === "markdown" ? `${plural(payload.notes.length, "note")} read` : plural(payload.graph.nodes.length, "node")}`
        : "";

  const set = <K extends keyof ImportOptions>(key: K, value: ImportOptions[K]) => setOptions((current) => ({ ...current, [key]: value }));

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-description`}
      className={styles.dialog}
      style={THEME_VARS as CSSProperties}
      onCancel={(event) => {
        // A dismissed file picker fires a bubbling "cancel" at its <input>: that isn't the dialog's.
        if (event.target !== event.currentTarget) return;
        // Esc: close through React so the reading stops and focus returns to the opener.
        event.preventDefault();
        close();
      }}
      // Closed by the browser itself (e.g. a repeated Esc). A stale event from a dialog that was
      // closed and reopened (React's dev double-mount) finds it open again and is ignored.
      onClose={() => { if (!dialogRef.current?.open) onClose(); }}
      onPointerDown={(event) => { pressedBackdrop.current = event.target === dialogRef.current; }}
      onClick={(event) => {
        if (pressedBackdrop.current && event.target === dialogRef.current) close();
        pressedBackdrop.current = false;
      }}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <header className="flex shrink-0 items-start gap-3 border-b border-(--g-border) py-4 pl-5 pr-3">
        <div className="min-w-0 flex-1">
          <h2 id={`${id}-title`} className="text-[15px] font-semibold text-(--g-text)">Connect your knowledge graph</h2>
          <p id={`${id}-description`} className="mt-1 text-[12px] text-(--g-text-2)">
            Bring your own notes. Files are read in this browser; nothing is uploaded unless you save to your account.
          </p>
        </div>
        <IconButton icon="close" label="Close" onClick={close} />
      </header>

      <ol aria-label="Steps" className="flex shrink-0 items-center gap-2 overflow-x-auto border-b border-(--g-border) px-5 py-2.5">
        {STEPS.map((label, i) => {
          const n = (i + 1) as Step;
          const done = n < step;
          return (
            <li key={label} aria-current={n === step ? "step" : undefined} className="flex shrink-0 items-center gap-2">
              <span
                aria-hidden="true"
                className={cn(
                  styles.mono,
                  "grid size-5 place-items-center rounded-full border text-[11px]",
                  n === step ? "border-(--g-accent) bg-(--g-accent) text-(--g-bg)" : done ? "border-(--g-accent) text-(--g-accent-text)" : "border-(--g-border) text-(--g-text-3)",
                )}
              >
                {done ? <Icon name="check" size={12} /> : n}
              </span>
              <span className={cn("text-[12px]", n === step ? "text-(--g-text)" : "text-(--g-text-3)")}>
                <span className="sr-only">Step {n}: </span>{label}{done && <span className="sr-only"> (done)</span>}
              </span>
              {i < STEPS.length - 1 && <span aria-hidden="true" className="mx-1 h-px w-6 bg-(--g-border)" />}
            </li>
          );
        })}
      </ol>

      <div className={cn(styles.scroll, "min-h-0 flex-1 overflow-y-auto px-5 py-4")}>
        {step === 1 && (
          <section aria-labelledby={`${id}-step`}>
            <h3 id={`${id}-step`} ref={headingRef} tabIndex={-1} className="text-[13px] font-medium text-(--g-text) outline-none">
              Where are your notes?
            </h3>
            <fieldset className="mt-2">
              <legend className="sr-only">Source</legend>
              <div className="grid gap-2 sm:grid-cols-2">
                {SOURCES.map((option, i) => {
                  const checked = option.kind === kind;
                  return (
                    <label
                      key={option.kind}
                      className={cn(
                        "relative flex cursor-pointer items-start gap-3 rounded-[10px] border p-3 transition-colors duration-150",
                        i === 0 && "sm:col-span-2",
                        checked ? "border-(--g-accent) bg-(--g-accent-soft)" : "border-(--g-border) bg-(--g-panel) hover:bg-(--g-hover)",
                        "has-[input:focus-visible]:outline-solid has-[input:focus-visible]:outline-2 has-[input:focus-visible]:outline-offset-2 has-[input:focus-visible]:outline-(--g-accent)",
                      )}
                    >
                      <input
                        type="radio"
                        name={`${id}-source`}
                        value={option.kind}
                        checked={checked}
                        data-autofocus={checked ? "" : undefined}
                        onChange={() => {
                          setKind(option.kind);
                          if (reading.status === "error") setReading({ status: "idle" });
                        }}
                        className="sr-only"
                      />
                      <span className={cn("mt-px", checked ? "text-(--g-accent-text)" : "text-(--g-text-2)")}>
                        <Icon name={option.icon} size={i === 0 ? 20 : 16} />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-center gap-2 text-[13px] font-medium text-(--g-text)">
                          {option.title}
                          {i === 0 && (
                            <span className="rounded-full border border-(--g-accent-border) px-1.5 text-[11px] font-normal leading-[18px] text-(--g-accent-text)">
                              Recommended
                            </span>
                          )}
                        </span>
                        <span className="mt-0.5 block text-[12px] text-(--g-text-3)">{option.description}</span>
                      </span>
                    </label>
                  );
                })}
              </div>
            </fieldset>

            <div className="mt-4">
              {kind === "url" ? (
                <form onSubmit={loadUrl} className="rounded-[10px] border border-(--g-border) bg-(--g-panel) p-3">
                  <label htmlFor={`${id}-url`} className="text-[12px] text-(--g-text-2)">Graph JSON URL</label>
                  <div className="mt-1.5 flex gap-2 max-sm:flex-col">
                    <input
                      id={`${id}-url`}
                      type="url"
                      inputMode="url"
                      autoComplete="url"
                      spellCheck={false}
                      placeholder="https://example.com/vault-graph.json"
                      value={url}
                      onChange={(event) => setUrl(event.target.value)}
                      className={cn(styles.mono, "h-8 min-w-0 flex-1 rounded-[6px] border border-(--g-border) bg-(--g-bg) px-2.5 text-[12px] text-(--g-text) outline-none transition-colors duration-150 placeholder:text-(--g-text-3) focus:border-(--g-accent)")}
                    />
                    <button type="submit" disabled={busy} className={primaryButton}>{busy ? "Loading…" : "Load"}</button>
                  </div>
                  <p className="mt-1.5 text-[12px] text-(--g-text-3)">The server must allow cross-origin requests (CORS).</p>
                  {busy && (
                    <p className="mt-3 flex items-center gap-2 text-[12px] text-(--g-text-2)">
                      <span aria-hidden="true" className={cn("size-1.5 rounded-full bg-(--g-accent)", styles.pulse)} />
                      Fetching the graph…
                    </p>
                  )}
                </form>
              ) : (
                <div
                  className={cn(
                    styles.dropzone,
                    "flex flex-col items-center rounded-[12px] border border-dashed px-4 py-8 text-center transition-colors duration-150",
                    dragging ? "border-(--g-accent) bg-(--g-accent-soft)" : "border-(--g-border-strong) bg-(--g-bg)",
                  )}
                >
                  {busy ? (
                    <div className="w-full max-w-sm text-left">
                      <ProgressBar progress={reading.progress} />
                      <div className="mt-3 flex justify-center">
                        <button type="button" onClick={cancelReading} className={secondaryButton}>Cancel</button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <span className={cn("grid size-11 place-items-center rounded-full border border-(--g-border) bg-(--g-panel)", dragging ? "text-(--g-accent-text)" : "text-(--g-text-2)")}>
                        <Icon name={payload ? "check" : "upload"} size={20} />
                      </span>
                      {payload ? (
                        <>
                          <p className="mt-3 text-[14px] font-medium text-(--g-text)">{payload.source}</p>
                          <p className="mt-1 text-[12px] text-(--g-text-3)">Drop something else, or choose again.</p>
                        </>
                      ) : (
                        <>
                          <p className="mt-3 text-[14px] font-medium text-(--g-text)">{dragging ? "Drop to read it" : source.drop}</p>
                          <p className="mt-1 max-w-sm text-[12px] text-(--g-text-3)">
                            Folders, .md files, a .json graph or a .csv edge list: the kind is detected.
                          </p>
                        </>
                      )}
                      <button type="button" onClick={choose} className={cn(secondaryButton, "mt-4")}>
                        <Icon name={kind === "vault" ? "folder" : "upload"} size={14} />
                        {source.choose}
                      </button>
                    </>
                  )}
                </div>
              )}
            </div>
            {reading.status === "error" && <div className="mt-3"><Alert>{reading.message}</Alert></div>}

            <input
              ref={(input) => {
                folderInput.current = input;
                // Not in React's attribute types; the property reflects the attribute.
                if (input) input.webkitdirectory = true;
              }}
              type="file"
              multiple
              data-import="folder"
              aria-label="Vault folder"
              className="hidden"
              onChange={onPick}
            />
            <input ref={filesInput} type="file" multiple accept=".md,text/markdown" data-import="files" aria-label="Markdown files" className="hidden" onChange={onPick} />
            <input ref={jsonInput} type="file" accept=".json,application/json" data-import="json" aria-label="JSON graph file" className="hidden" onChange={onPick} />
            <input ref={csvInput} type="file" accept=".csv,.tsv,text/csv,text/tab-separated-values" data-import="csv" aria-label="CSV edge list" className="hidden" onChange={onPick} />
          </section>
        )}

        {step === 2 && (
          <section aria-labelledby={`${id}-step`}>
            <h3 id={`${id}-step`} ref={headingRef} tabIndex={-1} className="text-[13px] font-medium text-(--g-text) outline-none">
              How should it become a graph?
            </h3>
            {payload && !markdown && (
              <p className="mt-1 text-[12px] text-(--g-text-3)">
                This file is already a graph, so grouping, attachments and aliases come from it as written.
              </p>
            )}
            <fieldset disabled={!!payload && !markdown} className="mt-3 disabled:opacity-50">
              <legend className="text-[13px] text-(--g-text)">Group notes by</legend>
              <div className="mt-1.5 inline-flex rounded-[8px] border border-(--g-border) bg-(--g-panel) p-0.5">
                {(["folder", "tag"] as const).map((value) => (
                  <label
                    key={value}
                    className={cn(
                      "grid h-7 cursor-pointer place-items-center rounded-[6px] px-3 text-[13px] transition-colors duration-150",
                      options.groupBy === value ? "bg-(--g-hover) text-(--g-text)" : "text-(--g-text-2) hover:text-(--g-text)",
                      "has-[input:focus-visible]:outline-solid has-[input:focus-visible]:outline-2 has-[input:focus-visible]:outline-(--g-accent)",
                    )}
                  >
                    <input type="radio" name={`${id}-group`} value={value} checked={options.groupBy === value} onChange={() => set("groupBy", value)} className="sr-only" />
                    {value === "folder" ? "Folder" : "Tag"}
                  </label>
                ))}
              </div>
              <p className="mt-1.5 text-[12px] text-(--g-text-3)">
                {options.groupBy === "folder" ? "Top-level folder; notes at the root use their first #tag." : "First #tag; untagged notes use their top-level folder."}
              </p>
            </fieldset>
            <div className="mt-3 divide-y divide-(--g-border) border-y border-(--g-border)">
              <div className="py-1.5">
                <Switch
                  label="Create nodes for unresolved links"
                  description="Links to notes that don’t exist yet show as dashed rings, as in Obsidian. Off drops those links."
                  checked={options.unresolved}
                  onChange={(value) => set("unresolved", value)}
                />
              </div>
              <div className="py-1.5">
                <Switch
                  label="Include attachments"
                  description="Images, PDFs and canvases that notes link to become nodes."
                  checked={options.attachments}
                  disabled={!!payload && !markdown}
                  onChange={(value) => set("attachments", value)}
                />
              </div>
              <div className="py-1.5">
                <Switch
                  label="Resolve aliases"
                  description="[[Alias]] links reach the note that lists it under aliases: in its frontmatter."
                  checked={options.resolveAliases}
                  disabled={!!payload && !markdown}
                  onChange={(value) => set("resolveAliases", value)}
                />
              </div>
            </div>
            {busy && <div className="mt-4"><ProgressBar progress={reading.progress} /></div>}
          </section>
        )}

        {step === 3 && (
          <section aria-labelledby={`${id}-step`}>
            <h3 id={`${id}-step`} ref={headingRef} tabIndex={-1} className="text-[13px] font-medium text-(--g-text) outline-none">
              Preview
            </h3>
            <p className="mt-0.5 truncate text-[12px] text-(--g-text-3)">{payload?.source ?? "Reading your notes…"}</p>
            {busy && <div className="mt-3"><ProgressBar progress={reading.progress} /></div>}
            {building && !preview && (
              <p className="mt-3 flex items-center gap-2 text-[12px] text-(--g-text-2)">
                <span aria-hidden="true" className={cn("size-1.5 rounded-full bg-(--g-accent)", styles.pulse)} />
                Building the preview…
              </p>
            )}
            {preview && preview.error !== null && <div className="mt-3"><Alert>{preview.error}</Alert></div>}
            {ready && payload && (
              <>
                <dl aria-busy={stale} className={cn("mt-3 grid grid-cols-2 gap-2 transition-opacity duration-150 sm:grid-cols-3", stale && "opacity-60")}>
                  <Stat label="Notes" value={formatCount(ready.notes)} hint={ready.attachments ? `+ ${plural(ready.attachments, "attachment")}` : undefined} />
                  <Stat label="Links" value={formatCount(ready.normalized.links.length)} />
                  <Stat label="Unresolved links" value={built!.options.unresolved ? formatCount(ready.insights.unresolved.length) : "Off"} hint={built!.options.unresolved ? "notes not written yet" : "links dropped"} />
                  <Stat
                    label="Likely duplicates"
                    value={ready.duplicatesChecked ? formatCount(ready.insights.duplicates.length) : "—"}
                    hint={ready.duplicatesChecked ? undefined : "listed in the sidebar after import"}
                  />
                  <Stat
                    label="Disconnected clusters"
                    value={formatCount(ready.insights.clusters.length + ready.insights.orphans.length)}
                    hint={`incl. ${plural(ready.insights.orphans.length, "single note")}`}
                  />
                  <Stat
                    label="File warnings"
                    value={formatCount(payload.warnings.length)}
                    tone={payload.warnings.length ? "warn" : undefined}
                    hint={payload.warnings.length ? "see below" : "none"}
                  />
                </dl>

                {trimmed && <p className="mt-3 text-[12px] text-(--g-text-3)">{trimmed}</p>}

                {ready.insights.duplicates.length > 0 && (
                  <div className="mt-4">
                    <h4 className="text-[12px] text-(--g-text-3)">Likely duplicates</h4>
                    <ul className="mt-1 space-y-0.5 text-[12px] text-(--g-text-2)">
                      {ready.insights.duplicates.slice(0, 3).map(({ a, b }) => (
                        // Same title in two folders: the paths tell them apart.
                        <li key={`${a.id}|${b.id}`} className="truncate">
                          “{a.label === b.label ? a.id : a.label}” looks like “{a.label === b.label ? b.id : b.label}”
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {payload.warnings.length > 0 && (
                  <details className="mt-4 rounded-[10px] border border-(--g-border) bg-(--g-panel)">
                    <summary className={cn("flex cursor-pointer list-none items-center gap-2 rounded-[10px] px-3 py-2 text-[12px] text-(--g-text)", focusRing)}>
                      <span className="text-(--g-warn)"><Icon name="alert" size={14} /></span>
                      {plural(payload.warnings.length, "file")} with warnings
                      <Icon name="chevron" size={14} className="ml-auto text-(--g-text-3)" />
                    </summary>
                    <ul className={cn(styles.scroll, "max-h-40 space-y-1 overflow-y-auto border-t border-(--g-border) px-3 py-2 text-[12px]")}>
                      {payload.warnings.slice(0, 200).map((warning, i) => (
                        <li key={`${warning.path}-${i}`} className="min-w-0">
                          <span className={cn(styles.mono, "break-all text-(--g-text)")}>{warning.path}</span>
                          <span className="text-(--g-text-3)"> · {warning.message}</span>
                        </li>
                      ))}
                      {payload.warnings.length > 200 && <li className="text-(--g-text-3)">and {formatCount(payload.warnings.length - 200)} more</li>}
                    </ul>
                  </details>
                )}

                {payload.kind === "markdown" && (payload.skipped.folders.length > 0 || payload.skipped.attachments > 0 || payload.skipped.other > 0) && (
                  <p className="mt-3 text-[12px] text-(--g-text-3)">
                    Skipped{" "}
                    {[
                      payload.skipped.folders.length > 0 && `${payload.skipped.folders.slice(0, 4).join(", ")}${payload.skipped.folders.length > 4 ? ` and ${payload.skipped.folders.length - 4} more folders` : ""}`,
                      payload.skipped.attachments > 0 && `${plural(payload.skipped.attachments, "attachment")}${options.attachments ? " (kept as link targets)" : ""}`,
                      payload.skipped.other > 0 && `${plural(payload.skipped.other, "other file")}`,
                    ].filter(Boolean).join(" · ")}
                    .
                  </p>
                )}
              </>
            )}
          </section>
        )}
      </div>

      <footer className="flex shrink-0 items-center gap-2 border-t border-(--g-border) px-5 py-3 max-sm:flex-wrap">
        <p className={cn(styles.mono, "min-w-0 flex-1 truncate text-[12px] text-(--g-text-3) max-sm:basis-full")}>{status}</p>
        {/* Progress changes many times a second; screen readers hear only the start and the end. */}
        <p aria-live="polite" className="sr-only">{announcement}</p>
        <div className="flex items-center gap-2 max-sm:ml-auto">
          {step === 1 ? (
            <button type="button" onClick={close} className={secondaryButton}>Cancel</button>
          ) : (
            <button type="button" onClick={() => setStep((at) => (at - 1) as Step)} className={secondaryButton}>Back</button>
          )}
          {step === 1 && (
            <button type="button" disabled={reading.status !== "ready" && !busy} onClick={() => setStep(2)} className={primaryButton}>Next</button>
          )}
          {step === 2 && <button type="button" onClick={() => setStep(3)} className={primaryButton}>Preview</button>}
          {step === 3 && (
            <button type="button" disabled={!payload || !ready || notes === 0 || stale} onClick={finish} className={primaryButton}>
              {payload && ready ? `Import ${plural(notes, "note")}` : busy ? "Reading…" : "Import"}
            </button>
          )}
        </div>
      </footer>
    </dialog>
  );
}
