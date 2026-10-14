/** A note in the graph. `id` is the stable key links point at; `label` is what people read. */
export interface GraphNode {
  id: string;
  label: string;
  group?: string;
  tags?: string[];
  /** A link target with no note behind it yet (Obsidian's "unresolved link"). */
  unresolved?: boolean;
  meta?: Record<string, unknown>;
}

/** A directed link, e.g. a [[wikilink]] from `source` to `target`. */
export interface GraphLink {
  source: string;
  target: string;
  weight?: number;
}

/** Optional per-group display hints carried with the data. */
export interface GraphGroupStyle {
  label?: string;
  color?: string;
}

export interface GraphData {
  nodes: GraphNode[];
  links: GraphLink[];
  groups?: Record<string, GraphGroupStyle>;
}

export interface FilterSettings {
  /** Only show notes whose label contains this text. */
  search: string;
  showOrphans: boolean;
  showUnresolved: boolean;
}

export interface GroupSettings {
  colorGroups: boolean;
  /** Group keys that are hidden from the graph. */
  hidden: string[];
}

export interface DisplaySettings {
  arrows: boolean;
  /** Zoom level at which labels start fading in (fully shown 0.3 later). */
  textFadeThreshold: number;
  nodeSize: number;
  linkThickness: number;
  minimap: boolean;
}

export interface ForceSettings {
  centerForce: number;
  repelForce: number;
  linkForce: number;
  linkDistance: number;
  collision: boolean;
}

export interface GraphSettings {
  filters: FilterSettings;
  groups: GroupSettings;
  display: DisplaySettings;
  forces: ForceSettings;
}

export type PartialSettings = { [K in keyof GraphSettings]?: Partial<GraphSettings[K]> };

export const DEFAULT_SETTINGS: GraphSettings = {
  filters: { search: "", showOrphans: true, showUnresolved: true },
  groups: { colorGroups: true, hidden: [] },
  display: { arrows: false, textFadeThreshold: 0.7, nodeSize: 1, linkThickness: 1, minimap: true },
  forces: { centerForce: 0.5, repelForce: 10, linkForce: 0.6, linkDistance: 60, collision: true },
};

/** Fills the gaps in partial settings from the defaults. */
export function resolveSettings(partial?: PartialSettings): GraphSettings {
  return {
    filters: { ...DEFAULT_SETTINGS.filters, ...partial?.filters },
    groups: { ...DEFAULT_SETTINGS.groups, ...partial?.groups },
    display: { ...DEFAULT_SETTINGS.display, ...partial?.display },
    forces: { ...DEFAULT_SETTINGS.forces, ...partial?.forces },
  };
}
