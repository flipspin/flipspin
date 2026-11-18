import React from "react";
import { matchRanges } from "../../search/match";

/** Highlight each query word using the same accent folding as library matching. */
export function highlightMatches(text: string, query: string): React.ReactNode {
  if (!text) return text;
  const ranges = matchRanges(text, query);
  if (!ranges.length) return text;
  const parts: React.ReactNode[] = [];
  let end = 0;
  for (const [start, stop] of ranges) {
    parts.push(text.slice(end, start));
    parts.push(<span key={start} className="bg-[var(--coral)] text-white">{text.slice(start, stop)}</span>);
    end = stop;
  }
  parts.push(text.slice(end));
  return parts;
}
