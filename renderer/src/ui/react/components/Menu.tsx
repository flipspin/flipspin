/* krobi-ui; AGPL-3.0; see LICENSE. */
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { motion } from "../motion";
import { Portal } from "./Portal";
import { useDismissLayer } from "./useDismissLayer";
import { ChevronRight } from "lucide-react";

/** Portal menus so size containers cannot change their fixed-position reference or clip them.
 * Join the shared dismiss stack so a menu inside a dialog closes before its parent. */
export type MenuItem =
  | { type: "separator"; heading?: string }
  /** A text field row; "New playlist…". Enter submits and closes the menu. */
  | { type: "input"; placeholder?: string; onSubmit: (value: string) => void }
  | {
      type?: "item";
      label: string;
      color?: string;
      onClick?: () => void;
      /** Red, with a rule above it; the destructive action at the bottom. */
      danger?: boolean;
      disabled?: boolean;
      /** Why it is disabled, or a short note shown on the right. */
      hint?: string;
      /** A second, muted line under the label (what tells similar rows apart). */
      detail?: string;
      submenu?: MenuItem[];
      tooltip?: string;
    };

type Props = {
  open: boolean;
  upward?: boolean;
  x: number;
  y: number;
  title?: string;
  artist?: string;
  items?: MenuItem[];
  onClose?: () => void;
};

type ActionItem = Exclude<MenuItem, { type: "separator" } | { type: "input" }>;
type InputItem = Extract<MenuItem, { type: "input" }>;

const PAD = 8;
const SUBMENU_DELAY_MS = 140;
/** A submenu can be a whole playlist collection; past this it scrolls. */
const SUBMENU_MAX_H = 360;

const isAction = (m: MenuItem): m is ActionItem => m.type !== "separator" && m.type !== "input";
const enabled = (m: MenuItem) => isAction(m) && !m.disabled;

/**
 * Where to open a menu for a `contextmenu` event. The keyboard's menu key and
 * Shift+F10 fire it at (0, 0); anchor those to the element instead.
 */
export function menuPointFrom(e: { clientX: number; clientY: number; currentTarget?: EventTarget | null; target?: EventTarget | null }) {
  if (e.clientX || e.clientY) return { x: e.clientX, y: e.clientY };
  const el = (e.currentTarget || e.target) as Element | null;
  const r = el?.getBoundingClientRect?.();
  return r ? { x: r.left + Math.min(24, r.width / 2), y: r.bottom } : { x: PAD, y: PAD };
}

/** Place a `w×h` box at a point, flipping to the other side of it when it would overflow. */
function place(x: number, y: number, w: number, h: number, flipX = x) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let left = x + w > vw - PAD ? flipX - w : x;
  let top = y + h > vh - PAD ? y - h : y;
  left = Math.max(PAD, Math.min(left, vw - w - PAD));
  top = Math.max(PAD, Math.min(top, vh - h - PAD));
  return { left, top };
}

function popIn(el: HTMLElement | null) {
  if (!el || typeof el.animate !== "function") return;
  const timing = motion("enter"); // 0 ms under reduced motion
  if (!timing.duration) return;
  el.animate(
    [
      { opacity: 0, transform: "scale(0.97)" },
      { opacity: 1, transform: "none" },
    ],
    timing,
  );
}

const PANEL =
  "fixed z-(--z-popover) min-w-[220px] max-w-[300px] has-[[data-detail]]:max-w-[440px] bg-panel border-2 border-black rounded-[10px] shadow-[5px_5px_0px_0px_rgba(0,0,0,1)] p-1.5 overflow-y-auto slim-scrollbar outline-none select-none";

/**
 * Keys typed here belong to the field: they stop before the menu's own
 * handler, which would otherwise read them as typeahead and swallow them.
 */
