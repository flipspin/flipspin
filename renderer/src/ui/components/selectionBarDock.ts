import { createContext, useContext } from "react";

export const SelectionBarDockContext = createContext<HTMLDivElement | null>(null);
export const useSelectionBarDock = () => useContext(SelectionBarDockContext);
