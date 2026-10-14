"use client";

import { cn } from "@/lib/utils";
import type { GraphNode } from "@/lib/graph/types";
import styles from "./graph-view.module.css";
import { Dot, Icon, IconButton, Section, Switch, focusRing } from "./ui";

export interface LinkedNote {
  node: GraphNode;
  degree: number;
}

function LinkList({ notes, colors, onPick }: { notes: readonly LinkedNote[]; colors: Record<string, string>; onPick: (id: string) => void }) {
  if (notes.length === 0) return <p className="px-2 text-[12px] text-(--g-text-3)">None yet.</p>;
  return (
    <ul className={cn(styles.scroll, "max-h-[180px] space-y-px overflow-y-auto")}>
      {notes.map(({ node, degree }) => (
        <li key={node.id}>
          <button
            type="button"
            onClick={() => onPick(node.id)}
            className={cn("flex h-7 w-full items-center gap-2 rounded-[8px] px-2 text-left text-[13px] text-(--g-text-2) transition-colors duration-150 hover:bg-(--g-hover) hover:text-(--g-text)", focusRing)}
          >
            <Dot color={colors[node.group ?? ""]} hollow={node.unresolved} />
            <span className="min-w-0 flex-1 truncate">{node.label}</span>
            <span className={cn(styles.mono, "text-[12px] text-(--g-text-3)")}>{degree}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/** Details for the selected note: links in and out, duplicate hints, open and local-graph controls. */
export function NotePanel({
  node,
  groupLabel,
  colors,
  degree,
  outgoing,
  incoming,
  duplicateOf,
  local,
  depth,
  onLocalChange,
  onDepthChange,
  onPick,
  onFly,
  onOpen,
  onClose,
  className,
}: {
  node: GraphNode;
  groupLabel: string;
  colors: Record<string, string>;
  degree: number;
  outgoing: readonly LinkedNote[];
  incoming: readonly LinkedNote[];
  duplicateOf?: GraphNode;
  local: boolean;
  depth: number;
  onLocalChange: (local: boolean) => void;
  onDepthChange: (depth: number) => void;
  onPick: (id: string) => void;
  onFly: () => void;
  onOpen?: () => void;
  onClose: () => void;
  className?: string;
}) {
  return (
    <aside
      aria-label={`Note: ${node.label}`}
      className={cn(styles.glass, "flex w-[296px] max-w-[calc(100vw-24px)] flex-col overflow-hidden", className)}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || event.defaultPrevented) return;
        event.preventDefault();
        onClose();
      }}
    >
      <div className="flex items-start gap-1 px-4 pb-3 pr-1.5 pt-3">
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-2 text-[12px] text-(--g-text-3)">
            <Dot color={colors[node.group ?? ""]} hollow={node.unresolved} />
            {groupLabel}
          </p>
          <h2 className="mt-1 text-[15px] font-semibold leading-snug text-(--g-text)">{node.label}</h2>
          <p className={cn(styles.mono, "mt-1 text-[12px] text-(--g-text-3)")}>
            {degree} {degree === 1 ? "link" : "links"} · {incoming.length} in · {outgoing.length} out
          </p>
        </div>
        <IconButton icon="close" label="Close note details" onClick={onClose} />
      </div>

      {(node.unresolved || duplicateOf) && (
        <div className="space-y-2 px-4 pb-3">
          {node.unresolved && (
            <p className="rounded-[8px] border border-dashed border-(--g-border) px-3 py-2 text-[12px] text-(--g-text-2)">
              No note yet. {incoming.length} {incoming.length === 1 ? "note links" : "notes link"} here.
            </p>
          )}
          {duplicateOf && (
            <button
              type="button"
              onClick={() => onPick(duplicateOf.id)}
              className={cn("flex w-full items-center gap-2 rounded-[8px] border border-(--g-border) bg-(--g-panel) px-3 py-2 text-left text-[12px] text-(--g-text-2) transition-colors duration-150 hover:bg-(--g-hover)", focusRing)}
            >
              <Icon name="duplicate" size={14} className="text-(--g-accent-text)" />
              <span className="min-w-0 flex-1">
                Possible duplicate of <span className="text-(--g-text)">{duplicateOf.label}</span>
              </span>
            </button>
          )}
        </div>
      )}

      <div className="flex gap-2 px-4 pb-3">
        {onOpen && (
          <button
            type="button"
            onClick={onOpen}
            className={cn("flex h-8 flex-1 items-center justify-center gap-2 rounded-[6px] bg-(--g-accent) text-[13px] font-medium text-(--g-bg) transition-[filter] duration-150 hover:brightness-110", focusRing)}
          >
            <Icon name="open" size={14} />
            {node.unresolved ? "Create note" : "Open note"}
          </button>
        )}
        <button
          type="button"
          onClick={onFly}
          className={cn("flex h-8 items-center justify-center gap-2 rounded-[6px] border border-(--g-border) bg-(--g-panel) px-3 text-[13px] text-(--g-text) transition-colors duration-150 hover:bg-(--g-hover)", !onOpen && "flex-1", focusRing)}
        >
          <Icon name="target" size={14} />
          Fly to
        </button>
      </div>

      <div className="flex items-center gap-3 border-t border-(--g-border) px-4 py-2">
        <div className="flex-1">
          <Switch
            label={
              <span className="flex items-center gap-2">
                <Icon name="local" size={14} className="text-(--g-text-3)" />
                Local graph
              </span>
            }
            checked={local}
            onChange={onLocalChange}
          />
        </div>
        <div role="group" aria-label="Local graph depth" className="flex rounded-[6px] border border-(--g-border) p-0.5">
          {[1, 2, 3].map((d) => (
            <button
              key={d}
              type="button"
              aria-pressed={depth === d}
              aria-label={`Depth ${d}`}
              title={`${d} ${d === 1 ? "hop" : "hops"} from this note`}
              onClick={() => {
                onDepthChange(d);
                if (!local) onLocalChange(true);
              }}
              className={cn(
                styles.mono,
                "h-6 w-7 rounded-[4px] text-[12px] transition-colors duration-150",
                depth === d && local ? "bg-(--g-accent) text-(--g-bg)" : depth === d ? "bg-(--g-hover) text-(--g-text)" : "text-(--g-text-3) hover:text-(--g-text)",
                focusRing,
              )}
            >
              {d}
            </button>
          ))}
        </div>
      </div>

      <div className={cn(styles.scroll, "min-h-0 overflow-y-auto border-t border-(--g-border) py-1")}>
        <Section title={<span className="flex items-center gap-2"><Icon name="outgoing" size={14} />Outgoing links <span className={styles.mono}>{outgoing.length}</span></span>}>
          <LinkList notes={outgoing} colors={colors} onPick={onPick} />
        </Section>
        <Section title={<span className="flex items-center gap-2"><Icon name="backlink" size={14} />Backlinks <span className={styles.mono}>{incoming.length}</span></span>}>
          <LinkList notes={incoming} colors={colors} onPick={onPick} />
        </Section>
      </div>
    </aside>
  );
}
