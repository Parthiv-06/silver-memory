import { fetchGraph, fromEdgeList, fromMarkdownNotes, isAttachmentPath, parseGraphData, type MarkdownNote } from "./adapters";
import type { GraphData } from "./types";

/** Notes bigger than this are skipped (with a warning): they are almost always exports or logs. */
export const MAX_NOTE_BYTES = 2 * 1024 * 1024;
/** A JSON graph or edge list may be bigger than a note, but not unboundedly so. */
export const MAX_GRAPH_FILE_BYTES = 64 * 1024 * 1024;
const CONCURRENCY = 16;
// Guards for dropped folders: directory trees deeper than this are not walked, and listing stops
// after this many entries. A folder symlinked into itself would otherwise be listed again and again.
const MAX_DEPTH = 32;
export const MAX_ENTRIES = 100_000;

/** A file that was picked or dropped, before anything is read. */
export interface PickedFile {
  /** Path as picked, starting with the picked folder ("My Vault/Infra/Caching.md"); a loose file's name. */
  path: string;
  /** Known up front for picked files; dropped files only know it once `file()` resolves. */
  size?: number;
  file: () => Promise<File>;
}

export interface FileWarning {
  /** Vault-relative path. */
  path: string;
  message: string;
}

/** What was picked or dropped, listed but not read. */
export interface PickedSelection {
  files: PickedFile[];
  /** Hidden and system folders that were not walked (drag and drop skips them while listing). */
  skippedFolders: string[];
  warnings: FileWarning[];
}

export interface SkippedFiles {
  /** Hidden and system folders that were left out (".obsidian", ".git", ".trash", "node_modules"). */
  folders: string[];
  /** Attachments (images, PDFs, canvases): only their paths are kept, for link resolution. */
  attachments: number;
  /** Hidden files and files that are neither notes nor attachments. */
  other: number;
}

export type ImportPayload =
  | {
      kind: "markdown";
      /** Vault name (the picked folder), or "" for loose files. */
      name: string;
      /** The folder has an .obsidian settings folder. */
      obsidian: boolean;
      /** Label for where it came from, e.g. "Obsidian vault: My Vault". */
      source: string;
      notes: MarkdownNote[];
      /** Vault-relative attachment paths. */
      attachments: string[];
      skipped: SkippedFiles;
      warnings: FileWarning[];
    }
  | {
      kind: "graph";
      format: "json" | "csv" | "url";
      name: string;
      source: string;
      graph: GraphData;
      warnings: FileWarning[];
    };

export interface ReadProgress {
  done: number;
  total: number;
  /** The file just read. */
  path?: string;
}

export interface ReadOptions {
  signal?: AbortSignal;
  /** Called with 0 of N once the files are listed, then as they are read (at most every 50 ms). */
  onProgress?: (progress: ReadProgress) => void;
  /** Files read at once (default 16). */
  concurrency?: number;
}

export interface ImportOptions {
  /** How notes are coloured: top-level folder (else first #tag), or first #tag (else folder). */
  groupBy: "folder" | "tag";
  /** Keep links to notes that don't exist yet as unresolved nodes; off drops those links. */
  unresolved: boolean;
  /** Linked images, PDFs and canvases become nodes. */
  attachments: boolean;
  /** [[Alias]] links resolve through frontmatter `aliases`. */
  resolveAliases: boolean;
}

export const DEFAULT_IMPORT_OPTIONS: ImportOptions = { groupBy: "folder", unresolved: true, attachments: false, resolveAliases: false };

// Only .md, like Obsidian (which doesn't show .markdown files or resolve links to them).
const NOTE = /\.md$/i;
const JSON_FILE = /\.json$/i;
const EDGE_LIST = /\.(csv|tsv)$/i;

/** ".obsidian", ".git", ".trash", ".DS_Store" and node_modules are never part of a vault. */
function isHiddenName(name: string): boolean {
  return name.startsWith(".") || name === "node_modules";
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function abortError(): DOMException {
  return new DOMException("The import was cancelled", "AbortError");
}

function checkAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : abortError();
}

function message(error: unknown): string {
  return error instanceof Error ? error.message || error.name : String(error);
}

function megabytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// ---- listing ----------------------------------------------------------------------------------

/** Files from `<input type="file">`, with or without `webkitdirectory`. */
export function filesFromList(list: FileList | readonly File[]): PickedSelection {
  return {
    files: Array.from(list, (file) => ({ path: file.webkitRelativePath || file.name, size: file.size, file: async () => file })),
    skippedFolders: [],
    warnings: [],
  };
}

