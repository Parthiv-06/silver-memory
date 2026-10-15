import type { GraphGroupStyle } from "./types";

/** Design tokens shared by the canvas renderer and the surrounding UI. */
export const THEME = {
  bg: "#111113",
  chrome: "#18181b",
  panel: "#1e1e22",
  hover: "#26262b",
  border: "#2a2a30",
  glass: "rgba(24,24,27,0.86)",
  text: "#ededf0",
  text2: "#a1a1aa",
  // 4.6:1 on the hover/selected row colour, not just on the background.
  text3: "#8e8e97",
  accent: "#9d8cff",
  accentText: "#b8abff",
  accentSoft: "rgba(157,140,255,0.08)",
  accentBorder: "rgba(157,140,255,0.4)",
  borderStrong: "#3a3a42",
  // Menus and notices over the canvas, where the usual glass would let labels show through.
  glassSolid: "rgba(24,24,27,0.97)",
  danger: "#ff9580",
  dangerSoft: "rgba(255,149,128,0.08)",
  dangerBorder: "rgba(255,149,128,0.35)",
  warn: "#e6d36a",
  grid: "rgba(255,255,255,0.045)",
  label: "#c9c9cf",
  neutralNode: "#a1a1aa",
  unresolvedStroke: "#6b6b75",
  unresolvedLabel: "#8b8b94",
} as const;

export const UNRESOLVED_GROUP = "unresolved";
export const UNGROUPED = "ungrouped";

/** Colours for the groups the sample vault uses; distinct in lightness as well as hue. */
export const GROUP_COLORS: Readonly<Record<string, string>> = {
  hub: "#b4a2ff",
  concept: "#6cb6ff",
  infra: "#f0a35e",
  data: "#4fd1b5",
  pattern: "#f07fb0",
  case: "#e6d36a",
  misc: "#8b8b95",
  [UNGROUPED]: "#8b8b95",
  [UNRESOLVED_GROUP]: THEME.unresolvedStroke,
};

// Handed out, in order, to groups the palette above doesn't know.
const SPARE_COLORS = ["#6cb6ff", "#f0a35e", "#4fd1b5", "#f07fb0", "#e6d36a", "#b4a2ff", "#86d676", "#ff9580", "#62cfe6", "#d79cf0"];

const DEFAULT_LABELS: Readonly<Record<string, string>> = {
  [UNRESOLVED_GROUP]: "Unresolved",
  [UNGROUPED]: "Ungrouped",
};

// Same answer on the server and in the browser (so no hydration mismatch); the canvas also checks
// with CSS.supports and falls back to neutral for anything that slips through.
const COLOR_SYNTAX = /^(#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})|(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\([^()]*\)|[a-z]+)$/i;

/** Whether `value` is plausibly a CSS colour; "not-a-colour" and "" are not. */
export function looksLikeColor(value: string): boolean {
  return COLOR_SYNTAX.test(value.trim());
}

// Group keys come from data, so "constructor" or "__proto__" must not reach Object.prototype.
function own<T>(record: Readonly<Record<string, T>> | undefined, key: string): T | undefined {
  return record && Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

/** Assigns every group a colour: explicit style first, then the known palette, then spare colours. */
export function groupColors(groups: readonly string[], styles?: Record<string, GraphGroupStyle>): Record<string, string> {
  const out = Object.create(null) as Record<string, string>;
  let spare = 0;
  for (const group of groups) {
    const styled = own(styles, group)?.color;
    const color = (typeof styled === "string" && looksLikeColor(styled) && styled.trim()) || own(GROUP_COLORS, group);
    out[group] = color ?? SPARE_COLORS[spare++ % SPARE_COLORS.length];
  }
  return out;
}

export function groupLabel(group: string, styles?: Record<string, GraphGroupStyle>): string {
  const styled = own(styles, group)?.label;
  const label = (typeof styled === "string" && styled) || own(DEFAULT_LABELS, group);
  if (label) return label;
  return group.charAt(0).toUpperCase() + group.slice(1);
}

/** The tokens as CSS custom properties, so CSS and canvas read one source. */
export const THEME_VARS = {
  "--g-bg": THEME.bg,
  "--g-chrome": THEME.chrome,
  "--g-panel": THEME.panel,
  "--g-hover": THEME.hover,
  "--g-border": THEME.border,
  "--g-glass": THEME.glass,
  "--g-text": THEME.text,
  "--g-text-2": THEME.text2,
  "--g-text-3": THEME.text3,
  "--g-accent": THEME.accent,
  "--g-accent-text": THEME.accentText,
  "--g-accent-soft": THEME.accentSoft,
  "--g-accent-border": THEME.accentBorder,
  "--g-border-strong": THEME.borderStrong,
  "--g-glass-solid": THEME.glassSolid,
  "--g-danger": THEME.danger,
  "--g-danger-soft": THEME.dangerSoft,
  "--g-danger-border": THEME.dangerBorder,
  "--g-warn": THEME.warn,
} as const;
