"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState, type ReactNode, type Ref } from "react";
import { cn } from "@/lib/utils";
import { THEME } from "@/lib/graph/theme";
import styles from "./graph-view.module.css";
import { Dot, Icon, focusRing, type IconName } from "./ui";

/** Where the graph on screen came from. */
export type SourceKind = "sample" | "url" | "local" | "account";

export interface SourceInfo {
  kind: SourceKind;
  /** "Sample vault", "Obsidian vault: My Vault", … */
  label: string;
  /** Notes people wrote (not unresolved placeholders or attachments). */
  notes: number;
  unresolved: number;
  links: number;
  /** ISO-8601: when it was imported (local) or last saved (account). */
  at?: string;
}

export type SaveState = { status: "idle" } | { status: "saving" } | { status: "saved" } | { status: "error"; message: string };

export interface Notice {
  tone: "error" | "info";
  message: string;
  /** A follow-up, e.g. back to the shelf to enter the code word. */
  link?: { label: string; href: string };
  /** A follow-up done right here, e.g. "Retry" or "Save anyway". */
  action?: { label: string; onClick: () => void };
}

const STATUS: Record<SourceKind, string | null> = { sample: null, url: null, local: "imported locally", account: "saved to account" };

function when(iso?: string): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function SourceDot({ kind }: { kind: SourceKind }) {
  if (kind === "account") return <Dot color={THEME.accent} />;
  if (kind === "local") return <Dot color={THEME.accent} hollow />;
  return <Dot color={THEME.text3} />;
}

/**
 * "Back to shelf" and the source of the graph, for the top of the sidebar. The chip names the kind
 * of source ("Obsidian vault") and the heading below it the vault, so neither gets truncated.
 */
export function SourceHeader({ source }: { source: SourceInfo }) {
  const status = STATUS[source.kind];
  const colon = source.label.indexOf(": ");
  const kind = colon > 0 ? source.label.slice(0, colon) : source.label;
  return (
    <div className="mb-3 space-y-2">
      <Link href="/" className={cn("-ml-1 inline-flex h-6 items-center gap-1 rounded-[6px] px-1 text-[12px] text-(--g-text-3) transition-colors duration-150 hover:text-(--g-text)", focusRing)}>
        <Icon name="backlink" size={12} />
        Back to shelf
      </Link>
      <p
        className="flex w-fit max-w-full items-center gap-1.5 rounded-full border border-(--g-border) bg-(--g-panel) px-2 py-0.5 text-[12px]"
        title={[source.label, status, when(source.at)].filter(Boolean).join(" · ")}
      >
        <SourceDot kind={source.kind} />
        <span className="sr-only">Source: {source.label}</span>
        <span aria-hidden="true" className="min-w-0 truncate text-(--g-text-2)">{kind}</span>
        {status && <span className="shrink-0 whitespace-nowrap text-(--g-text-3)">· {status}</span>}
      </p>
    </div>
  );
}

function ToolbarButton({
  icon,
  label,
  onClick,
  disabled,
  busy,
  tone,
  ref,
  children,
  ...aria
}: {
  icon: IconName | "busy";
  label: string;
  onClick: () => void;
  disabled?: boolean;
  busy?: boolean;
  tone?: "error" | "done";
  ref?: Ref<HTMLButtonElement>;
  children?: ReactNode;
  "aria-expanded"?: boolean;
  "aria-controls"?: string;
}) {
  return (
    <button
      ref={ref}
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-busy={busy || undefined}
      aria-label={children ? undefined : label}
      title={label}
      {...aria}
      className={cn(
        "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-[6px] px-2 text-[13px] text-(--g-text-2) transition-colors duration-150 hover:bg-(--g-hover) hover:text-(--g-text) disabled:cursor-default disabled:hover:bg-transparent aria-expanded:text-(--g-accent-text)",
        focusRing,
      )}
      style={tone === "error" ? { color: THEME.danger } : tone === "done" ? { color: THEME.accentText } : undefined}
    >
      {icon === "busy" ? (
        <span aria-hidden="true" className="grid size-4 place-items-center"><span className={cn("size-1.5 rounded-full bg-(--g-accent)", styles.pulse)} /></span>
      ) : (
        <Icon name={icon} />
      )}
      {children}
    </button>
  );
}

