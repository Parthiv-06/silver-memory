"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { GraphView } from "@/components/graph/graph-view";
import { fetchGraph } from "@/lib/graph/adapters";
import { sampleGraph } from "@/lib/graph/sample-data";
import type { GraphData, GraphNode } from "@/lib/graph/types";

const GRAPH_URL = process.env.NEXT_PUBLIC_GRAPH_URL;
const OBSIDIAN_VAULT = process.env.NEXT_PUBLIC_OBSIDIAN_VAULT;

type State =
  | { status: "ready"; data: GraphData; sample: boolean }
  | { status: "loading" }
  | { status: "error"; message: string };

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

function Centered({ children }: { children: ReactNode }) {
  return (
    <div className="grid h-full place-items-center px-4 text-[13px]" style={{ fontFamily: "var(--font-geist), ui-sans-serif, system-ui, sans-serif" }}>
      {children}
    </div>
  );
}

/** The sample vault, or the JSON at NEXT_PUBLIC_GRAPH_URL when that is set. */
export function GraphRoute() {
  const [state, setState] = useState<State>(() => (GRAPH_URL ? { status: "loading" } : { status: "ready", data: sampleGraph, sample: true }));
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!GRAPH_URL) return;
    const controller = new AbortController();
    fetchGraph(GRAPH_URL, undefined, { signal: controller.signal }).then(
      (data) => setState({ status: "ready", data, sample: false }),
      (error: unknown) => {
        if (controller.signal.aborted) return;
        setState({ status: "error", message: error instanceof Error ? error.message : String(error) });
      },
    );
    return () => controller.abort();
  }, [attempt]);

  const openNote = useMemo(() => {
    if (state.status !== "ready") return undefined;
    const byId = new Map(state.data.nodes.map((node) => [String(node.id), node]));
    const linkable = state.data.nodes.some((node) => safeUrl(node.meta?.url) !== null);
    if (!OBSIDIAN_VAULT && !linkable) return undefined;
    return (id: string) => {
      const node = byId.get(id);
      if (!node) return;
      const url = safeUrl(node.meta?.url);
      if (url) window.open(url, "_blank", "noopener,noreferrer");
      else if (OBSIDIAN_VAULT) window.location.href = obsidianUri(OBSIDIAN_VAULT, node);
    };
  }, [state]);

  if (state.status === "loading") {
    return (
      <Centered>
        <p role="status" className="flex items-center gap-2 text-[#a1a1aa]">
          <span aria-hidden="true" className="size-1.5 animate-pulse rounded-full bg-[#9d8cff]" />
          Loading graph…
        </p>
      </Centered>
    );
  }

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
                setAttempt((n) => n + 1);
              }}
              className="h-8 rounded-[6px] bg-[#9d8cff] px-3 text-[13px] font-medium text-[#111113] hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#9d8cff]"
            >
              Try again
            </button>
            <button
              type="button"
              onClick={() => setState({ status: "ready", data: sampleGraph, sample: true })}
              className="h-8 rounded-[6px] border border-[#2a2a30] px-3 text-[13px] text-[#ededf0] hover:bg-[#26262b] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#9d8cff]"
            >
              Show the sample vault
            </button>
          </div>
        </div>
      </Centered>
    );
  }

  return (
    <GraphView
      data={state.data}
      title={state.sample ? "System Design" : "Knowledge graph"}
      initialSelectedId={state.sample ? "caching" : undefined}
      onOpenNote={openNote}
    />
  );
}
