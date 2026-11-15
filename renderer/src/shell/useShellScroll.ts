import { useLayoutEffect, type RefObject } from "react";
import { HEADER_HEIGHT_PX } from "./headerTitle";

/** Feishin's page-header offset for pages that scroll their whole content. */
export const SHELL_SCROLL_THRESHOLD_PX = 200;

/** The shell owns reveal state. Read scrollTop at delivery time, never observer
 * geometry or event payloads; an early/stale layout delivery cannot reveal it. */
export function useShellScroll(headerRef: RefObject<HTMLElement | null>, pageKey: string, floating: boolean): void {
  useLayoutEffect(() => {
    const bar = headerRef.current;
    if (!bar) return;
    const reveal = (scrolled: boolean, covered = scrolled) => {
      // Content under the bar makes its ground solid at once; the title waits
      // for the reveal point, so the controls never sit on see-through content.
      bar.toggleAttribute("data-covered", floating && covered);
      bar.toggleAttribute("data-scrolled", floating && scrolled);
      // The bar's title is always shown; only the ground waits for content.
      const title = bar.querySelector<HTMLElement>(".app-header__title");
      title?.removeAttribute("aria-hidden");
      title?.removeAttribute("inert");
    };
    reveal(false);
    // Solid bars never observe table, playlist or plugin inner scrollers.
    if (!floating) return;
    const shell = bar.closest<HTMLElement>(".shell-frame");
    const area = shell?.querySelector<HTMLElement>(".k-page");
    if (!shell || !area) return;
    let frame: number | null = null;
    let disposed = false;
    let scroller: HTMLElement | null = null;
    let pendingTarget: HTMLElement | null = null;
    const visible = (element: HTMLElement) => area.contains(element)
      && !element.closest(".hidden, [hidden], [inert]");
    const scrollable = (element: HTMLElement) => /^(auto|scroll)$/.test(getComputedStyle(element).overflowY);
    const overflows = (element: HTMLElement) => element.scrollHeight > element.clientHeight + 1;
    const check = () => {
      frame = null;
      if (pendingTarget && visible(pendingTarget) && scrollable(pendingTarget)) scroller = pendingTarget;
      pendingTarget = null;
      // Also covers async page mounts and restored scroll positions. Ignore
      // hidden pages retained by BrowseSlot, and horizontally scrolling rows.
      if (!scroller || !visible(scroller) || !scrollable(scroller) || !overflows(scroller)) {
        // Prefer the element that really overflows: a wrapper allowed to scroll
        // but too short to move (full screen) must not be the one watched.
        const candidates = Array.from(area.querySelectorAll<HTMLElement>("*")).filter(element =>
          visible(element) && scrollable(element));
        scroller = candidates.find(overflows) ?? candidates[0] ?? null;
      }
      const top = scroller?.scrollTop ?? 0;
      const room = scroller ? scroller.scrollHeight - scroller.clientHeight : 0;
      // Feishin's 200px, or half of what the page can scroll when it can't reach it.
      // A page whose own title row sits in the bar's row (Explore) hands its title
      // to the bar the moment the solid ground would cut through it.
      const ownTitle = !!scroller?.querySelector(":scope > header:first-child h1");
      const point = ownTitle ? 0
        : room > 0 ? Math.min(SHELL_SCROLL_THRESHOLD_PX, Math.max(1, Math.floor(room / 2))) : SHELL_SCROLL_THRESHOLD_PX;
      reveal(top > point, top > 0);
      const actions = bar.querySelector<HTMLElement>(".library-search") ?? bar.querySelector<HTMLElement>(".app-header__actions");
      const barBox = bar.getBoundingClientRect();
      if (actions) shell.style.setProperty("--topbar-controls-width", `${Math.ceil(barBox.right - actions.getBoundingClientRect().left)}px`);
      const height = bar.getBoundingClientRect().height || HEADER_HEIGHT_PX;
      shell.style.setProperty("--topbar-height", `${height}px`);
    };
    const schedule = () => {
      if (!disposed && frame === null) frame = requestAnimationFrame(check);
    };
    const onScroll = (event: Event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement) || !visible(target)) return;
      // Resolve overflow and the actual position once in the next frame.
      pendingTarget = target;
      schedule();
    };
    schedule();
    area.addEventListener("scroll", onScroll, { passive: true, capture: true });
    window.addEventListener("resize", schedule);
    document.addEventListener("visibilitychange", schedule);
    void document.fonts?.ready.then(schedule);
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    resize?.observe(bar);
    resize?.observe(area);
    const mounts = new MutationObserver(schedule);
    mounts.observe(area, { childList: true, subtree: true });
    return () => {
      disposed = true;
      if (frame !== null) cancelAnimationFrame(frame);
      area.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", schedule);
      document.removeEventListener("visibilitychange", schedule);
      resize?.disconnect();
      mounts.disconnect();
      reveal(false);
      shell.style.removeProperty("--topbar-height");
      shell.style.removeProperty("--topbar-controls-width");
    };
  }, [headerRef, pageKey, floating]);
}
