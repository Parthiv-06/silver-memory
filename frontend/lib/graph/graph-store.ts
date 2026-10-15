import { API_BASE_URL, clearToken, readToken } from "@/lib/api";
import { parseGraphData } from "./adapters";
import { normalizeGraph } from "./normalize";
import { UNGROUPED, UNRESOLVED_GROUP } from "./theme";
import type { GraphData, GraphGroupStyle, GraphNode } from "./types";

/** The graph as the account stores it, with what it was imported from. */
export interface SavedGraph {
  graph: GraphData;
  /** Where it came from, e.g. "Obsidian vault: My Vault". */
  source: string;
  /** ISO-8601, UTC. */
  updatedAt: string;
  nodes: number;
  links: number;
}

export type SavedGraphInfo = Omit<SavedGraph, "graph">;

/** The last import, kept in this browser. */
export interface LocalGraph {
  graph: GraphData;
  source: string;
  /** ISO-8601, when it was imported. Also identifies the import. */
  savedAt: string;
  /** The Obsidian vault's name, for obsidian:// links (imports of an Obsidian vault only). */
  vault?: string;
  /** `updated_at` of the account copy once this import was saved there; unset while it isn't. */
  syncedAt?: string;
}

/** A failed account request; `message` is written for people and can be shown as is. */
export class GraphStoreError extends Error {
  constructor(
    message: string,
    /** "session": sign in again. "rejected": the backend refused this graph (too big, bad field). */
    readonly reason: "session" | "rejected" | "network" | "server",
    readonly status?: number,
  ) {
    super(message);
    this.name = "GraphStoreError";
  }
}

/** The contract's limit on a PUT /graph body. */
export const MAX_SAVE_BYTES = 15 * 1024 * 1024;
export const MAX_SOURCE_LENGTH = 200;

/** What the account accepts (backend/graph.py). Lengths are in code points, as Python counts them. */
export const LIMITS = {
  nodes: 50_000,
  links: 250_000,
  id: 512,
  label: 512,
  group: 120,
  tags: 32,
  tag: 120,
  metaBytes: 4096,
  groups: 10_000,
} as const;

export const SESSION_EXPIRED = "Your session expired. Enter the code word again.";

// ---- normalising ------------------------------------------------------------------------------

/** How many fields `toStorableGraph` shortened or dropped to fit the account's limits. */
export interface TrimReport {
  labels: number;
  groups: number;
  /** Notes whose tags were cut to 32 or shortened. */
  tags: number;
  /** Notes whose meta was over 4 KB (only `path`/`url` kept, or dropped). */
  meta: number;
}

const utf8 = new TextEncoder();

/** `text` cut to `max` code points (never splitting an emoji into a lone surrogate). */
export function clip(text: string, max: number, ellipsis = false): string {
  if (text.length <= max) return text; // UTF-16 length ≥ code points, so this is exact
  const points = Array.from(text);
  if (points.length <= max) return text;
  return ellipsis ? `${points.slice(0, max - 1).join("")}…` : points.slice(0, max).join("");
}

function codePoints(text: string): number {
  return text.length <= LIMITS.id ? text.length : Array.from(text).length;
}

function metaBytes(meta: Record<string, unknown>): number {
  try {
    return utf8.encode(JSON.stringify(meta)).length;
  } catch {
    return Infinity; // cycles or BigInts can't be stored at all
  }
}

function storableMeta(meta: Record<string, unknown>): Record<string, unknown> | undefined {
  if (metaBytes(meta) <= LIMITS.metaBytes) return meta;
  // Keep what opening a note needs, if that alone fits.
  const kept: Record<string, unknown> = {};
  if (typeof meta.path === "string") kept.path = meta.path;
  if (typeof meta.url === "string") kept.url = meta.url;
  return Object.keys(kept).length > 0 && metaBytes(kept) <= LIMITS.metaBytes ? kept : undefined;
}

/**
 * The graph in the shape the backend accepts: unique notes, every link end a note (dangling targets
 * become `unresolved` notes), no self-links or duplicate links, and fields cut to the account's
 * limits (labels 512, groups and tags 120, 32 tags, 4 KB of meta), so one long title can't block a
 * save. Defaults the view fills in by itself (the "ungrouped" group, weight 1) are left out to keep
 * the payload small. Pass `report` to learn what was shortened. Ids are never changed: links point
 * at them (`storableProblem` says when one is too long).
 */
