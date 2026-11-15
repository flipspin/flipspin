import React, { createContext, useContext, useState, useEffect } from "react";

export interface SettingsContextValue {
  vlcIp: string;
  setVlcIp: React.Dispatch<React.SetStateAction<string>>;
  theme: string;
  setTheme: (theme?: string) => void;
  mode: string;
  setMode: React.Dispatch<React.SetStateAction<string>>;
}

const SettingsContext = createContext<SettingsContextValue | null>(null);

const STORAGE_VLC = "vlcIp";
// Keys of settings for features that are gone (FTP to the phone, the QR
// share's phone folder); cleared on load so an FTP password does not linger.
const RETIRED_KEYS = ["ftpUrl", "ftpPassword", "phoneDownloadPath"];
const STORAGE_THEME = "theme";
// Paper has three modes, persisted independently from the retired palette key.
const STORAGE_MODE = "krobi.mode";
// eslint-disable-next-line react-refresh/only-export-components
export const MODES = ["light", "dark", "night"];
const DEFAULT_THEME = "paper";

export { THEMES } from "../ui/tokens/themes";
const setTheme = (_theme?: string) => {};

export function SettingsProvider({ children }: { children: React.ReactNode }) {
  const [vlcIp, setVlcIp] = useState(() => {
    if (typeof localStorage === "undefined") return "";
    return localStorage.getItem(STORAGE_VLC) || "";
  });
  const [mode, setMode] = useState(() => {
    if (typeof localStorage === "undefined") return "light";
    const saved = localStorage.getItem(STORAGE_MODE);
    return saved !== null && MODES.includes(saved) ? saved : "light";
  });

  useEffect(() => {
    try { localStorage.setItem(STORAGE_MODE, mode); } catch { /* private mode */ }
    if (typeof document !== "undefined") {
      document.documentElement.setAttribute("data-mode", mode);
    }
  }, [mode]);

  // Migrate every saved palette (picnic/baker/ocean/tropical/matcha) silently.
  // The native API cannot delete a preference, so replace its old value with Paper.
  useEffect(() => {
    try { localStorage.removeItem(STORAGE_THEME); } catch { /* private mode */ }
    document.documentElement.setAttribute("data-theme", DEFAULT_THEME);
    const api = window.desktopAPI;
    if (!api?.getTheme) return;
    let cancelled = false;
    api.getTheme().then((saved) => {
      if (!cancelled && saved && saved !== DEFAULT_THEME) return api.setTheme?.(DEFAULT_THEME);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // One stored value: "Send to → VLC" saves it, Settings → This computer shows,
  // changes or forgets it (an empty address removes the key).
  useEffect(() => {
    try {
      if (vlcIp) localStorage.setItem(STORAGE_VLC, vlcIp);
      else localStorage.removeItem(STORAGE_VLC);
    } catch { /* private mode */ }
  }, [vlcIp]);

  useEffect(() => {
    try { RETIRED_KEYS.forEach((key) => localStorage.removeItem(key)); } catch { /* private mode */ }
  }, []);

  const value = {
    vlcIp, setVlcIp,
    theme: DEFAULT_THEME, setTheme,
    mode, setMode,
  };
  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useSettings() {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error("useSettings must be used within SettingsProvider");
  return ctx;
}