function InputRow({ item, onDone }: { item: InputItem; onDone: () => void }) {
  const [value, setValue] = useState("");
  const submit = () => {
    const v = value.trim();
    if (!v) return;
    onDone();
    item.onSubmit(v);
  };
  return (
    <div className="flex items-center gap-1.5 px-1 py-1">
      <input
        type="text"
        value={value}
        placeholder={item.placeholder}
        aria-label={item.placeholder}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") {
            e.preventDefault();
            submit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            onDone();
          }
        }}
        className="flex-1 min-w-0 h-8 px-2 text-[13px] font-semibold rounded-control border-2 border-black bg-[var(--paper)] text-[var(--ink)] outline-none focus:bg-panel"
      />
      <span
        role="button"
        tabIndex={-1}
        aria-label={item.placeholder}
        aria-disabled={!value.trim() || undefined}
        onClick={(e) => {
          e.stopPropagation();
          submit();
        }}
        className={`h-8 w-8 grid place-items-center shrink-0 rounded-control border-2 border-black text-[16px] font-bold leading-none ${
          value.trim() ? "cursor-pointer bg-[var(--yellow)] text-black" : "cursor-default opacity-40"
        }`}
      >
        +
      </span>
    </div>
  );
}

function Rows({
  items,
  active,
  menuId,
  expanded,
  onHover,
  onActivate,
  onDone,
}: {
  items: MenuItem[];
  active: number;
  menuId: string;
  expanded?: number | null;
  onHover: (i: number) => void;
  onActivate: (i: number) => void;
  onDone: () => void;
}) {
  return (
    <>
      {items.map((m, i) => {
        if (m.type === "input") return <InputRow key={`input-${i}`} item={m} onDone={onDone} />;
        if (!isAction(m)) {
          return <React.Fragment key={`sep-${i}`}>
            <div role="separator" className="my-1 mx-1 border-t-2" style={{ borderColor: "var(--line-soft)" }} />
            {m.heading && <div className="px-2.5 py-1 font-mono text-[11px]" style={{ color: "var(--ink-3)" }}>{m.heading}</div>}
          </React.Fragment>;
        }
        const highlighted = i === active && !m.disabled;
        const hasSub = Boolean(m.submenu?.length);
        return (
          <React.Fragment key={`${m.label}-${i}`}>
            {m.danger && i > 0 && isAction(items[i - 1]) && (
              <div role="separator" className="my-1 mx-1 border-t-2" style={{ borderColor: "var(--line-soft)" }} />
            )}
            <div
              id={`${menuId}-${i}`}
              role="menuitem"
              tabIndex={-1}
              aria-disabled={m.disabled || undefined}
              aria-haspopup={hasSub ? "menu" : undefined}
              aria-expanded={hasSub ? expanded === i : undefined}
              data-highlighted={highlighted || undefined}
              title={m.tooltip || (m.disabled && m.hint ? m.hint : undefined)}
              onPointerMove={() => onHover(i)}
              onClick={(e) => {
                e.stopPropagation();
                onActivate(i);
              }}
              className={`flex items-center gap-2.5 w-full text-left whitespace-nowrap text-[13.5px] font-semibold px-2.5 py-[7px] rounded-control transition-colors ${
                m.disabled ? "cursor-default opacity-45" : "cursor-pointer"
              } ${m.danger ? "data-[highlighted]:bg-[var(--rose-tint)]" : "data-[highlighted]:bg-[var(--paper)]"}`}
              style={{ color: m.danger ? "var(--rose)" : "var(--ink)" }}
            >
              <span
                aria-hidden
                className="w-2.5 h-2.5 rounded-[2px] border-[1.5px] border-black shrink-0"
                style={{ background: m.color || "var(--ink-4)" }}
              />
              {m.detail && !m.disabled ? (
                <span data-detail className="flex flex-col min-w-0 flex-1 leading-tight">
                  <span className="flex items-baseline gap-3 min-w-0">
                    <span className="truncate">{m.label}</span>
                    {m.hint && (
                      <span className="ml-auto shrink-0 font-mono text-[11px] font-normal" style={{ color: "var(--ink-3)" }}>
                        {m.hint}
                      </span>
                    )}
                  </span>
                  <span className="truncate text-[11px] font-normal" style={{ color: "var(--ink-3)" }}>
                    {m.detail}
                  </span>
                </span>
              ) : m.disabled && m.hint ? (
                <span className="flex flex-col min-w-0 leading-tight">
                  <span className="truncate">{m.label}</span>
                  <span className="truncate text-[11px] font-normal" style={{ color: "var(--ink-3)" }}>
                    {m.hint}
                  </span>
                </span>
              ) : (
                <span className="truncate min-w-0">{m.label}</span>
              )}
              {m.hint && !m.disabled && !m.detail && !hasSub && (
                <span className="ml-auto pl-3 font-mono text-[11px] font-normal truncate" style={{ color: "var(--ink-3)" }}>
                  {m.hint}
                </span>
              )}
              {hasSub && <ChevronRight aria-hidden size={14} strokeWidth={2.5} className="ml-auto shrink-0" style={{ color: "var(--ink-3)" }} />}
            </div>
          </React.Fragment>
        );
      })}
    </>
  );
}

