"use client";

import { useId, useMemo, useState, type RefObject } from "react";
import { cn } from "@/lib/utils";
import styles from "./graph-view.module.css";
import { Dot, Icon, Kbd } from "./ui";

export interface SearchItem {
  id: string;
  label: string;
  group: string;
  color: string;
  hollow: boolean;
  degree: number;
}

const LIMIT = 8;

/** Higher is better; -1 means no match. Prefix beats word start beats substring beats fuzzy. */
function score(label: string, query: string): number {
  const text = label.toLowerCase();
  if (text === query) return 100;
  if (text.startsWith(query)) return 80;
  if (text.includes(` ${query}`)) return 60;
  const at = text.indexOf(query);
  if (at >= 0) return 40 - Math.min(10, at * 0.1);
  let j = 0, gaps = 0, last = -1;
  for (let i = 0; i < text.length && j < query.length; i++) {
    if (text[i] !== query[j]) continue;
    if (last >= 0) gaps += i - last - 1;
    last = i;
    j++;
  }
  return j === query.length ? 20 - Math.min(19, gaps * 0.5) : -1;
}

function Highlight({ label, query }: { label: string; query: string }) {
  const at = query ? label.toLowerCase().indexOf(query) : -1;
  if (at < 0) return <>{label}</>;
  return (
    <>
      {label.slice(0, at)}
      <mark className="bg-transparent text-(--g-accent-text)">{label.slice(at, at + query.length)}</mark>
      {label.slice(at + query.length)}
    </>
  );
}

/** Command-style note search: type, arrow through matches, Enter flies the camera there. */
export function CommandSearch({
  items,
  onPick,
  onDismiss,
  shortcut,
  inputRef,
}: {
  items: readonly SearchItem[];
  onPick: (id: string) => void;
  /** Esc in an empty search: hand focus back (e.g. to the graph). Blurs when omitted. */
  onDismiss?: () => void;
  shortcut: string;
  inputRef: RefObject<HTMLInputElement | null>;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const listId = useId();
  const q = query.trim().toLowerCase();

  const results = useMemo(() => {
    if (!q) return [...items].sort((a, b) => b.degree - a.degree).slice(0, LIMIT);
    return items
      .map((item) => ({ item, s: score(item.label, q) }))
      .filter((r) => r.s >= 0)
      .sort((a, b) => b.s - a.s || b.item.degree - a.item.degree)
      .slice(0, LIMIT)
      .map((r) => r.item);
  }, [items, q]);
  const current = Math.min(active, results.length - 1);
  const expanded = open && results.length > 0;
  const noMatch = open && q !== "" && results.length === 0;

  // Focus stays in the field (closing the list), so it isn't dropped onto <body>.
  const choose = (item: SearchItem | undefined) => {
    if (!item) return;
    onPick(item.id);
    setQuery("");
    setActive(0);
    setOpen(false);
  };

  return (
    <div className="relative w-full">
      <div
        className={cn(
          styles.glass,
          "flex h-9 items-center gap-2 rounded-[8px] px-3 transition-[border-color] duration-150 focus-within:border-(--g-accent)",
        )}
      >
        <Icon name="search" className="text-(--g-text-3)" />
        <input
          ref={inputRef}
          type="text"
          role="combobox"
          aria-label="Search notes"
          aria-expanded={expanded}
          aria-controls={expanded ? listId : undefined}
          aria-autocomplete="list"
          aria-activedescendant={expanded ? `${listId}-${current}` : undefined}
          placeholder="Search notes"
          autoComplete="off"
          spellCheck={false}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              setOpen(true);
              const step = event.key === "ArrowDown" ? 1 : -1;
              setActive((current + step + results.length) % Math.max(1, results.length));
            } else if (event.key === "Enter") {
              event.preventDefault();
              choose(results[current]);
            } else if (event.key === "Escape") {
              if (query) {
                setQuery("");
              } else if (open) {
                setOpen(false);
              } else if (onDismiss) {
                onDismiss();
              } else {
                event.currentTarget.blur();
              }
            }
          }}
          className="h-full min-w-0 flex-1 bg-transparent text-[13px] text-(--g-text) outline-none placeholder:text-(--g-text-3)"
          onClick={() => setOpen(true)}
        />
        <span className="max-sm:hidden">
          <Kbd>{shortcut}</Kbd>
        </span>
      </div>
      {expanded && (
        <ul
          id={listId}
          role="listbox"
          aria-label={q ? "Matching notes" : "Most connected notes"}
          className={cn(styles.glass, styles.scroll, "absolute inset-x-0 top-[calc(100%+6px)] z-30 max-h-[320px] overflow-y-auto p-1")}
        >
          {!q && <li role="presentation" className="px-2 pb-1 pt-1.5 text-[11px] font-medium text-(--g-text-3)">Most connected</li>}
          {results.map((item, i) => (
            <li
              key={item.id}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === current}
              onMouseDown={(event) => {
                event.preventDefault();
                choose(item);
              }}
              onMouseEnter={() => setActive(i)}
              className={cn(
                "flex h-8 cursor-pointer items-center gap-2 rounded-[8px] px-2 text-[13px]",
                i === current ? "bg-(--g-hover) text-(--g-text)" : "text-(--g-text-2)",
              )}
            >
              <Dot color={item.color} hollow={item.hollow} />
              <span className="min-w-0 flex-1 truncate">
                <Highlight label={item.label} query={q} />
              </span>
              <span className={cn("hidden shrink-0 text-[12px] sm:inline", i === current ? "text-(--g-text-2)" : "text-(--g-text-3)")}>{item.group}</span>
              <span className={cn(styles.mono, "w-6 shrink-0 text-right text-[12px]", i === current ? "text-(--g-text-2)" : "text-(--g-text-3)")}>{item.degree}</span>
            </li>
          ))}
        </ul>
      )}
      {noMatch && (
        <div className={cn(styles.glass, "absolute inset-x-0 top-[calc(100%+6px)] z-30 px-3 py-2.5 text-[13px] text-(--g-text-2)")}>
          No notes match “{query.trim()}”
        </div>
      )}
      <p aria-live="polite" className="sr-only">
        {open && q ? (results.length ? `${results.length === LIMIT ? `${LIMIT} or more` : results.length} matching notes` : "No notes match") : ""}
      </p>
    </div>
  );
}
