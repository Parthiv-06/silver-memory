"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { GraphView } from "@/components/graph/graph-view";
import { ImportDialog, type ImportedGraph } from "@/components/graph/import-dialog";
import { SourceHeader, SourceToolbar, type Notice, type SaveState, type SourceInfo } from "@/components/graph/graph-source";
import { readToken } from "@/lib/api";
import { fetchGraph } from "@/lib/graph/adapters";
import {
  GraphStoreError,
  clearLocalGraph,
  countNotes,
  deleteSavedGraph,
  getSavedGraph,
  loadLocalGraph,
  markLocalGraphSynced,
  saveGraph,
  saveLocalGraph,
  sourceLabel,
  type LocalGraph,
  type SavedGraph,
  type SavedGraphInfo,
} from "@/lib/graph/graph-store";
import { sampleGraph } from "@/lib/graph/sample-data";
import type { GraphData, GraphNode } from "@/lib/graph/types";

const GRAPH_URL = process.env.NEXT_PUBLIC_GRAPH_URL;
const OBSIDIAN_VAULT = process.env.NEXT_PUBLIC_OBSIDIAN_VAULT;
// A slow or unreachable backend (a Railway cold start) shouldn't keep the graph waiting forever.
const ACCOUNT_TIMEOUT_MS = 10_000;
// Fast loads (IndexedDB, a warm backend) show no "Loading graph…" flash at all.
const LOADING_DELAY_MS = 300;
const OBSIDIAN_PREFIX = "Obsidian vault: ";

type Source =
  | { kind: "sample" }
  | { kind: "url"; label: string }
  | { kind: "local"; label: string; at: string; vault?: string }
  | { kind: "account"; label: string; at: string; vault?: string };

type State =
  | { status: "ready"; data: GraphData; source: Source }
  | { status: "loading" }
  | { status: "error"; message: string };

/** What the account holds, whether or not it is on screen. */
type Account =
  | { status: "none" }
  /** GET /graph failed (timeout, network, 5xx): there may be a graph we couldn't read. */
  | { status: "unknown" }
  | { status: "saved"; info: SavedGraphInfo };

const SAMPLE: State = { status: "ready", data: sampleGraph, source: { kind: "sample" } };

/**
 * obsidian:// link for a note, using its vault path when the adapter recorded one. Unresolved
 * notes have no file yet, so they get `new` (create it) rather than `open`.
 */
function obsidianUri(vault: string, node: GraphNode): string {
  const path = typeof node.meta?.path === "string" ? node.meta.path.replace(/\.md$/i, "") : node.unresolved ? node.id : node.label;
  return `obsidian://${node.unresolved ? "new" : "open"}?vault=${encodeURIComponent(vault)}&file=${encodeURIComponent(path)}`;
}

/**
 * `meta.url` comes from the graph JSON, so only http(s) links are opened: a `javascript:` URL
 * would run in a window that shares this origin (and its stored session token).
 */
function safeUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  try {
    // Relative links resolve against this page (any http(s) base would do for the scheme check).
    const url = new URL(raw, typeof window === "undefined" ? "http://localhost/" : window.location.href);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

/** `signal`, plus a deadline that aborts with a TimeoutError (AbortSignal.any isn't everywhere yet). */
function withDeadline(signal: AbortSignal, ms: number): AbortSignal {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(new DOMException("The request took too long", "TimeoutError")), ms);
  const stop = () => window.clearTimeout(timer);
  if (signal.aborted) controller.abort(signal.reason);
  signal.addEventListener("abort", () => { stop(); controller.abort(signal.reason); }, { once: true });
  controller.signal.addEventListener("abort", stop, { once: true });
  return controller.signal;
}

/** "Obsidian vault: My Vault" → "My Vault". */
function nameOf(label: string): string {
  const at = label.indexOf(": ");
  return at >= 0 ? label.slice(at + 2) : label;
}

/** The vault an account copy came from; the account keeps only the label, so it is read from that. */
function vaultOf(label: string): string | undefined {
  return label.startsWith(OBSIDIAN_PREFIX) ? label.slice(OBSIDIAN_PREFIX.length) || undefined : undefined;
}

function labelOf(source: Source): string {
  return source.kind === "sample" ? "Sample vault" : source.label;
}

function fromAccount(account: SavedGraph): State {
  return { status: "ready", data: account.graph, source: { kind: "account", label: account.source, at: account.updatedAt, vault: vaultOf(account.source) } };
}

