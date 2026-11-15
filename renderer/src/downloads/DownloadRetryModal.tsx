import { useState, useSyncExternalStore, type FormEvent } from "react";
import { Download, Loader2, Search } from "lucide-react";
import { useTranslation } from "react-i18next";
import { formatTime } from "@lib/formatting";
import { apiPost, serverDetail } from "../data";
import type { components } from "../api/generated/schema";
import PanelModal from "../ui/components/PanelModal";
import { useHeld } from "../ui/react/useHeld";
import { closeRetry, getState, markRetried, subscribe } from "./downloadsStore";

type Result = components["schemas"]["YouTubeSearchResult"];

export interface RetryFailure {
  index: number;
  item: string;
  title: string | null;
  artist: string | null;
  durationS: number | null;
  query: string | null;
  kind: string;
  reason: string | null;
  suggestions: string[];
}

// Within this many seconds of the wanted length, a result reads as the same
// recording; the backend's own duration veto is in the same range.
const CLOSE_S = 10;

/** Looser YouTube searches can find another cut or a reaction video.
 * Require the user to choose both the query and the video before downloading. */
export default function DownloadRetryModal() {
  const snapshot = useSyncExternalStore(subscribe, getState);
  const current = snapshot.retry;
  // Held so the sheet keeps its content while it animates out.
  const target = useHeld(current);
  if (!target) return null;
  // Keyed so a second failure opens on a clean sheet, not the last one's results.
  return <RetrySheet key={`${target.jobId}:${target.failure.index}`} open={current != null} failure={target.failure} onClose={closeRetry} onPick={async url => {
    const body = await apiPost('/api/downloads/retry', { body: { progress_id: target.jobId, index: target.failure.index, youtube_url: url } });
    markRetried(target.jobId, target.failure.index, body.progress_id, body.label);
  }} />;
}

export function RetrySheet({ open, failure, onPick, onClose }: { open: boolean; failure: RetryFailure; onPick: (url: string) => Promise<void>; onClose: () => void }) {
  const { t } = useTranslation();
  const suggestions = failure.suggestions?.length ? failure.suggestions : [failure.query || failure.item];
  const [query, setQuery] = useState(suggestions[1] ?? suggestions[0]);
  const [searched, setSearched] = useState<string | null>(null);
  const [results, setResults] = useState<Result[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [starting, setStarting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const search = async (q: string) => {
    const text = q.trim();
    if (!text) return;
    setQuery(text);
    setSearching(true);
    setError(null);
    try {
      const body = await apiPost("/api/downloads/youtube-search", { body: { query: text, limit: 10 } });
      setSearched(body.query);
      setResults(body.results);
    } catch (e) {
      setResults(null);
      setError(serverDetail(e) || t("The YouTube search failed. Try again."));
    } finally {
      setSearching(false);
    }
  };

  const pick = async (result: Result) => {
    setStarting(result.url);
    setError(null);
    try {
      await onPick(result.url);
      onClose();
    } catch (e) {
      setError(serverDetail(e) || t("Could not start the download."));
      setStarting(null);
    }
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void search(query);
  };

  const wanted = [failure.artist, failure.durationS ? formatTime(failure.durationS) : null].filter(Boolean).join(" · ");

  return (
    <PanelModal
      open={open}
      title={t("Search another way")}
      width="max-w-xl"
      onClose={onClose}
      toolbar={
        <div className="flex flex-col gap-2.5">
          <strong className="text-[14px]">{failure.title || failure.item}</strong>
          <p className="text-[12.5px] text-[var(--ink-2)]">
            {whyText(t, failure)}
            {wanted ? <span className="text-[var(--ink-3)]"> {t("Looking for: {{wanted}}.", { wanted })}</span> : null}
          </p>
          <span className="text-[11px] font-extrabold uppercase text-[var(--ink-3)]">{t("Suggested searches")}</span>
          <div className="flex flex-wrap gap-1.5" role="group" aria-label={t("Suggested searches")}>
            {suggestions.map((s, i) => (
              <button
                key={s}
                type="button"
                onClick={() => void search(s)}
                disabled={searching}
                title={i === 0 ? t("The search that failed") : undefined}
                className={`k-btn k-btn--text${searched === s ? " k-btn--text-primary" : ""}`}
                aria-pressed={searched === s}
              >
                {s}
              </button>
            ))}
          </div>
          <form className="flex gap-2" onSubmit={onSubmit}>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              maxLength={200}
              aria-label={t("Search YouTube")}
              placeholder={t("Type your own search")}
              className="k-field flex-1"
            />
            <button
              type="submit"
              disabled={searching || !query.trim()}
              className="k-btn k-btn--text k-btn--text-primary"
            >
              {searching ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} strokeWidth={2.5} />}
              {t("Search")}
            </button>
          </form>
        </div>
      }
    >
      {error ? (
        <p role="alert" className="m-3 text-[12.5px] text-[var(--fg-rose)]">
          {error}
        </p>
      ) : null}
      {results === null ? (
        <p className="p-6 text-center text-[13px] text-[var(--ink-3)]">
          {searching ? t("Searching YouTube…") : t("Pick a search above or type your own.")}
        </p>
      ) : results.length === 0 ? (
        <p className="p-6 text-center text-[13px] text-[var(--ink-3)]">
          {t("YouTube returned nothing for “{{q}}”. Try another.", { q: searched })}
        </p>
      ) : (
        <ul className="list-none m-0 p-0">
          {results.map((r) => {
            const delta = failure.durationS && r.duration ? Math.round(r.duration - failure.durationS) : null;
            const close = delta !== null && Math.abs(delta) <= CLOSE_S;
            return (
              <li key={r.url} className="border-b-2 border-black/20 last:border-b-0 px-3 py-2 flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <div className="truncate text-[13px] font-bold" title={r.title || r.url}>{r.title || r.url}</div>
                  <div className="truncate text-[11.5px] text-[var(--ink-3)]">
                    {[r.uploader, r.duration ? formatTime(r.duration) : null].filter(Boolean).join(" · ")}
                    {delta !== null ? (
                      <span className="ml-1.5 font-mono" style={{ color: close ? "var(--green)" : "var(--coral)" }}>
                        {delta === 0 ? "±0 s" : `${delta > 0 ? "+" : "−"}${Math.abs(delta)} s`}
                      </span>
                    ) : null}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => void pick(r)}
                  disabled={starting !== null}
                  className="k-btn k-btn--text k-btn--text-primary shrink-0"
                >
                  {starting === r.url ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} strokeWidth={2.5} />}
                  {t("Download_verb")}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </PanelModal>
  );
}

function whyText(t: (key: string, opts?: Record<string, unknown>) => string, failure: RetryFailure): string {
  switch (failure.kind) {
    case "no-results":
      return t("YouTube returned no results for “{{q}}”.", { q: failure.query || failure.item });
    case "rejected":
      return t("No result was this song: a different length or version.");
    case "download":
      return t("The chosen video could not be downloaded.");
    case "auth":
      return t("YouTube asked to confirm you're not a robot. Check Settings → Sources → YouTube.");
    default:
      return t("The download failed.");
  }
}
