import { useLayoutEffect, type MutableRefObject } from "react";
import { logger } from "../lib/logger";

/** Log slow switches as click-to-commit, next-frame and final-DOM-settle timings.
 * Retain diagnostic field names for comparing logs; settle waits for 400ms quiet and stops at 8s. */
export function usePageSwitchLog(page: string, started: MutableRefObject<{ page: string; at: number } | null>): void {
  useLayoutEffect(() => {
    const begun = started.current;
    if (!begun || begun.page !== page) return;
    started.current = null;
    const committed = performance.now() - begun.at;
    let painted = 0;
    requestAnimationFrame(() => requestAnimationFrame(() => { painted = performance.now() - begun.at; }));
    const main = document.querySelector("main.k-page") ?? document.body;
    let last = performance.now();
    let rows = 0;
    const observer = new MutationObserver(() => { last = performance.now(); });
    observer.observe(main, { childList: true, subtree: true, characterData: true });
    const check = window.setInterval(() => {
      const now = performance.now();
      if (now - last < 400 && now - begun.at < 8000) return;
      window.clearInterval(check); observer.disconnect();
      rows = main.querySelectorAll(".retro-song-table__row").length;
      const ready = last - begun.at;
      if (ready > 150 || painted > 150) logger.debug(`Página ${page} · render ${Math.round(committed)} ms · pintada ${Math.round(painted)} ms · lista ${Math.round(ready)} ms · ${rows} filas`);
    }, 100);
    return () => { window.clearInterval(check); observer.disconnect(); };
  }, [page, started]);
}
