import React, { createContext, useContext, useState } from "react";

export interface PlayerWindowContextValue {
  playerWindowOpen: boolean;
  setPlayerWindowOpen: React.Dispatch<React.SetStateAction<boolean>>;
}

const PlayerWindowContext = createContext<PlayerWindowContextValue | null>(null);

export function PlayerWindowProvider({ children }: { children: React.ReactNode }) {
  const [playerWindowOpen, setPlayerWindowOpen] = useState(false);
  return (
    <PlayerWindowContext.Provider value={{ playerWindowOpen, setPlayerWindowOpen }}>
      {children}
    </PlayerWindowContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function usePlayerWindow() {
  const ctx = useContext(PlayerWindowContext);
  if (!ctx) throw new Error("usePlayerWindow must be used within PlayerWindowProvider");
  return ctx;
}
