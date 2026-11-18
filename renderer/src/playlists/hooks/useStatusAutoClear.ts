import { useEffect } from "react";

type Status = { message?: string; type?: string } | null;

/**
 * How long a status message stays up on the Playlists page: errors and the
 * download/added notices 4 s, the rest 2 s, and the "searching" progress notice
 * until something replaces it.
 */
export function statusLifetime(status: Status): number | null {
  if (!status?.message) return null;
  const msg = status.message.toLowerCase();
  if (msg.includes("buscando pistas") || msg.includes("buscando canciones")) return null;
  if (status.type === "error") return 4000;
  return msg.includes("descargando") || msg.includes("agregadas") ? 4000 : 2000;
}

export function useStatusAutoClear(status: Status, clear: () => void) {
  useEffect(() => {
    const duration = statusLifetime(status);
    if (duration == null) return;
    const timer = setTimeout(clear, duration);
    return () => clearTimeout(timer);
  }, [status, clear]);
}