function fromLocal(local: LocalGraph): State {
  return { status: "ready", data: local.graph, source: { kind: "local", label: local.source, at: local.savedAt, vault: local.vault } };
}

/**
 * Whether the import kept in this browser should show instead of the account's copy: it is the only
 * copy, or it was never saved and is newer. One that was saved (`syncedAt`) defers to the account,
 * which holds the same graph or a later one.
 */
function preferLocal(local: LocalGraph, account: SavedGraph | null): boolean {
  if (!account) return true;
  if (local.syncedAt) return false;
  const imported = Date.parse(local.savedAt), saved = Date.parse(account.updatedAt);
  return Number.isNaN(saved) || (!Number.isNaN(imported) && imported > saved);
}

function Centered({ children }: { children: ReactNode }) {
  return (
    <div className="grid h-full place-items-center px-4 text-[13px]" style={{ fontFamily: "var(--font-geist), ui-sans-serif, system-ui, sans-serif" }}>
      {children}
    </div>
  );
}

function Loading() {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setVisible(true), LOADING_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, []);
  return (
    <Centered>
      <p role="status" className={visible ? "flex items-center gap-2 text-[#a1a1aa]" : "invisible"}>
        <span aria-hidden="true" className="size-1.5 animate-pulse rounded-full bg-[#9d8cff]" />
        Loading graph…
      </p>
    </Centered>
  );
}

/**
 * Shows, in order: the graph imported in this browser when it is newer than the account's copy (or
 * the only copy); the graph saved to the account (with a session); the graph at NEXT_PUBLIC_GRAPH_URL
 * when that is set; the sample vault. People can import their own vault, save it to their account,
 * or go back to the sample (or the configured graph).
 */
