"use client";

import { memo, useMemo, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import type { GraphInsights } from "@/lib/graph/insights";
import { countNotes, type NormalizedGraph } from "@/lib/graph/normalize";
import type { GraphNode } from "@/lib/graph/types";
import styles from "./graph-view.module.css";
import type { GroupRow } from "./settings-panel";
import { Dot, Icon, Section, focusRing, type IconName } from "./ui";

const PAGE = 50;

function Row({
  children,
  meta,
  selected,
  title,
  onClick,
}: {
  children: ReactNode;
  meta?: ReactNode;
  selected?: boolean;
  title?: string;
  onClick: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        title={title}
        aria-current={selected ? "true" : undefined}
        onClick={onClick}
        className={cn(
          "flex h-7 w-full items-center gap-2 rounded-[8px] px-2 text-left text-[13px] transition-colors duration-150 hover:bg-(--g-hover) hover:text-(--g-text)",
          selected ? "bg-(--g-hover) text-(--g-text)" : "text-(--g-text-2)",
          focusRing,
        )}
      >
        {children}
        {meta !== undefined && <span className={cn(styles.mono, "ml-auto shrink-0 pl-2 text-[12px] text-(--g-text-3)")}>{meta}</span>}
      </button>
    </li>
  );
}

function Insight({ icon, title, count, children }: { icon: IconName; title: string; count?: number; children: ReactNode }) {
  return (
    <div className="mt-2 first:mt-0">
      <div className="flex h-7 items-center gap-2 px-2 text-[12px] text-(--g-text-3)">
        <Icon name={icon} size={14} />
        <span className="flex-1">{title}</span>
        {count !== undefined && <span className={styles.mono}>{count}</span>}
      </div>
      <ul className="space-y-px">{children}</ul>
    </div>
  );
}

function GroupList({
  group,
  notes,
  degreeOf,
  selectedId,
  onPick,
}: {
  group: GroupRow;
  notes: GraphNode[];
  degreeOf: (id: string) => number;
  selectedId: string | null;
  onPick: (id: string) => void;
}) {
  const [open, setOpen] = useState(true);
  const [limit, setLimit] = useState(PAGE);
  return (
    <li>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className={cn("flex h-7 w-full items-center gap-2 rounded-[8px] px-2 text-left text-[12px] text-(--g-text-3) hover:text-(--g-text)", focusRing)}
      >
        <Icon name="chevron" size={14} className={cn("transition-transform duration-150", open && "rotate-90")} />
        <Dot color={group.color} hollow={group.hollow} />
        <span className="min-w-0 flex-1 truncate">{group.label}</span>
        <span className={styles.mono}>{group.count}</span>
      </button>
      {open && (
        <ul className="space-y-px pl-3">
          {notes.slice(0, limit).map((node) => (
            <Row key={node.id} selected={node.id === selectedId} meta={degreeOf(node.id)} onClick={() => onPick(node.id)}>
              <span className="min-w-0 truncate">{node.label}</span>
            </Row>
          ))}
          {notes.length > limit && (
            <li>
              <button type="button" onClick={() => setLimit(notes.length)} className={cn("h-7 rounded-[8px] px-2 text-[12px] text-(--g-accent-text) hover:underline", focusRing)}>
                Show {notes.length - limit} more
              </button>
            </li>
          )}
        </ul>
      )}
    </li>
  );
}

/** Vault overview: housekeeping insights first, then every note grouped with its link count. */
export const GraphSidebar = memo(function GraphSidebar({
  title,
  header,
  graph,
  insights,
  groups,
  colors,
  selectedId,
  onPick,
  onShowCluster,
}: {
  title: string;
  /** Rendered above the title, e.g. a back link. */
  header?: ReactNode;
  graph: NormalizedGraph;
  insights: GraphInsights;
  groups: readonly GroupRow[];
  colors: Record<string, string>;
  selectedId: string | null;
  onPick: (id: string) => void;
  onShowCluster: (ids: string[]) => void;
}) {
  const degreeOf = (id: string) => graph.degree[graph.indexOf.get(id) ?? -1] ?? 0;
  const color = (node: GraphNode) => colors[node.group ?? ""];
  const byGroup = useMemo(() => {
    const map = new Map<string, GraphNode[]>();
    graph.nodes.forEach((node) => {
      const list = map.get(node.group!);
      if (list) list.push(node);
      else map.set(node.group!, [node]);
    });
    const degree = (node: GraphNode) => graph.degree[graph.indexOf.get(node.id)!];
    for (const notes of map.values()) notes.sort((a, b) => degree(b) - degree(a) || a.label.localeCompare(b.label));
    return map;
  }, [graph]);
  const counts = useMemo(() => {
    const notes = countNotes(graph);
    let placeholders = 0;
    for (const node of graph.nodes) if (node.unresolved) placeholders++;
    return { notes, unresolved: placeholders };
  }, [graph]);
  const { duplicates, unresolved, clusters, orphans, hubs } = insights;

  return (
    <aside aria-label="Vault" className="flex w-[264px] shrink-0 flex-col border-r border-(--g-border) bg-(--g-chrome) max-md:hidden">
      <header className="px-4 pb-3 pt-4">
        {header}
        <h2 className="truncate text-[13px] font-semibold text-(--g-text)">{title}</h2>
        <p className={cn(styles.mono, "mt-0.5 text-[12px] text-(--g-text-3)")}>
          {/* Same split as the source menu: placeholders for unresolved links aren't notes. */}
          <span className="whitespace-nowrap">{counts.notes.toLocaleString("en-US")} notes · {graph.links.length.toLocaleString("en-US")} links</span>
          {/* The space sits between the spans so "· N unresolved" wraps as a whole on a narrow sidebar. */}
          {counts.unresolved > 0 && <> <span className="whitespace-nowrap">· {counts.unresolved.toLocaleString("en-US")} unresolved</span></>}
        </p>
      </header>
      <div className={cn(styles.scroll, "min-h-0 flex-1 overflow-y-auto pb-4")}>
        <Section title="Insights">
          {duplicates.length > 0 && (
            <Insight icon="duplicate" title="Likely duplicates" count={duplicates.length}>
              {duplicates.slice(0, 8).map(({ a, b, distance }) => (
                <Row
                  key={`${a.id}|${b.id}`}
                  title={`“${a.label}” looks like “${b.label}” (${distance === 0 ? "same name" : `${distance} ${distance === 1 ? "edit" : "edits"} apart`})`}
                  selected={a.id === selectedId}
                  onClick={() => onPick(a.id)}
                >
                  <Dot color={color(a)} />
                  <span className="min-w-0 truncate">{a.label}</span>
                  <Icon name="outgoing" size={12} className="text-(--g-text-3)" />
                  <span className="min-w-0 truncate text-(--g-text-3)">{b.label}</span>
                </Row>
              ))}
            </Insight>
          )}
          {unresolved.length > 0 && (
            <Insight icon="unresolved" title="Unresolved links" count={unresolved.length}>
              {unresolved.slice(0, 8).map(({ node, referencedBy }) => (
                <Row key={node.id} selected={node.id === selectedId} meta={`${referencedBy} in`} title={`${referencedBy} notes link to “${node.label}”, which has no note yet`} onClick={() => onPick(node.id)}>
                  <Dot color={color(node)} hollow />
                  <span className="min-w-0 truncate">{node.label}</span>
                </Row>
              ))}
            </Insight>
          )}
          {clusters.length + orphans.length > 0 && (
            <Insight icon="islands" title="Disconnected clusters" count={clusters.length + orphans.length}>
              {clusters.slice(0, 8).map((members) => (
                <Row key={members[0].id} meta={`${members.length} notes`} title={members.map((m) => m.label).join(", ")} onClick={() => onShowCluster(members.map((m) => m.id))}>
                  <Dot color={color(members[0])} />
                  <span className="min-w-0 truncate">
                    {members[0].label} <span className="text-(--g-text-3)">+ {members.length - 1}</span>
                  </span>
                </Row>
              ))}
              {orphans.slice(0, 8).map((node) => (
                <Row key={node.id} meta="orphan" selected={node.id === selectedId} onClick={() => onPick(node.id)}>
                  <Dot color={color(node)} />
                  <span className="min-w-0 truncate">{node.label}</span>
                </Row>
              ))}
            </Insight>
          )}
          {hubs.length > 0 && (
            <Insight icon="hub" title="Most connected">
              {hubs.map(({ node, degree }) => (
                <Row key={node.id} meta={degree} selected={node.id === selectedId} onClick={() => onPick(node.id)}>
                  <Dot color={color(node)} />
                  <span className="min-w-0 truncate">{node.label}</span>
                </Row>
              ))}
            </Insight>
          )}
        </Section>
        <Section title="Notes">
          <ul className="space-y-0.5">
            {groups.map((group) => (
              <GroupList key={group.key} group={group} notes={byGroup.get(group.key) ?? []} degreeOf={degreeOf} selectedId={selectedId} onPick={onPick} />
            ))}
          </ul>
        </Section>
      </div>
    </aside>
  );
});