function readAll(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => {
    const all: FileSystemEntry[] = [];
    // readEntries hands out a batch (about 100) per call, then an empty one when done.
    const next = () => reader.readEntries((batch) => {
      if (batch.length === 0) return resolve(all);
      all.push(...batch);
      next();
    }, reject);
    next();
  });
}

/**
 * Files and folders dropped on the page. Call it inside the drop handler: the browser empties the
 * DataTransfer once the event returns, so its entries are taken synchronously and walked afterwards.
 */
export function filesFromDrop(data: DataTransfer, signal?: AbortSignal, onListed?: (count: number) => void): Promise<PickedSelection> {
  const entries: FileSystemEntry[] = [];
  const loose: File[] = [];
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind !== "file") continue;
    const entry = typeof item.webkitGetAsEntry === "function" ? item.webkitGetAsEntry() : null;
    if (entry) entries.push(entry);
    else {
      const file = item.getAsFile();
      if (file) loose.push(file);
    }
  }
  if (entries.length === 0 && loose.length === 0) loose.push(...Array.from(data.files ?? []));
  return walk(entries, loose, signal, onListed);
}

async function walk(entries: readonly FileSystemEntry[], loose: readonly File[], signal?: AbortSignal, onListed?: (count: number) => void): Promise<PickedSelection> {
  const selection = filesFromList(loose);
  let seen = 0, reported = 0, capped = false;
  const visit = async (entry: FileSystemEntry, depth: number): Promise<void> => {
    checkAborted(signal);
    if (capped) return;
    if (++seen > MAX_ENTRIES) {
      capped = true;
      selection.warnings.push({ path: entry.fullPath.replace(/^\/+/, "") || entry.name, message: `Stopped listing after ${MAX_ENTRIES.toLocaleString("en-US")} files and folders; the rest were not read` });
      return;
    }
    const now = performance.now();
    if (onListed && now - reported > 100) {
      reported = now;
      onListed(selection.files.length);
    }
    const path = entry.fullPath.replace(/^\/+/, "") || entry.name;
    if (entry.isFile) {
      const fileEntry = entry as FileSystemFileEntry;
      selection.files.push({ path, file: () => new Promise<File>((resolve, reject) => fileEntry.file(resolve, reject)) });
      return;
    }
    if (!entry.isDirectory) return;
    // The dropped folder itself may be called anything; below it, hidden folders are skipped unread.
    if (depth > 0 && isHiddenName(entry.name)) {
      selection.skippedFolders.push(path);
      return;
    }
    if (depth > MAX_DEPTH) {
      selection.warnings.push({ path, message: `Not read: more than ${MAX_DEPTH} folders deep` });
      return;
    }
    let children: FileSystemEntry[];
    try {
      children = await readAll((entry as FileSystemDirectoryEntry).createReader());
    } catch (error) {
      selection.warnings.push({ path, message: `Could not list this folder: ${message(error)}` });
      return;
    }
    for (const child of children) await visit(child, depth + 1);
  };
  for (const entry of entries) await visit(entry, 0);
  onListed?.(selection.files.length);
  return selection;
}

// ---- reading ----------------------------------------------------------------------------------

/** The folder every path starts with, if there is exactly one ("My Vault"), else "". */
function commonRoot(paths: readonly string[]): string {
  let root: string | null = null;
  for (const path of paths) {
    const slash = path.indexOf("/");
    if (slash <= 0) return "";
    const first = path.slice(0, slash);
    if (root === null) root = first;
    else if (first !== root) return "";
  }
  return root ?? "";
}

/** The first hidden folder on `path` ("a/.git/objects/x" → "a/.git"), or null. */
function hiddenFolder(path: string): string | null {
  const parts = path.split("/");
  for (let i = 0; i < parts.length - 1; i++) if (isHiddenName(parts[i])) return parts.slice(0, i + 1).join("/");
  return null;
}

async function mapLimit<T>(items: readonly T[], limit: number, run: (item: T) => Promise<void>, signal?: AbortSignal): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      checkAborted(signal);
      await run(items[next++]);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  checkAborted(signal);
}

const strictUtf8 = new TextDecoder("utf-8", { fatal: true });
const lenientUtf8 = new TextDecoder("utf-8", { fatal: false });