export function toStorableGraph(data: GraphData, report?: TrimReport): GraphData {
  const graph = normalizeGraph(data);
  const used = new Set<string>([UNGROUPED, UNRESOLVED_GROUP]);
  const nodes = graph.nodes.map((node): GraphNode => {
    const label = clip(node.label, LIMITS.label, true);
    if (report && label !== node.label) report.labels++;
    const out: GraphNode = { id: node.id, label };
    const defaulted = node.group === UNGROUPED || (node.unresolved && node.group === UNRESOLVED_GROUP);
    if (node.group && !defaulted) {
      out.group = clip(node.group, LIMITS.group);
      if (report && out.group !== node.group) report.groups++;
      used.add(out.group);
    }
    if (node.tags?.length) {
      const tags = [...new Set(node.tags.map((tag) => clip(String(tag), LIMITS.tag)))].slice(0, LIMITS.tags);
      if (report && (tags.length !== node.tags.length || tags.some((tag, i) => tag !== node.tags![i]))) report.tags++;
      out.tags = tags;
    }
    if (node.unresolved) out.unresolved = true;
    if (node.meta && Object.keys(node.meta).length > 0) {
      const meta = storableMeta(node.meta);
      if (report && meta !== node.meta) report.meta++;
      if (meta) out.meta = meta;
    }
    return out;
  });
  const links = graph.links.map(({ source, target, weight }) => (weight !== undefined && weight !== 1 ? { source, target, weight } : { source, target }));
  if (!data.groups) return { nodes, links };
  // Only styles for groups that are used (with their keys cut like the nodes' groups).
  // No prototype, so a group called "__proto__" is just a key.
  const groups = Object.create(null) as Record<string, GraphGroupStyle>;
  let kept = 0;
  for (const [key, style] of Object.entries(data.groups)) {
    const name = clip(key, LIMITS.group);
    if (!used.has(name) || Object.prototype.hasOwnProperty.call(groups, name) || !style || typeof style !== "object") continue;
    if (++kept > LIMITS.groups) break;
    const out: GraphGroupStyle = {};
    if (typeof style.label === "string") out.label = clip(style.label, LIMITS.label, true);
    if (typeof style.color === "string" && style.color.length <= LIMITS.group) out.color = style.color;
    groups[name] = out;
  }
  return { nodes, links, groups };
}

/** Why the account can't take this (storable) graph at all, or null when it can. */
export function storableProblem(graph: GraphData): string | null {
  const count = (n: number) => n.toLocaleString("en-US");
  if (graph.nodes.length > LIMITS.nodes) return `This graph has ${count(graph.nodes.length)} notes; the account keeps up to ${count(LIMITS.nodes)}. It stays in this browser.`;
  if (graph.links.length > LIMITS.links) return `This graph has ${count(graph.links.length)} links; the account keeps up to ${count(LIMITS.links)}. It stays in this browser.`;
  const long = graph.nodes.find((node) => codePoints(node.id) > LIMITS.id);
  if (long) return `The note “${clip(long.id, 60, true)}” has a path over ${LIMITS.id} characters, which the account can’t store. Shorten its name or folders and import again.`;
  return null;
}

export { countNotes } from "./normalize";

/** Shortens a source label to what the backend stores (no NULs, at most 200 code points). */
export function sourceLabel(text: string): string {
  return clip(text.replace(/\s+/g, " ").replace(/\0/g, "").trim(), MAX_SOURCE_LENGTH, true);
}

// ---- this browser (IndexedDB) -----------------------------------------------------------------

const DB_NAME = "silver-memory-graph";
const STORE = "imports";
const KEY = "last";

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (db: IDBDatabase | null) => {
      // A database that opens after we gave up on it (blocked, then unblocked) is closed again.
      if (settled) db?.close();
      else resolve(db);
      settled = true;
    };
    try {
      if (typeof indexedDB === "undefined") return settle(null);
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
      };
      request.onsuccess = () => settle(request.result);
      // Private windows, blocked storage or a full disk: carry on without it.
      request.onerror = () => settle(null);
      request.onblocked = () => settle(null);
    } catch {
      settle(null);
    }
  });
}

