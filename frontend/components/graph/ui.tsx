"use client";

import { useId, useState, type CSSProperties, type ReactNode, type Ref } from "react";
import { cn } from "@/lib/utils";
import styles from "./graph-view.module.css";

// Tailwind v4's `outline-none` sets --tw-outline-style: none, which `outline-2` reuses, so the
// focus-visible style has to restore a solid outline explicitly.
export const focusRing =
  "outline-none focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--g-accent)";

const PATHS = {
  search: <><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></>,
  sliders: <><path d="M4 7h9M17 7h3M4 17h3M11 17h9" /><circle cx="15" cy="7" r="2" /><circle cx="9" cy="17" r="2" /></>,
  close: <path d="M18 6 6 18M6 6l12 12" />,
  chevron: <path d="m9 6 6 6-6 6" />,
  plus: <path d="M12 5v14M5 12h14" />,
  minus: <path d="M5 12h14" />,
  fit: <path d="M4 9V5a1 1 0 0 1 1-1h4M15 4h4a1 1 0 0 1 1 1v4M20 15v4a1 1 0 0 1-1 1h-4M9 20H5a1 1 0 0 1-1-1v-4" />,
  target: <><circle cx="12" cy="12" r="7" /><circle cx="12" cy="12" r="2" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3" /></>,
  open: <path d="M7 17 17 7M8 7h9v9" />,
  local: <><circle cx="6" cy="12" r="2.5" /><circle cx="18" cy="6" r="2.5" /><circle cx="18" cy="18" r="2.5" /><path d="m8.3 10.9 7.4-3.7M8.3 13.1l7.4 3.7" /></>,
  eye: <><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" /><circle cx="12" cy="12" r="2.8" /></>,
  eyeOff: <path d="m3 3 18 18M10.6 5.6A9 9 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a16 16 0 0 1-2.9 3.7M6.5 6.9A15.6 15.6 0 0 0 2.5 12S6 18.5 12 18.5a8.6 8.6 0 0 0 4.6-1.3M9.9 9.9a3 3 0 0 0 4.2 4.2" />,
  rerun: <path d="M20 12a8 8 0 1 1-2.4-5.7L20 8.7M20 4v4.7h-4.7" />,
  reset: <path d="M4 12a8 8 0 1 0 2.4-5.7L4 8.7M4 4v4.7h4.7" />,
  duplicate: <><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></>,
  unresolved: <><path d="M9 17H7A5 5 0 0 1 7 7h2M15 7h2a5 5 0 0 1 3.9 8.1" /><path d="M8 12h2M3 3l18 18" /></>,
  islands: <><circle cx="7.5" cy="8" r="3.5" /><circle cx="16.5" cy="16" r="3.5" /><circle cx="18" cy="6" r="1.5" /></>,
  hub: <><circle cx="12" cy="12" r="2.5" /><circle cx="5" cy="5" r="1.5" /><circle cx="19" cy="5" r="1.5" /><circle cx="5" cy="19" r="1.5" /><circle cx="19" cy="19" r="1.5" /><path d="m6.2 6.2 4 4M17.8 6.2l-4 4M6.2 17.8l4-4M17.8 17.8l-4-4" /></>,
  sidebar: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16" /></>,
  outgoing: <path d="M5 12h14M13 6l6 6-6 6" />,
  backlink: <path d="M19 12H5M11 6l-6 6 6 6" />,
  note: <><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /></>,
} as const;

export type IconName = keyof typeof PATHS;

/** Stroke icon drawn on a 24-unit grid; the stroke renders at 1.6 CSS px at any size. */
export function Icon({ name, className, size = 16 }: { name: IconName; className?: string; size?: number }) {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={(1.6 * 24) / size}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn("shrink-0", className)}
    >
      {PATHS[name]}
    </svg>
  );
}

export function IconButton({
  icon,
  label,
  shortcut,
  onClick,
  pressed,
  className,
  ref,
}: {
  icon: IconName;
  label: string;
  shortcut?: string;
  onClick: () => void;
  pressed?: boolean;
  className?: string;
  ref?: Ref<HTMLButtonElement>;
}) {
  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      aria-pressed={pressed}
      title={shortcut ? `${label} (${shortcut})` : label}
      onClick={onClick}
      className={cn(
        "grid size-8 shrink-0 place-items-center rounded-[6px] text-(--g-text-2) transition-colors duration-150 hover:bg-(--g-hover) hover:text-(--g-text) aria-pressed:text-(--g-accent-text)",
        focusRing,
        className,
      )}
    >
      <Icon name={icon} />
    </button>
  );
}

export function Dot({ color, hollow, className }: { color: string; hollow?: boolean; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn("inline-block size-2 shrink-0 rounded-full", hollow && "border-[1.5px] border-dashed", className)}
      style={hollow ? { borderColor: color } : { background: color }}
    />
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className={cn(styles.mono, "rounded-[4px] border border-(--g-border) bg-(--g-panel) px-1.5 text-[11px] leading-[18px] text-(--g-text-3)")}>
      {children}
    </kbd>
  );
}

export function Switch({ label, checked, onChange }: { label: ReactNode; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <label className="flex min-h-8 cursor-pointer items-center justify-between gap-3 text-[13px] text-(--g-text)">
      <span>{label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={cn(
          "relative h-[18px] w-[30px] shrink-0 rounded-full transition-colors duration-150",
          checked ? "bg-(--g-accent)" : "bg-(--g-border)",
          focusRing,
        )}
      >
        <span
          className={cn(
            "absolute left-[2px] top-[2px] size-[14px] rounded-full bg-white shadow-[0_1px_2px_rgba(0,0,0,0.4)] transition-transform duration-150",
            checked && "translate-x-[12px]",
          )}
        />
      </button>
    </label>
  );
}

export function Slider({
  label,
  value,
  min,
  max,
  step,
  onChange,
  format = (v) => v.toFixed(2),
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
  format?: (value: number) => string;
}) {
  const id = useId();
  const fill = ((value - min) / (max - min)) * 100;
  return (
    <div className="py-1">
      <div className="mb-1 flex items-center justify-between text-[12px]">
        <label htmlFor={id} className="text-(--g-text-2)">{label}</label>
        <span className={cn(styles.mono, "text-(--g-text-3)")}>{format(value)}</span>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-valuetext={format(value)}
        onChange={(event) => onChange(Number(event.target.value))}
        className={styles.slider}
        style={{ "--fill": `${fill}%` } as CSSProperties}
      />
    </div>
  );
}

/** A collapsible block with a chevron header. */
export function Section({
  title,
  defaultOpen = true,
  aside,
  children,
}: {
  title: ReactNode;
  defaultOpen?: boolean;
  aside?: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  return (
    <section className="border-t border-(--g-border) first:border-t-0">
      <h3 className="flex items-center pr-2">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={open ? id : undefined}
          onClick={() => setOpen(!open)}
          className={cn("flex h-9 min-w-0 flex-1 items-center gap-1.5 rounded-[6px] px-3 text-[12px] font-medium text-(--g-text-2) hover:text-(--g-text)", focusRing)}
        >
          <Icon name="chevron" size={14} className={cn("transition-transform duration-150", open && "rotate-90")} />
          <span className="truncate">{title}</span>
        </button>
        {aside}
      </h3>
      {open && <div id={id} className="px-3 pb-3">{children}</div>}
    </section>
  );
}