/** UTF-8 text; bytes that aren't UTF-8 become U+FFFD instead of failing the import. */
function decode(buffer: ArrayBuffer): { text: string; valid: boolean } {
  try {
    return { text: strictUtf8.decode(buffer), valid: true };
  } catch {
    return { text: lenientUtf8.decode(buffer), valid: false };
  }
}

async function readGraphFile(picked: PickedFile, path: string, signal?: AbortSignal): Promise<{ text: string; warnings: FileWarning[] }> {
  let file: File;
  try {
    file = await picked.file();
  } catch (error) {
    throw new Error(`Could not open ${path}: ${message(error)}`);
  }
  if (file.size > MAX_GRAPH_FILE_BYTES) throw new Error(`${path} is ${megabytes(file.size)}; files up to ${megabytes(MAX_GRAPH_FILE_BYTES)} can be imported`);
  let buffer: ArrayBuffer;
  try {
    buffer = await file.arrayBuffer();
  } catch (error) {
    throw new Error(`Could not read ${path}: ${message(error)}`);
  }
  checkAborted(signal);
  const { text, valid } = decode(buffer);
  return { text, warnings: valid ? [] : [{ path, message: "Not valid UTF-8: unreadable characters were replaced" }] };
}

/**
 * Lists, filters and reads what was picked: a vault folder or loose .md files (read 16 at a time,
 * with progress), or a single .json graph or .csv/.tsv edge list. Hidden folders (.obsidian, .git,
 * .trash), node_modules, non-markdown files and notes over 2 MB are skipped; paths become
 * vault-relative. Throws an Error that says exactly what is wrong when nothing can be imported.
 */
export async function readSelection(selection: PickedSelection, options: ReadOptions = {}): Promise<ImportPayload> {
  const { signal, onProgress } = options;
  checkAborted(signal);
  const root = commonRoot([...selection.files.map((file) => file.path), ...selection.skippedFolders]);
  const relative = (path: string) => (root ? path.slice(root.length + 1) : path);
  const warnings = selection.warnings.map((warning) => ({ ...warning, path: relative(warning.path) || warning.path }));

  const folders = new Set(selection.skippedFolders.map(relative));
  const notes: { picked: PickedFile; path: string }[] = [];
  const graphs: { picked: PickedFile; path: string }[] = [];
  const attachments: string[] = [];
  let other = 0;
  for (const picked of selection.files) {
    const path = relative(picked.path);
    const hidden = hiddenFolder(path);
    if (hidden) folders.add(hidden);
    else if (isHiddenName(basename(path))) other++;
    else if (NOTE.test(path)) notes.push({ picked, path });
    else if (isAttachmentPath(path)) attachments.push(path);
    else if (JSON_FILE.test(path) || EDGE_LIST.test(path)) graphs.push({ picked, path });
    else other++;
  }
  // In a vault, JSON and CSV files are just files: say they were skipped.
  if (notes.length > 0) other += graphs.length;
  const obsidian = [...folders].some((folder) => folder === ".obsidian");
  const where = root ? `“${root}”` : "the selection";

  if (notes.length === 0) {
    if (graphs.length === 1) {
      const [{ picked, path }] = graphs;
      onProgress?.({ done: 0, total: 1 });
      const { text, warnings: decoded } = await readGraphFile(picked, path, signal);
      const name = basename(path).replace(/\.[^.]+$/, "");
      onProgress?.({ done: 1, total: 1, path });
      if (JSON_FILE.test(path)) {
        let value: unknown;
        try {
          value = JSON.parse(text);
        } catch (error) {
          throw new Error(`${path} is not valid JSON: ${message(error)}`);
        }
        const graph = parseGraphData(value, `graph in ${path}`);
        return { kind: "graph", format: "json", name, source: `JSON file: ${basename(path)}`, graph, warnings: [...warnings, ...decoded] };
      }
      const graph = fromEdgeList(text);
      if (graph.links.length === 0) throw new Error(`No links found in ${path}: expected one “source,target[,weight]” row per line`);
      return { kind: "graph", format: "csv", name, source: `Edge list: ${basename(path)}`, graph, warnings: [...warnings, ...decoded] };
    }
    if (graphs.length > 1) throw new Error(`Found ${graphs.length} JSON/CSV files in ${where} and no notes: pick one graph file at a time`);
    const seen = [
      attachments.length && `${attachments.length} attachment${attachments.length === 1 ? "" : "s"}`,
      other && `${other} other file${other === 1 ? "" : "s"}`,
      folders.size && `hidden folders (${[...folders].slice(0, 3).join(", ")})`,
    ].filter(Boolean);
    throw new Error(
      `No Markdown notes (.md) in ${where}${seen.length ? `: only ${seen.join(", ")}` : ""}. Pick the folder that holds your notes, or .md files.`,
    );
  }

  const read: MarkdownNote[] = [];
  const total = notes.length;
  let done = 0, reported = 0;
  onProgress?.({ done: 0, total });
  await mapLimit(notes, options.concurrency ?? CONCURRENCY, async ({ picked, path }) => {
    try {
      if (picked.size !== undefined && picked.size > MAX_NOTE_BYTES) {
        warnings.push({ path, message: `Skipped: ${megabytes(picked.size)}, over the ${megabytes(MAX_NOTE_BYTES)} limit for a note` });
        return;
      }
      const file = await picked.file();
      if (file.size > MAX_NOTE_BYTES) {
        warnings.push({ path, message: `Skipped: ${megabytes(file.size)}, over the ${megabytes(MAX_NOTE_BYTES)} limit for a note` });
        return;
      }
      const { text, valid } = decode(await file.arrayBuffer());
      if (!valid) warnings.push({ path, message: "Not valid UTF-8: unreadable characters were replaced" });
      read.push({ path, content: text });
    } catch (error) {
      if (signal?.aborted) throw error;
      warnings.push({ path, message: `Could not read: ${message(error)}` });
    } finally {
      done++;
      const now = performance.now();
      if (onProgress && (now - reported > 50 || done === total)) {
        reported = now;
        onProgress({ done, total, path });
      }
    }
  }, signal);

  if (read.length === 0) throw new Error(`None of the ${total} notes in ${where} could be read: ${warnings[0]?.message ?? "unknown error"}`);
  // Reads finish in any order; keep the vault's order so ids and groups come out the same every time.
  read.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  warnings.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const loose = !root;
  const source = loose
    ? total === 1 ? `Markdown file: ${basename(notes[0].path)}` : `Markdown files (${total})`
    : obsidian ? `Obsidian vault: ${root}` : `Markdown folder: ${root}`;
  return {
    kind: "markdown",
    name: root,
    obsidian,
    source,
    notes: read,
    attachments,
    skipped: { folders: [...folders].sort(), attachments: attachments.length, other },
    warnings,
  };
}