async function withStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest, fallback: T): Promise<T> {
  const db = await openDb();
  if (!db) return fallback;
  try {
    return await new Promise<T>((resolve) => {
      try {
        const tx = db.transaction(STORE, mode);
        const request = run(tx.objectStore(STORE));
        let result: T = fallback;
        request.onsuccess = () => { result = request.result as T; };
        tx.oncomplete = () => resolve(mode === "readonly" ? result : (true as T));
        tx.onerror = () => resolve(fallback);
        tx.onabort = () => resolve(fallback);
      } catch {
        resolve(fallback);
      }
    });
  } finally {
    db.close();
  }
}

/** The last graph imported in this browser, or null (none, or storage is unavailable). */
export async function loadLocalGraph(): Promise<LocalGraph | null> {
  const record = await withStore<unknown>("readonly", (store) => store.get(KEY), null);
  if (!record || typeof record !== "object") return null;
  const { graph, source, savedAt, vault, syncedAt } = record as Record<string, unknown>;
  try {
    return {
      graph: parseGraphData(graph, "graph kept in this browser"),
      source: typeof source === "string" && source ? source : "Imported graph",
      savedAt: typeof savedAt === "string" ? savedAt : "",
      ...(typeof vault === "string" && vault && { vault }),
      ...(typeof syncedAt === "string" && syncedAt && { syncedAt }),
    };
  } catch {
    // Written by an older version or damaged: forget it rather than fail every visit.
    await clearLocalGraph();
    return null;
  }
}

/**
 * Keeps `record` for the next visit. `record.graph` must already be storable (from
 * `toStorableGraph`, or read back from the account), so it isn't normalised again here.
 * Resolves false when this browser won't store it.
 */
export async function saveLocalGraph(record: LocalGraph): Promise<boolean> {
  const kept: LocalGraph = { ...record, source: sourceLabel(record.source) };
  return withStore<boolean>("readwrite", (store) => store.put(kept, KEY), false);
}

/** Notes that the import made at `savedAt` is now in the account as of `syncedAt`. */
export async function markLocalGraphSynced(savedAt: string, syncedAt: string): Promise<void> {
  const db = await openDb();
  if (!db) return;
  try {
    await new Promise<void>((resolve) => {
      try {
        const tx = db.transaction(STORE, "readwrite");
        const store = tx.objectStore(STORE);
        const get = store.get(KEY);
        get.onsuccess = () => {
          const record = get.result as LocalGraph | undefined;
          // Only the same import: another one may have replaced it while the save ran.
          if (record && typeof record === "object" && record.savedAt === savedAt) store.put({ ...record, syncedAt }, KEY);
        };
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
        tx.onabort = () => resolve();
      } catch {
        resolve();
      }
    });
  } finally {
    db.close();
  }
}

export async function clearLocalGraph(): Promise<void> {
  await withStore<boolean>("readwrite", (store) => store.delete(KEY), false);
}

// ---- the account (backend /graph) -------------------------------------------------------------

async function problem(res: Response): Promise<string | null> {
  const body: unknown = await res.json().catch(() => null);
  if (!body || typeof body !== "object") return null;
  const detail = (body as { detail?: unknown }).detail;
  if (typeof detail === "string") return detail;
  // FastAPI's validation shape: [{ loc, msg }], where the backend's msg already names the field
  // ("nodes[12].label is longer than 512 characters").
  if (Array.isArray(detail)) {
    const messages = detail
      // The backend lists up to 20 problems, then a "too_many_errors" entry that isn't one itself.
      .filter((item) => item && typeof item === "object" && (item as { type?: unknown }).type !== "too_many_errors")
      .map((item) => (item as { msg?: unknown }).msg)
      .filter((msg): msg is string => typeof msg === "string");
    // Past 20 problems the backend stops listing them, so the real count is unknown.
    const more = detail.some((item) => item && typeof item === "object" && (item as { type?: unknown }).type === "too_many_errors");
    if (messages.length === 1 && !more) return messages[0];
    if (messages.length >= 1) {
      const extra = messages.length - 1;
      return more ? `${messages[0]} (and more problems)` : `${messages[0]} (and ${extra} more ${extra === 1 ? "problem" : "problems"})`;
    }
  }
  return null;
}

