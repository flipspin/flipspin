import React, { createContext, useContext, useState, useCallback, useRef } from "react";
import { dismissNotification, notify } from "../ui/notifications";

export type StatusLevel = "info" | "success" | "error";
export interface StatusContextValue {
  status: { message: string; type: StatusLevel } | null;
  showInfo: (message: unknown) => void;
  showSuccess: (message: unknown) => void;
  showError: (message: unknown) => void;
  clear: () => void;
}

const StatusContext = createContext<StatusContextValue | null>(null);

/**
 * The legacy status API (showSuccess / showError / showInfo), kept for its ~15
 * callers, drawn by the one notification channel (`ui/notifications`).
 * One slot, as before: a new message replaces the previous one this provider
 * raised, and `clear` dismisses it. Errors stay until dismissed; the rest
 * expire (the channel's rules).
 */
export function StatusProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<StatusContextValue["status"]>(null);
  const shown = useRef<ReturnType<typeof notify> | null>(null);

  const show = useCallback((type: StatusLevel, message: unknown) => {
    if (shown.current) dismissNotification(shown.current);
    shown.current = notify({ level: type, message: String(message) });
    setStatus({ message: String(message), type });
  }, []);

  const showInfo = useCallback((message: unknown) => show("info", message), [show]);
  const showSuccess = useCallback((message: unknown) => show("success", message), [show]);
  const showError = useCallback((message: unknown) => show("error", message), [show]);

  const clear = useCallback(() => {
    if (shown.current) dismissNotification(shown.current);
    shown.current = null;
    setStatus(null);
  }, []);

  const value = { status, showInfo, showSuccess, showError, clear };
  return (
    <StatusContext.Provider value={value}>
      {children}
    </StatusContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useStatus() {
  const ctx = useContext(StatusContext);
  if (!ctx) throw new Error("useStatus must be used within StatusProvider");
  return ctx;
}

export { StatusContext };