/** GraphData JSON from a URL (the server must allow CORS), validated like any other graph. */
export async function readGraphUrl(raw: string, signal?: AbortSignal): Promise<ImportPayload> {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error(`“${raw.trim()}” is not a URL: it should start with https://`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error(`Only http and https URLs can be loaded, not ${url.protocol}`);
  const graph = await fetchGraph(url.href, undefined, { signal });
  const name = decodeURIComponent(basename(url.pathname)).replace(/\.json$/i, "") || url.host;
  return { kind: "graph", format: "url", name, source: `JSON URL: ${url.host}${url.pathname}`, graph, warnings: [] };
}

/** Removes unresolved notes and every link that points at a missing note. */
function withoutUnresolved(graph: GraphData): GraphData {
  const ids = new Set<string>();
  for (const node of graph.nodes) if (!node.unresolved) ids.add(String(node.id));
  return {
    ...graph,
    nodes: graph.nodes.filter((node) => !node.unresolved),
    links: graph.links.filter((link) => ids.has(String(link.source)) && ids.has(String(link.target))),
  };
}

// Parsed vaults per payload and parse options, so going back and forth between options (or
// toggling unresolved links, which only filters) doesn't parse every note again.
const parsed = new WeakMap<ImportPayload, Map<string, GraphData>>();

/** The graph an import produces with these options. */
export function buildGraph(payload: ImportPayload, options: ImportOptions): GraphData {
  let graph: GraphData;
  if (payload.kind === "graph") {
    graph = payload.graph;
  } else {
    const key = `${options.groupBy}|${options.attachments}|${options.resolveAliases}`;
    const cache = parsed.get(payload) ?? new Map<string, GraphData>();
    parsed.set(payload, cache);
    graph = cache.get(key) ?? fromMarkdownNotes(payload.notes, {
      embeds: "link",
      groupBy: options.groupBy,
      attachments: options.attachments,
      attachmentPaths: payload.attachments,
      resolveAliases: options.resolveAliases,
    });
    cache.set(key, graph);
  }
  return options.unresolved ? graph : withoutUnresolved(graph);
}