async function request(method: "GET" | "PUT" | "DELETE", init: RequestInit = {}): Promise<Response> {
  const token = readToken();
  if (!token) throw new GraphStoreError("Enter the code word on the shelf first to use your account.", "session");
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  headers.set("Accept", "application/json");
  let res: Response;
  try {
    res = await fetch(`${API_BASE_URL}/graph`, { ...init, method, headers });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    if (error instanceof DOMException && error.name === "TimeoutError") throw new GraphStoreError("Could not reach the server: it took too long to answer", "network");
    throw new GraphStoreError(`Could not reach the server: ${error instanceof Error ? error.message : String(error)}`, "network");
  }
  if (res.status === 401) {
    clearToken();
    throw new GraphStoreError(SESSION_EXPIRED, "session", 401);
  }
  return res;
}

function info(body: Record<string, unknown>, fallback: { source: string; nodes: number; links: number }): SavedGraphInfo {
  return {
    source: typeof body.source === "string" ? body.source : fallback.source,
    updatedAt: typeof body.updated_at === "string" ? body.updated_at : new Date().toISOString(),
    nodes: typeof body.nodes === "number" ? body.nodes : fallback.nodes,
    links: typeof body.links === "number" ? body.links : fallback.links,
  };
}

/** The graph saved to the account, or null when nothing is saved yet. */
export async function getSavedGraph(init: { signal?: AbortSignal } = {}): Promise<SavedGraph | null> {
  const res = await request("GET", init);
  if (res.status === 404) return null;
  if (!res.ok) throw new GraphStoreError(`Could not load your saved graph: ${(await problem(res)) ?? `HTTP ${res.status}`}`, "server", res.status);
  let body: unknown;
  try {
    body = await res.json();
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    // A deadline (AbortSignal.timeout) that runs out while the body downloads.
    if (error instanceof DOMException && error.name === "TimeoutError") throw new GraphStoreError("Could not reach the server: it took too long to answer", "network");
    throw new GraphStoreError("The saved graph is not valid JSON", "server", res.status);
  }
  if (!body || typeof body !== "object") throw new GraphStoreError("The saved graph response is not a JSON object", "server", res.status);
  const record = body as Record<string, unknown>;
  const graph = parseGraphData(record.graph, "graph saved to your account");
  return { graph, ...info(record, { source: "Saved graph", nodes: graph.nodes.length, links: graph.links.length }) };
}

/** Replaces the account's graph with `graph` (normalised first, so every link end is a note). */
export async function saveGraph(graph: GraphData, source: string, init: { signal?: AbortSignal } = {}): Promise<SavedGraphInfo> {
  const storable = toStorableGraph(graph);
  const refused = storableProblem(storable);
  if (refused) throw new GraphStoreError(refused, "rejected", 422);
  const label = sourceLabel(source);
  const body = JSON.stringify({ graph: storable, source: label });
  const bytes = new Blob([body]).size;
  if (bytes > MAX_SAVE_BYTES) {
    const mb = (n: number) => (n / 1024 / 1024).toFixed(1);
    throw new GraphStoreError(`This graph is ${mb(bytes)} MB; the account keeps graphs up to ${mb(MAX_SAVE_BYTES)} MB. It stays in this browser.`, "rejected", 413);
  }
  const res = await request("PUT", { ...init, body, headers: { "Content-Type": "application/json" } });
  if (res.status === 413 || res.status === 422) {
    throw new GraphStoreError((await problem(res)) ?? `The server refused this graph (HTTP ${res.status})`, "rejected", res.status);
  }
  if (!res.ok) throw new GraphStoreError(`Could not save the graph: ${(await problem(res)) ?? `HTTP ${res.status}`}`, "server", res.status);
  const saved: unknown = await res.json().catch(() => ({}));
  return info(saved && typeof saved === "object" ? (saved as Record<string, unknown>) : {}, {
    source: label,
    nodes: storable.nodes.length,
    links: storable.links.length,
  });
}

/** Removes the account's graph. Nothing saved is not an error. */
export async function deleteSavedGraph(init: { signal?: AbortSignal } = {}): Promise<void> {
  const res = await request("DELETE", init);
  if (res.ok || res.status === 404) return;
  throw new GraphStoreError(`Could not remove the saved graph: ${(await problem(res)) ?? `HTTP ${res.status}`}`, "server", res.status);
}
