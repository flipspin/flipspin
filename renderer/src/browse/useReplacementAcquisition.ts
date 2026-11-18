/** Explicit version replacements retain their atomic replace protocol. */
import type { Context } from "react";
import type { StatusActions } from "./cards.types";
import type { ApiDataOr } from "../data";
import type { BrowseTrack } from "./browse.types";
import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { apiUrl } from "@lib/api";
import { load as reloadUserLibrary } from "@state/userLibraryStore";

import { report as reportDownload, track as trackDownload } from "../downloads/downloadsStore";
import { acquireReplacementTracks as acquireTracks } from "./browseApi";
import { announceLibraryChanged, replacementLanded } from "./resolve";
import { StatusContext } from "@state/StatusContext";

// The legacy stream has no response model. Its consumed fields are checked
// before publishing a snapshot or a terminal callback.
type Snapshot = ApiDataOr<"/api/download-progress-stream/{progress_id}", "get", {
  terminal?: boolean; total?: number; completed?: number; succeeded?: number;
  failed?: number; percentage?: number; active?: Record<string, { phase?: string }>;
}>;
type Finished = (snapshot: Snapshot | null, tracks: BrowseTrack[]) => void;
type State = { active: boolean; total: number; completed: number; percent: number; phase: string | null; error: Error | null };
const IDLE: State = { active: false, total: 0, completed: 0, percent: 0, phase: null, error: null };

export function useReplacementAcquisition(onFinished?: Finished) {
  const { t } = useTranslation();
  // Read the optional context so plugin pages without a status provider can still acquire tracks.
  const showSuccess = useContext(StatusContext as Context<StatusActions | null>)?.showSuccess;
  const [state, setState] = useState(IDLE);
  // Keep dedupe results separate because progress snapshots replace the state object.
  const [hit, setHit] = useState({ alreadyPresent: 0, linked: false });
  const sourceRef = useRef<EventSource | null>(null);
  const finishedRef = useRef(onFinished);
  finishedRef.current = onFinished;
  const tracksRef = useRef<BrowseTrack[]>([]);

  const close = useCallback(() => {
    sourceRef.current?.close();
    sourceRef.current = null;
  }, []);

  useEffect(() => close, [close]);

  const watch = useCallback(
    (progressId: string, total: number) => {
      close();
      const source = new EventSource(apiUrl(`/api/download-progress-stream/${progressId}`));
      sourceRef.current = source;

      source.onmessage = (event) => {
        let snapshot: unknown;
        try {
          snapshot = JSON.parse(event.data);
        } catch {
          return;
        }
        if (!isSnapshot(snapshot)) return;
        // Publish the active phase so slow tagging remains distinguishable from a stalled job.
        reportDownload(progressId, snapshot);
        const activeEntries = Object.values(snapshot.active || {});
        setState({
          active: !snapshot.terminal,
          total: snapshot.total ?? total,
          completed: snapshot.completed ?? 0,
          percent: snapshot.percentage ?? 0,
          phase: activeEntries[0]?.phase || null,
          error: null,
        });
        if (snapshot.terminal) {
          close();
          // Use succeeded/failed for outcomes: completed counts attempts, including failures.
          // Keep the count-difference fallback for older servers.
          const done = snapshot.completed ?? 0;
          const want = snapshot.total ?? total;
          const failed = snapshot.failed ?? Math.max(0, want - done);
          setState({
            active: false,
            total: want,
            completed: snapshot.succeeded ?? done,
            percent: snapshot.percentage ?? 0,
            phase: null,
            error: failed
              ? new Error(
                  // AcquireBar supplies the failure heading; return only its explanation.
                  failed === want
                    ? t("YouTube rejected the request, or no result passed the duration filter.")
                    : t("{{failed}} of {{total}} could not be downloaded.", { count: failed, failed, total: want }),
                )
              : null,
          });
          if (replacementLanded(snapshot, tracksRef.current)) {
            announceLibraryChanged();
            showSuccess?.(t("Version swapped."));
          }
          finishedRef.current?.(snapshot, tracksRef.current);
          void reloadUserLibrary();
          return;
        }
      };

      // A dropped stream stops observation; it does not prove that the download failed.
      source.onerror = () => {
        close();
        setState((prev) => ({ ...prev, active: false }));
        finishedRef.current?.(null, tracksRef.current);
      };
    },
    [close, t, showSuccess],
  );

  const acquire = useCallback(
    async (tracks: BrowseTrack[], options?: Parameters<typeof acquireTracks>[1]) => {
      if (!tracks?.length) return;
      tracksRef.current = tracks;
      setState({ ...IDLE, active: true, total: tracks.length });
      setHit({ alreadyPresent: 0, linked: false });
      try {
        const result = await acquireTracks(tracks, options || {});
        const alreadyPresentCount = Array.isArray(result.alreadyPresent) ? result.alreadyPresent.length : 0;
        // Only user linking creates account rows; skipped linking must not claim a personal save.
        setHit({ alreadyPresent: alreadyPresentCount, linked: result.linking === "user" });

        // Skip watching zero-track receipts so deduplication cannot create empty download rows.
        if (!result.total) {
          setState({ ...IDLE, active: false, percent: 100 });
          void reloadUserLibrary();
          finishedRef.current?.(null, tracksRef.current);
          return;
        }
        // Share job visibility while retaining this stream for terminal ownership refreshes.
        trackDownload({
          id: result.progress_id!,
          // Label one track by title and a batch by source so progress identifies the requested work.
          label:
            tracks.length === 1
              ? tracks[0]?.title || t("Download")
              : options?.folder || tracks[0]?.albumTitle || t("{{n}} songs", { count: tracks.length, n: tracks.length }),
          source: "DZ",
          total: result.total,
          selfStreamed: true,
        });
        watch(result.progress_id!, result.total);
      } catch (e) {
        setState({ ...IDLE, error: e instanceof Error ? e : new Error(String(e)) });
      }
    },
    [watch, t],
  );

  return { ...state, ...hit, acquire };
}

function isSnapshot(value: unknown): value is Snapshot {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  if (["total", "completed", "succeeded", "failed", "percentage"].some(key => row[key] != null && typeof row[key] !== "number")) return false;
  if (row.terminal != null && typeof row.terminal !== "boolean") return false;
  if (row.active == null) return true;
  return typeof row.active === "object" && !Array.isArray(row.active) && Object.values(row.active).every(entry =>
    typeof entry === "object" && entry !== null && (!("phase" in entry) || entry.phase == null || typeof entry.phase === "string"));
}
