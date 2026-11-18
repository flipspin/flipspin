import type { ReactNode } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

/** The library album's titled fold, also used by search result panels. */
export default function SectionFoldButton({ title, count, open, onToggle, controls, className = "album-more__head" }: {
  title: ReactNode; count?: number; open: boolean; onToggle: () => void; controls?: string; className?: string;
}) {
  return <button type="button" className={className} aria-expanded={open} aria-controls={controls} onClick={onToggle}>
    <span>{title}</span>
    {count != null && <> <span className="album-more__count">{count}</span></>}
    {open ? <ChevronDown size={16} aria-hidden /> : <ChevronRight size={16} aria-hidden />}
  </button>;
}
