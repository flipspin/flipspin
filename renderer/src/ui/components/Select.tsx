import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Portal } from "../react/components/Portal";
import { useDismissLayer } from "../react/components/useDismissLayer";
import { useFocusTrap } from "../react/components/useFocusTrap";
import "./select.css";
import { Check, ChevronDown, Search } from "lucide-react";
import { useTranslation } from "react-i18next";

/** Use a themed popup because native selects do not follow app appearance consistently.
 * Portal the list so table overflow cannot clip it. */
export type SelectOption = {
  value: string;
  label: string;
  /** A short note on the right; a count, a code. */
  hint?: string;
  group?: string;
  pinned?: boolean;
  emphasized?: boolean;
};

type Props = {
  label?: string;
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  active?: boolean;
  /** Shown on the trigger instead of the chosen option's label. */
  display?: React.ReactNode;
  searchAbove?: number;
  className?: string;
  /** Trigger width behaviour: fill its cell, or size to its content. */
  fill?: boolean;
  ariaLabel?: string;
  disabled?: boolean;
  id?: string;
};

const PAD = 8;

export default function Select({
  label,
  value,
  options,
  onChange,
  active = false,
  display,
  searchAbove = 12,
  className = "",
  fill = true,
  ariaLabel,
  disabled = false,
  id,
}: Props) {
  const { t } = useTranslation();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [hi, setHi] = useState(-1);
  const [pos, setPos] = useState<{ left: number; top: number; width: number; maxH: number } | null>(null);

  const searchable = options.length > searchAbove;
  const current = options.find((o) => o.value === value);
  const shown = useMemo(() => {
    const q = query.trim().toLocaleLowerCase();
    return q ? options.filter((o) => o.label.toLocaleLowerCase().includes(q)) : options;
  }, [options, query]);

  const groups = [...new Set(shown.map(option => option.group))];

  const close = useCallback((refocus = true) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus({ preventScroll: true });
  }, []);

  const openPanel = () => {
    setQuery("");
    setPos(null);
    setOpen(true);
  };

  // Place under the trigger (or above it when the window is short below).
  useLayoutEffect(() => {
    if (!open) return;
    const r = triggerRef.current?.getBoundingClientRect();
    if (!r) return;
    const width = Math.max(r.width, 200);
    const below = window.innerHeight - r.bottom - PAD;
    const above = r.top - PAD;
    const flip = below < 220 && above > below;
    const maxH = Math.min(360, (flip ? above : below) - 6);
    const left = Math.max(PAD, Math.min(r.left, window.innerWidth - width - PAD));
    setPos({ left, top: flip ? r.top - 6 - maxH : r.bottom + 6, width, maxH });
  }, [open]);

  // Highlight the chosen option on open; keep the highlight on screen.
  useEffect(() => {
    if (!open) return;
    setHi(Math.max(0, shown.findIndex((o) => o.value === value)));
    // Only when the panel opens or the filtered list changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, shown]);
  useEffect(() => {
    if (!open || hi < 0) return;
    listRef.current?.querySelector<HTMLElement>(`[data-index="${hi}"]`)?.scrollIntoView?.({ block: "nearest" });
  }, [open, hi]);
  useEffect(() => {
    if (open && pos) (searchable ? inputRef.current : listRef.current)?.focus({ preventScroll: true });
  }, [open, pos, searchable]);

  useDismissLayer(panelRef, open, { onEscape: () => close(), onOutsidePress: () => close(false), branches: [triggerRef] });
  useFocusTrap(panelRef, open, { restoreFocus: false, initialFocus: () => searchable ? inputRef.current : listRef.current });
  useEffect(() => {
    if (!open) return;
    const onScroll = (event: Event) => {
      if (event.target instanceof Node && panelRef.current?.contains(event.target)) return;
      close(false);
    };
    const onResize = () => close(false);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    };
  }, [open, close]);

  const pick = (o: SelectOption | undefined) => {
    if (!o) return;
    onChange(o.value);
    close();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    switch (e.key) {
      case "ArrowDown":
        setHi((i) => Math.min(shown.length - 1, i + 1));
        break;
      case "ArrowUp":
        setHi((i) => Math.max(0, i - 1));
        break;
      case "Home":
        setHi(0);
        break;
      case "End":
        setHi(shown.length - 1);
        break;
      case "Enter":
        pick(shown[hi]);
        break;
      case "Escape":
        close();
        break;
      case "Tab":
        e.stopPropagation();
        close();
        return;
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
  };

  const listId = useMemo(() => `select-${Math.random().toString(36).slice(2, 9)}`, []);

  return (
    <div className={`flex flex-col gap-1 min-w-0 ${className}`}>
      {label && (
        <span className="text-[10px] font-bold uppercase tracking-[0.06em] leading-none" style={{ color: "var(--ink-3)" }}>
          {label}
        </span>
      )}
      <button
        ref={triggerRef}
        type="button"
        id={id}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={ariaLabel || (label ? `${label}: ${current?.label ?? value}` : undefined)}
        onClick={() => (open ? close() : openPanel())}
        onKeyDown={(e) => {
          if (!open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
            e.preventDefault();
            openPanel();
          }
        }}
        className={`krobi-select ${active ? "krobi-select--active" : ""} ${fill ? "w-full" : ""}`}
      >
        <span className="truncate min-w-0">{display ?? current?.label ?? value}</span>
        <ChevronDown size={14} strokeWidth={2.5} aria-hidden className={`shrink-0 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open &&
        <Portal>
          <div
            ref={panelRef}
            tabIndex={-1}
            onKeyDown={onKeyDown}
            className="krobi-select-panel"
            style={pos ? { left: pos.left, top: pos.top, width: pos.width, maxHeight: pos.maxH } : { left: 0, top: 0, visibility: "hidden" }}
          >
            {searchable && (
              <div className="krobi-select-panel__search">
                <Search size={13} aria-hidden />
                <input
                  ref={inputRef}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={onKeyDown}
                  placeholder={t("Search…")}
                  aria-label={t("Search the list")}
                  aria-controls={listId}
                  aria-activedescendant={hi >= 0 ? `${listId}-${hi}` : undefined}
                />
              </div>
            )}
            <div ref={listRef} id={listId} role="listbox" tabIndex={searchable ? undefined : -1} aria-activedescendant={!searchable && hi >= 0 ? `${listId}-${hi}` : undefined} aria-label={label || ariaLabel} className="krobi-select-panel__list">
              {shown.length === 0 ? (
                <div className="krobi-select-panel__empty">{t("Nothing matches")}</div>
              ) : (
                groups.map(group => {
                  const items = shown.filter(option => option.group === group).map(o => {
                    const i = shown.indexOf(o);
                    return <div
                      key={o.value}
                      id={`${listId}-${i}`}
                      data-index={i}
                      role="option"
                      aria-selected={o.value === value}
                      data-highlighted={i === hi || undefined}
                      data-emphasized={o.emphasized || undefined}
                      data-pinned={o.pinned || undefined}
                      onPointerMove={() => setHi(i)}
                      onClick={() => pick(o)}
                      className="krobi-select-panel__option"
                    >
                      <span className="truncate min-w-0">{o.label}</span>
                      {o.hint && <span className="krobi-select-panel__hint">{o.hint}</span>}
                      {o.value === value && <Check size={14} strokeWidth={3} aria-hidden className="shrink-0" />}
                    </div>;
                  });
                  return group ? <div role="group" aria-label={group} key={group}><div className="krobi-select-panel__group" aria-hidden>{group}</div>{items}</div> : <React.Fragment key="ungrouped">{items}</React.Fragment>;
                })
              )}
            </div>
          </div>
        </Portal>}
    </div>
  );
}
