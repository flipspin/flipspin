const DATE_FORMATTER = new Intl.DateTimeFormat("es-ES", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export function formatDuration(seconds: unknown) {
  if (typeof seconds !== "number" || isNaN(seconds)) return "--:--";
  const min = Math.floor(seconds / 60);
  const sec = Math.round(seconds % 60);
  return `${min}:${sec.toString().padStart(2, "0")}`;
}

export function formatDate(timestamp: number | string | null | undefined) {
  if (!timestamp) return "--";
  return DATE_FORMATTER.format(new Date(Number(timestamp) * 1000));
}

export function formatTime(s: number | null | undefined) {
  if (!s || Number.isNaN(s)) return "00:00";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m.toString().padStart(2, "0")}:${sec.toString().padStart(2, "0")}`;
}
