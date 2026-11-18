/* krobi-ui; AGPL-3.0; see LICENSE. */
import { useEffect, useState, type RefObject } from "react";

function longestAnimation(element: HTMLElement) {
  const style = getComputedStyle(element);
  const durations = style.animationDuration.split(",").map((value) => {
    const trimmed = value.trim();
    return Number.parseFloat(trimmed) * (trimmed.endsWith("ms") ? 1 : 1000);
  });
  // An engine that reports no duration ("" → NaN) has nothing to wait for.
  return Math.max(0, ...durations.filter((value) => Number.isFinite(value)));
}

/** Keeps a closing layer mounted until its CSS exit animation finishes. */
export function usePresence(ref: RefObject<HTMLElement | null>, open: boolean) {
  const [mounted, setMounted] = useState(open);

  useEffect(() => {
    if (open) setMounted(true);
  }, [open]);

  useEffect(() => {
    if (open || !mounted) return;
    const element = ref.current;
    if (!element || longestAnimation(element) === 0) {
      setMounted(false);
      return;
    }
    const finish = (event: AnimationEvent) => {
      if (event.target === element) setMounted(false);
    };
    element.addEventListener("animationend", finish);
    return () => element.removeEventListener("animationend", finish);
  }, [mounted, open, ref]);

  return { mounted: open || mounted, state: open ? "open" : "closed" } as const;
}