function MenuItem({ icon, onClick, children, tone }: { icon: IconName; onClick: () => void; children: ReactNode; tone?: "danger" }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn("flex h-8 w-full items-center gap-2 rounded-[8px] px-2.5 text-left text-[13px] text-(--g-text) transition-colors duration-150 hover:bg-(--g-hover)", focusRing)}
      style={tone === "danger" ? { color: THEME.danger } : undefined}
    >
      <Icon name={icon} size={14} className={tone ? undefined : "text-(--g-text-3)"} />
      {children}
    </button>
  );
}

/**
 * Top-bar actions for the graph's source: Import…, Save to account (when there is a session and the
 * graph is only in this browser) and a disclosure with the source details, Reset to sample, Remove
 * from account and Back to shelf. Messages about those actions appear just below it.
 */
export function SourceToolbar({
  source,
  canSave,
  save,
  savedToAccount,
  resetLabel = "Reset to sample",
  notice,
  onImport,
  onSave,
  onReset,
  onRemove,
  onDismissNotice,
}: {
  source: SourceInfo;
  canSave: boolean;
  save: SaveState;
  /** The account has a saved graph (shown or not, or it couldn't be checked), so it can be removed. */
  savedToAccount: boolean;
  resetLabel?: string;
  notice: Notice | null;
  onImport: () => void;
  onSave: () => void;
  onReset: () => void;
  onRemove: () => void;
  onDismissNotice: () => void;
}) {
  const menuId = useId();
  const [open, setOpen] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const status = STATUS[source.kind];

  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector<HTMLElement>("button, a")?.focus();
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!menuRef.current?.contains(target) && !triggerRef.current?.contains(target)) {
        setOpen(false);
        setConfirmRemove(false);
      }
    };
    document.addEventListener("pointerdown", onPointer);
    return () => document.removeEventListener("pointerdown", onPointer);
  }, [open]);

  const closeMenu = () => {
    setOpen(false);
    setConfirmRemove(false);
    triggerRef.current?.focus();
  };

  /** Runs a menu action with focus back on the trigger, so a dialog it opens returns focus there. */
  const run = (action: () => void) => {
    closeMenu();
    action();
  };

  const showSave = canSave || save.status === "saved";
  const saveLabel =
    save.status === "saving" ? "Saving…" : save.status === "saved" ? "Saved to account" : save.status === "error" ? "Retry save" : "Save to account";

  return (
    <>
      <div className={cn(styles.glass, "flex items-center gap-0.5 rounded-[8px] p-0.5")}>
        <ToolbarButton icon="upload" label="Import your graph…" onClick={onImport}>
          <span className="max-lg:sr-only">Import…</span>
        </ToolbarButton>
        {showSave && (
          <ToolbarButton
            icon={save.status === "saving" ? "busy" : save.status === "saved" ? "check" : save.status === "error" ? "alert" : "cloud"}
            label={saveLabel}
            onClick={onSave}
            disabled={save.status === "saving" || save.status === "saved"}
            busy={save.status === "saving"}
            tone={save.status === "error" ? "error" : save.status === "saved" ? "done" : undefined}
          >
            <span className="max-xl:sr-only">{saveLabel}</span>
          </ToolbarButton>
        )}
        <div className="relative">
          <ToolbarButton
            ref={triggerRef}
            icon="more"
            label="Graph source and options"
            onClick={() => (open ? closeMenu() : setOpen(true))}
            aria-expanded={open}
            aria-controls={open ? menuId : undefined}
          />
          {open && (
            <div
              ref={menuRef}
              id={menuId}
              role="group"
              aria-label="Graph source"
              onKeyDown={(event) => {
                if (event.key !== "Escape") return;
                event.preventDefault();
                event.stopPropagation();
                closeMenu();
              }}
              className={cn(styles.glass, "absolute right-0 top-[calc(100%+8px)] z-30 w-[288px] max-w-[calc(100vw-24px)] bg-(--g-glass-solid) p-1.5")}
            >
              <div className="mb-1 border-b border-(--g-border) px-2.5 pb-2.5 pt-1.5">
                <p className="text-[12px] text-(--g-text-3)">Showing</p>
                <p className="mt-0.5 flex items-center gap-2 text-[13px] font-medium text-(--g-text)">
                  <SourceDot kind={source.kind} />
                  <span className="min-w-0 break-words">{source.label}</span>
                </p>
                <p className={cn(styles.mono, "mt-1 text-[12px] text-(--g-text-3)")}>
                  {source.notes.toLocaleString("en-US")} notes
                  {source.unresolved > 0 && ` + ${source.unresolved.toLocaleString("en-US")} unresolved`} · {source.links.toLocaleString("en-US")} links
                </p>
                <p className="mt-0.5 text-[12px] text-(--g-text-3)">
                  {source.kind === "sample"
                    ? "Built-in example vault"
                    : source.kind === "url"
                      ? "Loaded from the configured graph URL"
                      : [status && status.charAt(0).toUpperCase() + status.slice(1), when(source.at)].filter(Boolean).join(" · ")}
                </p>
              </div>
              <MenuItem icon="upload" onClick={() => run(onImport)}>{source.kind === "sample" ? "Import your graph…" : "Import another graph…"}</MenuItem>
              {/* Not while a save runs: a second click would send a second upload. */}
              {canSave && save.status !== "saving" && <MenuItem icon="cloud" onClick={() => run(onSave)}>Save to account</MenuItem>}
              {(source.kind === "local" || source.kind === "account") && <MenuItem icon="reset" onClick={() => run(onReset)}>{resetLabel}</MenuItem>}
              {savedToAccount &&
                (confirmRemove ? (
                  <MenuItem icon="trash" tone="danger" onClick={() => run(onRemove)}>Remove it from my account</MenuItem>
                ) : (
                  <MenuItem icon="trash" onClick={() => setConfirmRemove(true)}>Remove from account…</MenuItem>
                ))}
              <div className="my-1 h-px bg-(--g-border)" />
              <Link href="/" className={cn("flex h-8 w-full items-center gap-2 rounded-[8px] px-2.5 text-[13px] text-(--g-text) transition-colors duration-150 hover:bg-(--g-hover)", focusRing)}>
                <Icon name="backlink" size={14} className="text-(--g-text-3)" />
                Back to shelf
              </Link>
            </div>
          )}
        </div>
      </div>

      {/* Always on the page, so screen readers announce messages that appear in it later. */}
      <div aria-live="polite" className="absolute right-0 top-[calc(100%+8px)] z-20 w-[340px] max-w-full max-sm:inset-x-0 max-sm:w-auto">
        {notice && (
          <div
            className={cn(styles.glass, "flex w-full items-start gap-2 bg-(--g-glass-solid) p-3 text-[12px]")}
            style={notice.tone === "error" ? { borderColor: THEME.dangerBorder } : undefined}
          >
            <span className="mt-px" style={{ color: notice.tone === "error" ? THEME.danger : THEME.accentText }}>
              <Icon name={notice.tone === "error" ? "alert" : notice.action ? "alert" : "check"} size={14} />
            </span>
            <div className="min-w-0 flex-1">
              <p className="break-words text-(--g-text)">{notice.message}</p>
              {(notice.link || notice.action) && (
                <div className="mt-1 flex flex-wrap gap-x-3">
                  {notice.action && (
                    <button type="button" onClick={notice.action.onClick} className={cn("rounded-[4px] font-medium text-(--g-accent-text) hover:underline", focusRing)}>
                      {notice.action.label}
                    </button>
                  )}
                  {notice.link && (
                    <Link href={notice.link.href} className={cn("inline-block rounded-[4px] text-(--g-accent-text) hover:underline", focusRing)}>
                      {notice.link.label}
                    </Link>
                  )}
                </div>
              )}
            </div>
            <button
              type="button"
              aria-label="Dismiss"
              onClick={onDismissNotice}
              className={cn("-m-1 grid size-6 shrink-0 place-items-center rounded-[6px] text-(--g-text-3) hover:bg-(--g-hover) hover:text-(--g-text)", focusRing)}
            >
              <Icon name="close" size={12} />
            </button>
          </div>
        )}
      </div>
    </>
  );
}