export function GraphRoute() {
  const [state, setState] = useState<State>({ status: "loading" });
  // `preferDefault`: skip the account and the browser copy (after Reset, with NEXT_PUBLIC_GRAPH_URL).
  const [load, setLoad] = useState({ attempt: 0, preferDefault: false });
  // The stored token was accepted, or couldn't be checked (an unreachable backend keeps it).
  const [session, setSession] = useState(false);
  const [account, setAccount] = useState<Account>({ status: "none" });
  const [save, setSave] = useState<SaveState>({ status: "idle" });
  const [notice, setNotice] = useState<Notice | null>(null);
  const [importing, setImporting] = useState(false);
  // The latest state, for async actions that finish after the graph on screen changed.
  const stateRef = useRef(state);
  useEffect(() => { stateRef.current = state; }, [state]);
  const saving = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    const retry = () => setLoad((current) => ({ attempt: current.attempt + 1, preferDefault: false }));

    const showDefault = async () => {
      if (!GRAPH_URL) return setState(SAMPLE);
      try {
        const data = await fetchGraph(GRAPH_URL, undefined, { signal });
        if (!signal.aborted) setState({ status: "ready", data, source: { kind: "url", label: `Graph URL: ${new URL(GRAPH_URL, window.location.href).host}` } });
      } catch (error) {
        if (signal.aborted || isAbort(error)) return;
        setState({ status: "error", message: errorMessage(error) });
      }
    };

    void (async () => {
      if (load.preferDefault) return showDefault();
      const kept = loadLocalGraph();
      let saved: SavedGraph | null = null;
      let held: Account = { status: "none" };
      let problem: Notice | null = null;
      if (readToken()) {
        try {
          saved = await getSavedGraph({ signal: withDeadline(signal, ACCOUNT_TIMEOUT_MS) });
          if (signal.aborted) return;
          setSession(true);
          if (saved) held = { status: "saved", info: { source: saved.source, updatedAt: saved.updatedAt, nodes: saved.nodes, links: saved.links } };
        } catch (error) {
          if (signal.aborted || isAbort(error)) return;
          const expired = error instanceof GraphStoreError && error.reason === "session";
          setSession(!expired);
          if (!expired) held = { status: "unknown" };
          problem = expired
            ? { tone: "error", message: errorMessage(error), link: { label: "Back to the shelf", href: "/" } }
            : { tone: "error", message: `Couldn’t load your account’s graph. ${errorMessage(error)}`, action: { label: "Retry", onClick: retry } };
        }
      } else {
        setSession(false);
      }

      const local = await kept;
      if (signal.aborted) return;
      setAccount(held);
      setNotice(problem);
      if (local && preferLocal(local, saved)) return setState(fromLocal(local));
      if (saved) {
        setState(fromAccount(saved));
        // An import that was never saved, older than what the account now holds: still reachable.
        if (local && !local.syncedAt && !problem) {
          setNotice({
            tone: "info",
            message: `Your import “${nameOf(local.source)}” in this browser isn’t saved to your account. Showing the account’s graph, which is newer.`,
            action: { label: "Show the import", onClick: () => { setNotice(null); setSave({ status: "idle" }); setState(fromLocal(local)); } },
          });
        }
        return;
      }
      if (local) return setState(fromLocal(local));
      return showDefault();
    })();
    return () => controller.abort();
  }, [load]);

  const data = state.status === "ready" ? state.data : null;
  const source = state.status === "ready" ? state.source : null;

  // A note opens its meta.url, or in Obsidian when the vault's name is known: from
  // NEXT_PUBLIC_OBSIDIAN_VAULT, or from an imported Obsidian vault.
  const vault = OBSIDIAN_VAULT ?? (source && (source.kind === "local" || source.kind === "account") ? source.vault : undefined);
  const openNote = useMemo(() => {
    if (!data) return undefined;
    const byId = new Map(data.nodes.map((node) => [String(node.id), node]));
    const linkable = data.nodes.some((node) => safeUrl(node.meta?.url) !== null);
    if (!vault && !linkable) return undefined;
    return (id: string) => {
      const node = byId.get(id);
      if (!node) return;
      const url = safeUrl(node.meta?.url);
      if (url) window.open(url, "_blank", "noopener,noreferrer");
      else if (vault) window.location.href = obsidianUri(vault, node);
    };
  }, [data, vault]);

  const info = useMemo<SourceInfo | null>(() => {
    if (!data || !source) return null;
    const unresolved = data.nodes.reduce((n, node) => n + (node.unresolved ? 1 : 0), 0);
    return { kind: source.kind, label: labelOf(source), notes: countNotes(data), unresolved, links: data.links.length, at: "at" in source ? source.at : undefined };
  }, [data, source]);

  const onImported = (result: ImportedGraph) => {
    setImporting(false);
    const label = sourceLabel(result.source);
    const at = new Date().toISOString();
    // Already storable: the dialog previews exactly what is kept and saved (every link end a note,
    // fields cut to the account's limits), so it isn't normalised again.
    const record: LocalGraph = { graph: result.graph, source: label, savedAt: at, ...(result.vault && { vault: result.vault }) };
    setState(fromLocal(record));
    setSave({ status: "idle" });
    setNotice(null);
    void saveLocalGraph(record).then((stored) => {
      if (stored) return;
      setNotice({
        tone: "info",
        message: `This browser isn’t keeping imports (storage is off or full), so the graph is gone after a reload.${session ? " Save it to your account to keep it." : ""}`,
      });
    });
  };

  const saveToAccount = async (confirmed = false) => {
    if (saving.current || state.status !== "ready" || state.source.kind !== "local") return;
    if (account.status === "unknown" && !confirmed) {
      setNotice({
        tone: "info",
        message: "Your account couldn’t be checked when this page loaded. Saving replaces any graph already saved there.",
        action: { label: "Save anyway", onClick: () => void saveToAccount(true) },
      });
      return;
    }
    const { data: shown, source: from } = state;
    const stillShown = () => stateRef.current.status === "ready" && stateRef.current.data === shown;
    saving.current = true;
    setSave({ status: "saving" });
    setNotice(null);
    try {
      const result = await saveGraph(shown, from.label);
      setAccount({ status: "saved", info: result });
      void markLocalGraphSynced(from.at, result.updatedAt);
      if (!stillShown()) {
        // Another graph was imported meanwhile: that one isn't saved, so say nothing about it.
        setSave({ status: "idle" });
        return;
      }
      setState((current) =>
        current.status === "ready" && current.data === shown
          ? { ...current, source: { kind: "account", label: result.source, at: result.updatedAt, vault: from.vault } }
          : current,
      );
      setSave({ status: "saved" });
      window.setTimeout(() => setSave((current) => (current.status === "saved" ? { status: "idle" } : current)), 2500);
    } catch (error) {
      const expired = error instanceof GraphStoreError && error.reason === "session";
      if (expired) setSession(false);
      if (!stillShown() && !expired) {
        setSave({ status: "idle" });
        return;
      }
      setSave({ status: "error", message: errorMessage(error) });
      setNotice({
        tone: "error",
        message: expired ? errorMessage(error) : `Couldn’t save to your account: ${errorMessage(error)}`,
        link: expired ? { label: "Back to the shelf", href: "/" } : undefined,
      });
    } finally {
      saving.current = false;
    }
  };

  const resetToSample = () => {
    // The account's graph comes back next visit, whether it is on screen or hidden behind an import.
    const accountGraph = source?.kind === "account" || (session && account.status === "saved");
    setSave({ status: "idle" });
    setNotice(
      accountGraph
        ? {
            tone: "info",
            message: `Showing the ${GRAPH_URL ? "default graph" : "sample"}. The graph saved to your account loads again next time; remove it from the menu to stop that.`,
          }
        : null,
    );
    void clearLocalGraph();
    if (GRAPH_URL) {
      setState({ status: "loading" });
      setLoad((current) => ({ attempt: current.attempt + 1, preferDefault: true }));
    } else {
      setState(SAMPLE);
    }
  };

  const removeFromAccount = async () => {
    setNotice(null);
    try {
      await deleteSavedGraph();
      setAccount({ status: "none" });
      // A "Saved to account" tick from a save just before would now be wrong.
      setSave((current) => (current.status === "saved" ? { status: "idle" } : current));
      // What is on screen now, not when the menu was used: an import may have replaced it meanwhile.
      const current = stateRef.current;
      if (current.status === "ready" && current.source.kind === "account") {
        const { data: shown, source: from } = current;
        // Still on screen, now only in this browser: keep it here so a reload shows it again.
        const record: LocalGraph = { graph: shown, source: from.label, savedAt: new Date().toISOString(), ...(from.vault && { vault: from.vault }) };
        setState((latest) => (latest.status === "ready" && latest.data === shown ? fromLocal(record) : latest));
        void saveLocalGraph(record);
        setNotice({ tone: "info", message: "Removed from your account. It stays in this browser until you reset or import another graph." });
      } else {
        setNotice({ tone: "info", message: "Removed the saved graph from your account." });
      }
    } catch (error) {
      const expired = error instanceof GraphStoreError && error.reason === "session";
      if (expired) setSession(false);
      setNotice({ tone: "error", message: errorMessage(error), link: expired ? { label: "Back to the shelf", href: "/" } : undefined });
    }
  };

  if (state.status === "loading") return <Loading />;

  if (state.status === "error") {
    return (
      <Centered>
        <div role="alert" className="w-full max-w-md rounded-[12px] border border-[#2a2a30] bg-[#1e1e22] p-5 shadow-[0_12px_40px_rgba(0,0,0,0.45)]">
          <h2 className="text-[13px] font-semibold text-[#ededf0]">Couldn’t load the graph</h2>
          <p className="mt-2 break-words text-[12px] text-[#a1a1aa]" style={{ fontFamily: "var(--font-geist-mono), ui-monospace, monospace" }}>
            {state.message}
          </p>
          <div className="mt-4 flex gap-2">
            <button
              type="button"
              onClick={() => {
                setState({ status: "loading" });
                setLoad((current) => ({ ...current, attempt: current.attempt + 1 }));
              }}
              className="h-8 rounded-[6px] bg-[#9d8cff] px-3 text-[13px] font-medium text-[#111113] hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#9d8cff]"
            >
              Try again
            </button>
            <button
              type="button"
              onClick={() => setState(SAMPLE)}
              className="h-8 rounded-[6px] border border-[#2a2a30] px-3 text-[13px] text-[#ededf0] hover:bg-[#26262b] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#9d8cff]"
            >
              Show the sample vault
            </button>
          </div>
        </div>
      </Centered>
    );
  }

  const sample = state.source.kind === "sample";
  return (
    <>
      <GraphView
        data={state.data}
        title={sample ? "System Design" : nameOf(labelOf(state.source)) || "Knowledge graph"}
        initialSelectedId={sample ? "caching" : undefined}
        onOpenNote={openNote}
        sidebarHeader={info && <SourceHeader source={info} />}
        toolbar={
          info && (
            <SourceToolbar
              source={info}
              canSave={session && state.source.kind === "local"}
              save={save}
              savedToAccount={session && account.status !== "none"}
              resetLabel={GRAPH_URL ? "Reset to default graph" : "Reset to sample"}
              notice={notice}
              onImport={() => setImporting(true)}
              onSave={() => void saveToAccount()}
              onReset={resetToSample}
              onRemove={() => void removeFromAccount()}
              onDismissNotice={() => setNotice(null)}
            />
          )
        }
      />
      {importing && <ImportDialog onClose={() => setImporting(false)} onImport={onImported} />}
    </>
  );
}