function step(items: MenuItem[], from: number, dir: 1 | -1) {
  const n = items.length;
  for (let k = 1; k <= n; k++) {
    const i = (from + dir * k + n * 2) % n;
    if (enabled(items[i])) return i;
  }
  return from;
}
const firstEnabled = (items: MenuItem[]) => items.findIndex(enabled);
const lastEnabled = (items: MenuItem[]) => {
  for (let i = items.length - 1; i >= 0; i--) if (enabled(items[i])) return i;
  return -1;
};

let idSeq = 0;

export default function Menu({ open, x, y, title, artist, items = [], onClose, upward = false }: Props) {
  const menuRef = useRef<HTMLDivElement>(null);
  const subRef = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const hoverTimer = useRef<number | undefined>(undefined);
  const typeahead = useRef({ text: "", at: 0 });
  const [menuId] = useState(() => `track-menu-${++idSeq}`);

  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [active, setActive] = useState(-1);
  const [sub, setSub] = useState<number | null>(null);
  const [subActive, setSubActive] = useState(-1);
  const [subPos, setSubPos] = useState<{ left: number; top: number } | null>(null);
  // Which level the keyboard is driving.
  const [level, setLevel] = useState<0 | 1>(0);

  const subItems = sub != null && isAction(items[sub]) ? items[sub].submenu || [] : [];

  const close = useCallback(() => onClose?.(), [onClose]);

  // Fresh state for every opening (a right-click elsewhere re-opens in place).
  useLayoutEffect(() => {
    if (!open) return;
    window.clearTimeout(hoverTimer.current);
    setSub(null);
    setSubActive(-1);
    setLevel(0);
    setActive(-1);
    setPos(null);
  }, [open, x, y]);

  // Measure, then place. Rendered with `visibility: hidden` until then so it
  // never flashes at the unclamped point.
  useLayoutEffect(() => {
    if (!open || pos) return;
    const el = menuRef.current;
    if (!el) return;
    const maxH = window.innerHeight - PAD * 2;
    el.style.maxHeight = `${maxH}px`;
    const { width, height } = el.getBoundingClientRect();
    setPos(place(x, upward ? y - Math.min(height, maxH) : y, width, Math.min(height, maxH)));
  }, [open, pos, x, y, upward]);

  // Remember what had focus, take it, give it back on close.
  useEffect(() => {
    if (!open) return;
    returnFocus.current = document.activeElement as HTMLElement | null;
    return () => {
      // Only if focus went down with the menu: an action that opened a
      // dialog has already moved it somewhere that should keep it.
      const now = document.activeElement;
      if (now && now !== document.body) return;
      const back = returnFocus.current;
      if (back && document.contains(back) && typeof back.focus === "function") back.focus({ preventScroll: true });
    };
  }, [open]);
  useEffect(() => {
    if (open && pos) {
      menuRef.current?.focus({ preventScroll: true });
      popIn(menuRef.current);
    }
  }, [open, pos]);

  // Submenu placement: beside its row, flipped left when the right side is short.
  useLayoutEffect(() => {
    if (sub == null) {
      setSubPos(null);
      return;
    }
    const row = document.getElementById(`${menuId}-${sub}`);
    const el = subRef.current;
    if (!row || !el) return;
    const r = row.getBoundingClientRect();
    const maxH = Math.min(SUBMENU_MAX_H, window.innerHeight - PAD * 2);
    el.style.maxHeight = `${maxH}px`;
    const { width, height } = el.getBoundingClientRect();
    const h = Math.min(height, maxH);
    // Align submenu rows with their parent and clamp vertically without detaching them.
    const { left } = place(r.right + 4, r.top - 8, width, h, r.left - 4);
    const top = Math.max(PAD, Math.min(r.top - 8, window.innerHeight - h - PAD));
    setSubPos({ left, top });
    // Re-placed when its rows change too: the playlists can land after it opened.
  }, [sub, menuId, subItems.length]);
  useEffect(() => {
    if (subPos) popIn(subRef.current);
  }, [subPos]);
  // The keyboard follows the level it drives.
  useEffect(() => {
    if (!subPos) return;
    (level === 1 ? subRef.current : menuRef.current)?.focus({ preventScroll: true });
  }, [level, subPos]);

  // A layer in the shared stack: while the menu is open, a dialog under it is
  // not the top layer, so Escape and outside presses reach the menu only. The
  // menu's own handlers below still do the closing (they swallow the click).
  useDismissLayer(menuRef, open, { branches: [subRef] });

  // Dismissal.
  useEffect(() => {
    if (!open) return;
    const inside = (t: EventTarget | null) =>
      t instanceof Node && (menuRef.current?.contains(t) || subRef.current?.contains(t));

    const swallowNextClick = () => {
      const stop = (e: Event) => {
        e.stopPropagation();
        e.preventDefault();
      };
      window.addEventListener("click", stop, { capture: true, once: true });
      // A pointerdown that never becomes a click (drag, scrollbar) must not
      // eat the next real one.
      window.setTimeout(() => window.removeEventListener("click", stop, { capture: true }), 400);
    };
    const onPointerDown = (e: PointerEvent) => {
      if (inside(e.target)) return;
      // The right button reopens the menu at the new row (its own
      // `contextmenu` handler does that); only a primary press is swallowed.
      if (e.button === 0) swallowNextClick();
      close();
    };
    const onContextMenu = (e: MouseEvent) => {
      if (inside(e.target)) e.preventDefault();
    };
    // Scroll intent dismisses immediately. Do not listen to `scroll`: lyrics,
    // virtualizers and scrollIntoView can move the background without input.
    // Outside scrollbar drags already go through onPointerDown above.
    const onScrollInput = (e: Event) => {
      if (!inside(e.target)) close();
    };
    const onScrollKey = (e: KeyboardEvent) => {
      if (inside(e.target)) return;
      const target = e.target;
      if (target instanceof Element && target.closest("input, textarea, select, [contenteditable]:not([contenteditable='false'])")) return;
      if (["PageUp", "PageDown", "Home", "End", " ", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key)) close();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("contextmenu", onContextMenu, true);
    window.addEventListener("wheel", onScrollInput, { capture: true, passive: true });
    window.addEventListener("touchmove", onScrollInput, { capture: true, passive: true });
    window.addEventListener("keydown", onScrollKey, true);
    window.addEventListener("resize", close);
    window.addEventListener("blur", close);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("contextmenu", onContextMenu, true);
      window.removeEventListener("wheel", onScrollInput, true);
      window.removeEventListener("touchmove", onScrollInput, true);
      window.removeEventListener("keydown", onScrollKey, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("blur", close);
      window.clearTimeout(hoverTimer.current);
    };
  }, [open, close]);

  if (!open) return null;

  const openSub = (i: number, focusFirst: boolean) => {
    window.clearTimeout(hoverTimer.current);
    const m = items[i];
    if (!isAction(m) || m.disabled || !m.submenu?.length) return;
    setSub(i);
    setSubActive(focusFirst ? firstEnabled(m.submenu) : -1);
    if (focusFirst) setLevel(1);
  };
  const closeSub = () => {
    window.clearTimeout(hoverTimer.current);
    setSub(null);
    setSubActive(-1);
    setLevel(0);
    menuRef.current?.focus({ preventScroll: true });
  };

  const activate = (list: MenuItem[], i: number, isSub: boolean) => {
    const m = list[i];
    if (!m || !isAction(m) || m.disabled) return;
    if (!isSub && m.submenu?.length) {
      openSub(i, true);
      return;
    }
    close();
    m.onClick?.();
  };

  const onHoverMain = (i: number) => {
    if (level === 1 && sub === i) return;
    setLevel(0);
    setActive(enabled(items[i]) ? i : -1);
    window.clearTimeout(hoverTimer.current);
    const m = items[i];
    const wantsSub = isAction(m) && !m.disabled && Boolean(m.submenu?.length);
    if (wantsSub && sub === i) return;
    // A short delay each way, so crossing a row on the way into an open
    // submenu does not snap it shut.
    hoverTimer.current = window.setTimeout(() => {
      if (wantsSub) openSub(i, false);
      else {
        setSub(null);
        setSubActive(-1);
      }
    }, SUBMENU_DELAY_MS);
  };
  const onHoverSub = (i: number) => {
    window.clearTimeout(hoverTimer.current);
    if (sub != null) setActive(sub);
    setLevel(1);
    setSubActive(enabled(subItems[i]) ? i : -1);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const list = level === 1 ? subItems : items;
    const cur = level === 1 ? subActive : active;
    const set = level === 1 ? setSubActive : setActive;
    switch (e.key) {
      case "ArrowDown":
        set(cur < 0 ? firstEnabled(list) : step(list, cur, 1));
        break;
      case "ArrowUp":
        set(cur < 0 ? lastEnabled(list) : step(list, cur, -1));
        break;
      case "Home":
      case "PageUp":
        set(firstEnabled(list));
        break;
      case "End":
      case "PageDown":
        set(lastEnabled(list));
        break;
      case "ArrowRight":
        if (level === 0 && cur >= 0) openSub(cur, true);
        break;
      case "ArrowLeft":
        if (level === 1) closeSub();
        break;
      case "Enter":
      case " ":
        if (cur >= 0) activate(list, cur, level === 1);
        break;
      case "Escape":
        if (level === 1) closeSub();
        else close();
        break;
      case "Tab":
        close();
        break;
      default: {
        if (e.key.length !== 1 || e.metaKey || e.ctrlKey || e.altKey) return;
        const now = Date.now();
        const ta = typeahead.current;
        ta.text = (now - ta.at > 600 ? "" : ta.text) + e.key.toLocaleLowerCase();
        ta.at = now;
        const start = cur < 0 ? 0 : cur + (ta.text.length === 1 ? 1 : 0);
        for (let k = 0; k < list.length; k++) {
          const i = (start + k) % list.length;
          const m = list[i];
          if (enabled(m) && isAction(m) && m.label.toLocaleLowerCase().startsWith(ta.text)) {
            set(i);
            break;
          }
        }
        break;
      }
    }
    e.preventDefault();
    e.stopPropagation();
  };

  const activeId = active >= 0 ? `${menuId}-${active}` : undefined;
  const subActiveId = subActive >= 0 ? `${menuId}-sub-${subActive}` : undefined;
  const subMenu = sub != null ? (items[sub] as ActionItem) : null;

  return (
    <Portal>
      <div
        ref={menuRef}
        id={menuId}
        role="menu"
        aria-label={title || undefined}
        aria-activedescendant={activeId}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        onContextMenu={(e) => e.preventDefault()}
        onPointerLeave={() => {
          if (sub == null) setActive(-1);
        }}
        className={PANEL}
        style={pos ? { left: pos.left, top: pos.top } : { left: 0, top: 0, visibility: "hidden" }}
      >
        {(title || artist) && (
          <div className="px-2 pt-1 pb-2 mb-1 border-b-2 min-w-0" style={{ borderColor: "var(--line-soft)" }} aria-hidden>
            {title && (
              <div className="font-bold text-sm truncate" style={{ fontFamily: "var(--font-display)" }}>
                {title}
              </div>
            )}
            {artist && (
              <div className="font-mono text-[11px] truncate" style={{ color: "var(--ink-3)" }}>
                {artist}
              </div>
            )}
          </div>
        )}
        <Rows
          items={items}
          active={level === 1 && sub != null ? sub : active}
          menuId={menuId}
          expanded={sub}
          onHover={onHoverMain}
          onActivate={(i) => activate(items, i, false)}
          onDone={close}
        />
      </div>

      {subMenu && (
        <div
          ref={subRef}
          role="menu"
          aria-label={subMenu.label}
          aria-activedescendant={subActiveId}
          tabIndex={-1}
          onKeyDown={onKeyDown}
          onPointerEnter={() => window.clearTimeout(hoverTimer.current)}
          className={PANEL}
          style={subPos ? { left: subPos.left, top: subPos.top } : { left: 0, top: 0, visibility: "hidden" }}
        >
          <Rows
            items={subItems}
            active={subActive}
            menuId={`${menuId}-sub`}
            onHover={onHoverSub}
            onActivate={(i) => activate(subItems, i, true)}
            onDone={close}
          />
        </div>
      )}
    </Portal>
  );
}
