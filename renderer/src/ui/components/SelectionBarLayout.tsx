import { useState, type ReactNode } from "react";
import { SelectionBarDockContext } from "./selectionBarDock";
import "./selection-bar.css";

/** A dock outside the page scroller, bounded by the shell's main content. */
export default function SelectionBarLayout({ children }: { children: ReactNode }) {
  const [dock, setDock] = useState<HTMLDivElement | null>(null);
  return (
    <SelectionBarDockContext.Provider value={dock}>
      <div className="selection-bar-layout">
        {children}
        <div ref={setDock} className="selection-bar-dock" />
      </div>
    </SelectionBarDockContext.Provider>
  );
}
