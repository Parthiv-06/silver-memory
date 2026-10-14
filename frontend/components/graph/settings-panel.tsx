"use client";

import { memo } from "react";
import { cn } from "@/lib/utils";
import { THEME } from "@/lib/graph/theme";
import type { GraphSettings } from "@/lib/graph/types";
import styles from "./graph-view.module.css";
import { Dot, Icon, IconButton, Section, Slider, Switch, focusRing } from "./ui";

export interface GroupRow {
  key: string;
  label: string;
  color: string;
  count: number;
  hollow: boolean;
}

export type SettingsChange = <K extends keyof GraphSettings>(section: K, patch: Partial<GraphSettings[K]>) => void;

const times = (v: number) => `${v.toFixed(2)}×`;

export const SettingsPanel = memo(function SettingsPanel({
  settings,
  groups,
  onChange,
  onReset,
  onRerun,
  onClose,
  className,
}: {
  settings: GraphSettings;
  groups: readonly GroupRow[];
  onChange: SettingsChange;
  onReset: () => void;
  onRerun: () => void;
  onClose: () => void;
  className?: string;
}) {
  const { filters, display, forces } = settings;
  const hidden = new Set(settings.groups.hidden);
  const toggleGroup = (key: string) =>
    onChange("groups", { hidden: hidden.has(key) ? settings.groups.hidden.filter((g) => g !== key) : [...settings.groups.hidden, key] });

  return (
    <aside
      aria-label="Graph settings"
      className={cn(styles.glass, "flex w-[288px] max-w-[calc(100vw-24px)] flex-col overflow-hidden", className)}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || event.defaultPrevented) return;
        // Esc in a non-empty filter field clears it (the browser default) rather than closing.
        if (event.target instanceof HTMLInputElement && event.target.type === "search" && event.target.value) return;
        event.preventDefault();
        onClose();
      }}
    >
      <header className="flex h-11 shrink-0 items-center gap-0.5 border-b border-(--g-border) pl-3 pr-1.5">
        <h2 className="flex-1 text-[13px] font-medium text-(--g-text)">Graph settings</h2>
        <IconButton icon="reset" label="Reset settings" onClick={onReset} />
        <IconButton icon="close" label="Close settings" onClick={onClose} />
      </header>
      <div className={cn(styles.scroll, "min-h-0 flex-1 overflow-y-auto py-1")}>
        <Section title="Filters">
          <div className="relative mb-1">
            <Icon name="search" size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-(--g-text-3)" />
            <input
              type="search"
              aria-label="Show only notes whose name contains"
              placeholder="Filter by name"
              value={filters.search}
              onChange={(event) => onChange("filters", { search: event.target.value })}
              className="h-8 w-full rounded-[6px] border border-(--g-border) bg-(--g-panel) pl-8 pr-2 text-[13px] text-(--g-text) outline-none transition-colors duration-150 placeholder:text-(--g-text-3) focus:border-(--g-accent)"
            />
          </div>
          <Switch label="Orphans" checked={filters.showOrphans} onChange={(showOrphans) => onChange("filters", { showOrphans })} />
          <Switch label="Unresolved links" checked={filters.showUnresolved} onChange={(showUnresolved) => onChange("filters", { showUnresolved })} />
        </Section>

        <Section title="Groups">
          <Switch label="Color groups" checked={settings.groups.colorGroups} onChange={(colorGroups) => onChange("groups", { colorGroups })} />
          <ul className="mt-1 space-y-px">
            {groups.map((group) => {
              const off = hidden.has(group.key);
              return (
                <li key={group.key}>
                  <button
                    type="button"
                    aria-pressed={!off}
                    aria-label={`${group.label}, ${group.count} ${group.count === 1 ? "note" : "notes"}`}
                    title={off ? "Show group" : "Hide group"}
                    onClick={() => toggleGroup(group.key)}
                    className={cn("flex h-8 w-full items-center gap-2 rounded-[8px] px-2 text-left transition-colors duration-150 hover:bg-(--g-hover)", focusRing)}
                  >
                    <Dot color={settings.groups.colorGroups || group.hollow ? group.color : THEME.neutralNode} hollow={group.hollow} className={cn(off && "opacity-40")} />
                    <span className={cn("min-w-0 flex-1 truncate text-[13px]", off ? "text-(--g-text-3)" : "text-(--g-text)")}>{group.label}</span>
                    <span className={cn(styles.mono, "text-[12px] text-(--g-text-3)")}>{group.count}</span>
                    <Icon name={off ? "eyeOff" : "eye"} size={14} className="text-(--g-text-3)" />
                  </button>
                </li>
              );
            })}
          </ul>
        </Section>

        <Section title="Display">
          <Switch label="Arrows" checked={display.arrows} onChange={(arrows) => onChange("display", { arrows })} />
          <Switch label="Minimap" checked={display.minimap} onChange={(minimap) => onChange("display", { minimap })} />
          <Slider label="Text fade threshold" value={display.textFadeThreshold} min={0.2} max={2.5} step={0.05} format={times} onChange={(textFadeThreshold) => onChange("display", { textFadeThreshold })} />
          <Slider label="Node size" value={display.nodeSize} min={0.5} max={2.5} step={0.05} format={times} onChange={(nodeSize) => onChange("display", { nodeSize })} />
          <Slider label="Link thickness" value={display.linkThickness} min={0.5} max={3} step={0.1} format={times} onChange={(linkThickness) => onChange("display", { linkThickness })} />
          <button
            type="button"
            onClick={onRerun}
            className={cn("mt-2 flex h-8 w-full items-center justify-center gap-2 rounded-[6px] border border-(--g-border) bg-(--g-panel) text-[13px] text-(--g-text) transition-colors duration-150 hover:bg-(--g-hover)", focusRing)}
          >
            <Icon name="rerun" size={14} />
            Re-run layout
          </button>
        </Section>

        <Section title="Forces" defaultOpen={false}>
          <Slider label="Center force" value={forces.centerForce} min={0} max={1} step={0.01} onChange={(centerForce) => onChange("forces", { centerForce })} />
          <Slider label="Repel force" value={forces.repelForce} min={0} max={20} step={0.5} format={(v) => v.toFixed(1)} onChange={(repelForce) => onChange("forces", { repelForce })} />
          <Slider label="Link force" value={forces.linkForce} min={0} max={1} step={0.01} onChange={(linkForce) => onChange("forces", { linkForce })} />
          <Slider label="Link distance" value={forces.linkDistance} min={20} max={300} step={5} format={(v) => `${v.toFixed(0)}px`} onChange={(linkDistance) => onChange("forces", { linkDistance })} />
          <Switch label="Collision" checked={forces.collision} onChange={(collision) => onChange("forces", { collision })} />
        </Section>
      </div>
    </aside>
  );
});
