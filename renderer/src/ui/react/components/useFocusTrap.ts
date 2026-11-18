/* krobi-ui; AGPL-3.0; see LICENSE. */
import { useEffect, useRef, type RefObject } from "react";

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"]),[contenteditable="true"]';

/** innermost active trap wins, so a portalled child doesn't fight its parent. */
const stack: HTMLElement[] = [];

export interface FocusTrapOptions {
  /** where focus lands on activate: first focusable (default), the container itself, or a resolver. */
  initialFocus?: "first" | "container" | (() => HTMLElement | null);
  /** return focus to the previously focused element on deactivate. default true. */
  restoreFocus?: boolean;
  /** contain Tab inside the scope. default true. */
  trapped?: boolean;
  /** isolate the application and pause an outer modal scope. */
  modal?: boolean;
}

export function focusables(root: HTMLElement): HTMLElement[] {
  // A rendered <body> always has a box; without one there is no layout engine
  // (jsdom), and "has no box" would wrongly mean "hidden" for every element.
  const laidOut = document.body.getClientRects().length > 0;
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((node) => {
    if (node.tabIndex < 0 || node.closest("[hidden],[inert]")) return false;
    const style = getComputedStyle(node);
    if (style.display === "none" || style.visibility === "hidden") return false;
    return !laidOut || node.getClientRects().length > 0 || style.position === "fixed";
  });
}

// The last two elements that took focus, so a trap that starts after React's
// `autoFocus` moved focus inside can still find the opener to give it back.
const focusHistory: HTMLElement[] = [];
if (typeof document !== "undefined") {
  document.addEventListener(
    "focusin",
    (e) => {
      if (!(e.target instanceof HTMLElement)) return;
      focusHistory.push(e.target);
      if (focusHistory.length > 2) focusHistory.shift();
    },
    true,
  );
}

let modalLocks = 0;
const hidden = new Map<HTMLElement, string | null>();

/**
 * Hide everything outside the modal from assistive technology. `aria-hidden`,
 * not `inert`: setting `inert` on the app root made WebKit restyle the whole
 * page (~120 ms on open and again on close). Keyboard focus is already held
 * by the trap below and pointer input by the scrim, which is what `inert`
 * added on top (the Radix / Ariakit approach).
 */
function isolateApplication(scope: HTMLElement) {
  if (modalLocks++ > 0) return;
  const outside = (parent: Element) => {
    for (const child of Array.from(parent.children) as HTMLElement[]) {
      if (child.hasAttribute("data-krobi-modal-branch")) continue;
      // The shared layer container holds the dialog itself: hide its other layers, not it.
      if (child.contains(scope)) {
        if (child.id === "krobi-layers") outside(child);
        continue;
      }
      hidden.set(child, child.getAttribute("aria-hidden"));
      child.setAttribute("aria-hidden", "true");
    }
  };
  outside(document.body);
}

function restoreApplication() {
  modalLocks = Math.max(0, modalLocks - 1);
  if (modalLocks > 0) return;
  hidden.forEach((was, node) => {
    if (!node.isConnected) return;
    if (was == null) node.removeAttribute("aria-hidden");
    else node.setAttribute("aria-hidden", was);
  });
  hidden.clear();
}

/** trap Tab inside `ref` while `active`; set initial focus; restore focus on close. */
export function useFocusTrap(ref: RefObject<HTMLElement | null>, active: boolean, options: FocusTrapOptions = {}) {
  const optsRef = useRef(options);
  optsRef.current = options;

  useEffect(() => {
    if (!active) return;
    const el = ref.current;
    if (!el) return;
    const { initialFocus = "first", restoreFocus = true, trapped = true, modal = false } = optsRef.current;
    const focused = document.activeElement as HTMLElement | null;
    const previous = focused && el.contains(focused) && focused !== el ? ([...focusHistory].reverse().find((n) => !el.contains(n)) ?? null) : focused;
    // Where focus goes if the opener is gone on close: its neighbours in DOM
    // order. Only collected here (no style reads; a long list has >1000
    // focusables, and checking each one's visibility stalled the enter
    // animation); visibility is checked at close, and only if needed.
    const raw = previous ? Array.from(document.body.querySelectorAll<HTMLElement>(FOCUSABLE)) : [];
    const at = previous ? raw.indexOf(previous) : -1;
    const neighbours = at < 0 ? [] : [raw[at + 1], raw[at - 1], raw[at + 2], raw[at - 2]].filter(Boolean);
    const previousScope = modal ? stack[stack.length - 1] : null;
    const previousScopeInert = previousScope?.inert ?? false;
    stack.push(el);
    if (modal) {
      isolateApplication(el);
      if (previousScope) previousScope.inert = true;
    }

    // React's `autoFocus` has already run (commit, before this effect): an
    // element inside that took focus keeps it.
    const target = el.contains(document.activeElement) && document.activeElement !== el
      ? null
      : typeof initialFocus === "function"
        ? initialFocus()
        : initialFocus === "container"
          ? el
          : (el.querySelector<HTMLElement>("[data-autofocus]") ?? focusables(el)[0] ?? el);
    target?.focus({ preventScroll: true });

    const trappedFocusables = () => [
      ...focusables(el),
      ...(modal ? Array.from(document.querySelectorAll<HTMLElement>("[data-krobi-notifications]")).flatMap(focusables) : []),
    ];
    const onKey = (e: KeyboardEvent) => {
      if (!trapped || e.key !== "Tab" || stack[stack.length - 1] !== el) return;
      const list = trappedFocusables();
      const current = document.activeElement;
      if (list.length === 0) {
        e.preventDefault();
        el.focus();
        return;
      }
      if (modal && document.querySelector("[data-krobi-notifications] button")) {
        // Notifications precede the dialog in DOM order; step explicitly so
        // its focus guards do not wrap before reaching a toast action.
        e.preventDefault();
        const at = list.indexOf(current as HTMLElement);
        list[(at + (e.shiftKey ? -1 : 1) + list.length) % list.length].focus();
        return;
      }
      const first = list[0];
      const last = list[list.length - 1];
      const outside = !el.contains(current) && !list.includes(current as HTMLElement);
      if (e.shiftKey && (current === first || current === el || outside)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (current === last || outside)) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);

    const before = document.createElement("span");
    const after = document.createElement("span");
    if (trapped) {
      before.tabIndex = 0;
      after.tabIndex = 0;
      before.dataset.focusGuard = "";
      after.dataset.focusGuard = "";
      before.addEventListener("focus", () => (trappedFocusables().at(-1) ?? el).focus());
      after.addEventListener("focus", () => (trappedFocusables()[0] ?? el).focus());
      el.before(before);
      el.after(after);
    }

    return () => {
      document.removeEventListener("keydown", onKey);
      before.remove();
      after.remove();
      const i = stack.lastIndexOf(el);
      if (i >= 0) stack.splice(i, 1);
      if (modal) {
        if (previousScope?.isConnected) previousScope.inert = previousScopeInert;
        restoreApplication();
      }
      if (restoreFocus) {
        const restoreTarget = previous?.isConnected
          ? previous
          : (neighbours.find((n) => n.isConnected && focusables(n.parentElement ?? document.body).includes(n)) ?? null);
        restoreTarget?.focus({ preventScroll: true });
      }
    };
  }, [ref, active]);
}
