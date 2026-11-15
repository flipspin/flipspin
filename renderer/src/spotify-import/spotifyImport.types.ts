import type { ApiData, ApiDataOr } from "../data/http";
import type { SchemaExportTrackRef } from "../api/generated/schema";

export type ParsedExport = ApiData<"/api/playlists/spotify-export/parse", "post">;
export type ExportPlaylist = ParsedExport["playlists"][number];
type RawMatch = ApiData<"/api/playlists/spotify-export/resolve/{progress_id}", "get">["results"][string][number];
// Match rows deliberately have open schema fields; validate the subset displayed/imported.
export type ImportMatch = RawMatch & {
  confidence?: string;
  explanation?: string | null;
  wanted?: Partial<SchemaExportTrackRef>;
  match?: (Partial<SchemaExportTrackRef> & { reasons?: string[]; distance?: number }) | null;
};
export type ProgressSnapshot = ApiDataOr<"/api/download-progress/{progress_id}", "get", {
  total?: number;
  completed?: number;
  done?: string[];
  active?: Record<string, { phase?: string; percent?: number }>;
  status?: string;
  terminal?: boolean;
}>;
export type ImportProgress = ProgressSnapshot & {
  phase?: "resolve" | "import";
  id?: string | null;
  label?: string;
  startedAt?: number;
};
export type ImportSummary = {
  id?: string;
  name: string;
  kind: "downloaded" | "downloading" | "background" | "skipped" | "empty";
  accepted: number;
  downloaded: number;
  status?: string;
};
export type QueuePosition = { index: number; total: number } | null;
export type ImportState = {
  step: "drop" | "picking" | "resolving" | "review" | "importing" | "summary";
  file: { name: string; size: number } | null;
  parsing: boolean;
  parsed: ParsedExport | null;
  selected: string[];
  queue: ExportPlaylist[];
  queueIndex: number;
  progress: ImportProgress | null;
  results: ImportMatch[] | null;
  accepted: boolean[];
  summaries: ImportSummary[];
  error: string | null;
  notice: string | null;
};
