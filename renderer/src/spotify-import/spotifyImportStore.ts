/** Own import state and progress streams outside React so long jobs survive navigation.
 * Close streams on replacement, cancellation, reset or window teardown, not page unmount. */
import type { ImportMatch, ImportState, ImportSummary, ParsedExport, ProgressSnapshot } from "./spotifyImport.types";
import { apiUrl } from "@lib/api";
import { legacyErrorText } from "@lib/legacyErrorText";
import { apiGet, apiPost } from "../data";
import { APP_NAME } from "../brand";
// No component here, so prose is produced with the instance at the moment it
// is set on the state; never captured at module scope.
import i18n from "../i18n";

const PARSE_ENDPOINT = "/api/playlists/spotify-export/parse";
const RESOLVE_ENDPOINT = "/api/playlists/spotify-export/resolve";
const IMPORT_ENDPOINT = "/api/playlists/spotify-export/import";
// Shared progress stream; keyed purely by progress_id, so it serves any
// long-running backend job (see downloads/routes.py: stream_download_progress).
const PROGRESS_STREAM = "/api/download-progress-stream";

// Progress has no response model; match rows have intentionally open fields.
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isProgressSnapshot(value: unknown): value is ProgressSnapshot {
  if (!isRecord(value)) return false;
  return ["total", "completed"].every(key => value[key] === undefined || typeof value[key] === "number")
    && (value.status === undefined || typeof value.status === "string")
    && (value.terminal === undefined || typeof value.terminal === "boolean")
    && (value.done === undefined || (Array.isArray(value.done) && value.done.every(item => typeof item === "string")))
    && (value.active === undefined || (isRecord(value.active) && Object.values(value.active).every(item =>
      isRecord(item) && (item.phase === undefined || typeof item.phase === "string")
      && (item.percent === undefined || typeof item.percent === "number"))));
}

function isTrackFields(value: unknown): value is NonNullable<ImportMatch["match"]> {
  return isRecord(value)
    && ["title", "artist", "album", "isrc", "mbid", "recordingMbid", "coverUrl", "provider", "providerId"].every(key => value[key] == null || typeof value[key] === "string")
    && (value.durationSeconds == null || typeof value.durationSeconds === "number")
    && (value.distance === undefined || typeof value.distance === "number")
    && (value.reasons === undefined || (Array.isArray(value.reasons) && value.reasons.every(item => typeof item === "string")));
}

function isImportMatch(value: unknown): value is ImportMatch {
  return isRecord(value)
    && (value.confidence === undefined || typeof value.confidence === "string")
    && (value.explanation == null || typeof value.explanation === "string")
    && (value.wanted === undefined || isTrackFields(value.wanted))
    && (value.match == null || isTrackFields(value.match));
}

function isParsedExport(value: unknown): value is ParsedExport {
  // The multipart response is modelled in OpenAPI; retain the existing playlists check.
  return isRecord(value) && Array.isArray(value.playlists);
}

const EMPTY_PROGRESS = null;

const initialState: ImportState = {
  step: "drop",
  /** { name, size } of the dropped archive; never the File itself. */
  file: null,
  parsing: false,
  /** Backend parse payload: { playlistCount, trackCount, warnings, playlists }. */
  parsed: null,
  /** Names of the playlists the user ticked in step 2. */
  selected: [],
  /** The playlists being worked through, one at a time. */
  queue: [],
  queueIndex: 0,
  /** Live stream snapshot: { phase, id, total, completed, done, active, status, startedAt, label }. */
  progress: EMPTY_PROGRESS,
  /** Resolve results for the current playlist: [{ wanted, confidence, explanation, match }]. */
  results: null,
  /** Parallel to `results`: which rows the user accepts. */
  accepted: [],
  /** One entry per finished playlist: { name, kind, accepted, downloaded }. */
  summaries: [],
  error: null,
  notice: null,
};

let state = initialState;
const listeners = new Set<() => void>();
/** The single in-flight EventSource. Owned by the module; see the file header. */
let source: EventSource | null = null;

export function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function getState() {
  return state;
}

function set(patch: Partial<ImportState>) {
  state = { ...state, ...patch };
  listeners.forEach((listener) => listener());
}

function closeStream() {
  if (source) {
    source.close();
    source = null;
  }
}

/**
 * One stream per playlist download, kept apart from `source` (the screen's
 * current resolve). A download goes on when the person moves to the next
 * playlist, so its summary row keeps counting instead of freezing.
 */
const downloadSources = new Map<string, EventSource>();

function closeDownloads() {
  for (const opened of downloadSources.values()) opened.close();
  downloadSources.clear();
}

function patchSummary(id: string, patch: Partial<ImportSummary>) {
  set({ summaries: state.summaries.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry)) });
}

function trackDownload(progressId: string) {
  const opened = new EventSource(apiUrl(`${PROGRESS_STREAM}/${encodeURIComponent(progressId)}`));
  downloadSources.set(progressId, opened);
  let last: ProgressSnapshot | null = null;
  const watching = () => state.step === "importing" && state.progress?.id === progressId;

  const finish = () => {
    opened.close();
    downloadSources.delete(progressId);
    // Tell the sidebar to reload its playlist list.
    window.dispatchEvent(new CustomEvent("playlists-changed"));
    patchSummary(progressId, {
      kind: "downloaded",
      downloaded: (last?.done || []).length,
      // The backend's own terminal summary, e.g. "Downloaded 5/5 tracks".
      status: last?.status || "",
    });
    if (watching()) set({ step: "summary", progress: { ...state.progress, status: last?.status || "done" } });
  };

  opened.onmessage = (event) => {
    let snapshot: unknown;
    try {
      snapshot = JSON.parse(event.data);
    } catch {
      return;
    }
    if (!isProgressSnapshot(snapshot)) return;
    last = snapshot;
    const completed = snapshot.completed ?? (snapshot.done || []).length;
    patchSummary(progressId, snapshot.total ? { downloaded: completed, accepted: snapshot.total } : { downloaded: completed });
    if (watching()) {
      set({
        progress: {
          ...state.progress,
          total: snapshot.total || 0,
          completed,
          done: snapshot.done || [],
          active: snapshot.active || {},
          status: snapshot.status || "in_progress",
        },
      });
    }
    if (snapshot.terminal) finish();
  };
  opened.addEventListener("end", finish);
  opened.onerror = () => {
    opened.close();
    downloadSources.delete(progressId);
    if (!last?.terminal) {
      patchSummary(progressId, { kind: "background" });
      if (watching()) set({ error: i18n.t("The connection to your nest was lost during the process.") });
    }
  };
}

if (typeof window !== "undefined") {
  // The stream deliberately outlives the component, so the only thing left to
  // clean it up is the window itself.
  window.addEventListener("pagehide", closeStream);
}

/**
 * Turn a thrown fetch failure into something a user can act on. A dead backend
 * surfaces as a TypeError ("Failed to fetch") with no status, which would
 * otherwise reach the UI as gibberish.
 */
function friendlyError(error: unknown) {
  const message = legacyErrorText(error);
  if (/failed to fetch|networkerror|load failed|ECONNREFUSED|fetch failed/i.test(message)) {
    return i18n.t("Couldn't connect to {{app}}. Check that your nest is on and try again.", { app: APP_NAME });
  }
  return message || i18n.t("An unexpected error occurred.");
}

/** The resolve/import endpoints answer with a progress id; anything else is a bug. */
function requireProgressId(data: unknown) {
  const fields = isRecord(data) ? data : {};
  const id = fields.progress_id || fields.progressId;
  if (typeof id !== "string" || !id) throw new Error(i18n.t("Your nest didn't return a progress id."));
  return id;
}

/** Flatten confidence groups while preserving their internal order.
 * Read partial results after cancellation so completed matches remain reviewable. */
async function fetchResults(progressId: string) {
  const data = await apiGet("/api/playlists/spotify-export/resolve/{progress_id}", {
    params: { path: { progress_id: progressId } },
  });
  const grouped = data?.results;
  const results = Array.isArray(grouped)
    ? grouped
    : ["strong", "review", "rejected"].flatMap((bucket) =>
        Array.isArray(grouped?.[bucket]) ? grouped[bucket] : [],
      );
  return {
    results: results.filter(isImportMatch),
    status: data?.status || "done",
    error: data?.error || null,
    total: data?.total ?? results.length,
    resolved: data?.resolved ?? results.length,
  };
}

/**
 * Watch a background job over SSE. Same disposer pattern as
 * `downloadsStore.track`: any prior stream is torn down first, the stream closes
 * itself on the terminal snapshot, and an error closes it too so EventSource
 * doesn't silently reconnect forever against an unknown id.
 */
function streamProgress(progressId: string, { onDone }: { onDone?: (snapshot: ProgressSnapshot | null) => void } = {}) {
  closeStream();

  const opened = new EventSource(apiUrl(`${PROGRESS_STREAM}/${encodeURIComponent(progressId)}`));
  source = opened;
  let last: ProgressSnapshot | null = null;

  const finish = () => {
    opened.close();
    if (source === opened) source = null;
    onDone?.(last);
  };

  opened.onmessage = (event) => {
    let snapshot: unknown;
    try {
      snapshot = JSON.parse(event.data);
    } catch {
      return;
    }
    if (!isProgressSnapshot(snapshot)) return;
    last = snapshot;
    set({
      progress: {
        ...state.progress,
        id: progressId,
        total: snapshot.total || 0,
        completed: snapshot.completed ?? (snapshot.done || []).length,
        done: snapshot.done || [],
        active: snapshot.active || {},
        status: snapshot.status || "in_progress",
      },
    });
    if (snapshot.terminal) finish();
  };

  // The backend emits a named `end` event if the tracker entry disappears.
  opened.addEventListener("end", finish);

  opened.onerror = () => {
    opened.close();
    if (source === opened) source = null;
    // Only a mid-flight drop is worth reporting; a close right after the
    // terminal snapshot is the normal shutdown.
    if (!last?.terminal) {
      set({ error: i18n.t("The connection to your nest was lost during the process.") });
    }
  };

  return opened;
}

export function reset() {
  closeStream();
  closeDownloads();
  set({ ...initialState });
}

/** Step 1; POST the archive as multipart and move to the playlist picker. */
export async function parseExport(file: File | null) {
  if (!file) return;
  closeStream();
  set({
    ...initialState,
    file: { name: file.name, size: file.size },
    parsing: true,
  });

  const form = new FormData();
  form.append("file", file, file.name);

  try {
    // The fetch interceptor encodes multipart bytes and sends them through Rust.
    const response = await fetch(apiUrl(PARSE_ENDPOINT), { method: "POST", body: form });
    const text = await response.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (!response.ok) {
      throw new Error((isRecord(data) && ((typeof data.detail === "string" && data.detail) || (typeof data.message === "string" && data.message))) || i18n.t("The server answered {{status}}.", { status: response.status }));
    }
    if (!isParsedExport(data)) {
      throw new Error(i18n.t("The file was uploaded, but the response carried no playlists."));
    }
    set({
      parsing: false,
      parsed: data,
      // Nothing preselected on purpose: resolving is slow and costly, so the
      // choice of what to spend that time on should be deliberate.
      selected: [],
      step: "picking",
    });
  } catch (error) {
    set({ parsing: false, error: friendlyError(error) });
  }
}

export function togglePlaylist(name: string) {
  const selected = state.selected.includes(name)
    ? state.selected.filter((item) => item !== name)
    : [...state.selected, name];
  set({ selected });
}

export function setAllPlaylists(checked: boolean) {
  set({ selected: checked ? (state.parsed?.playlists || []).map((p) => p.name) : [] });
}

/** Step 3; resolve the selected playlists one at a time. */
export function startResolve() {
  const playlists = (state.parsed?.playlists || []).filter((p) => state.selected.includes(p.name));
  if (!playlists.length) return;
  set({ queue: playlists, queueIndex: 0, summaries: [], notice: null });
  resolvePlaylistAt(0);
}

export function retryResolve() {
  resolvePlaylistAt(state.queueIndex);
}

async function resolvePlaylistAt(index: number) {
  const playlist = state.queue[index];
  if (!playlist) {
    set({ step: "summary" });
    return;
  }
  closeStream();
  const tracks = playlist.tracks || [];
  if (tracks.length === 0) {
    // The backend rejects an empty track list (min_length=1), and there is
    // nothing to resolve anyway; record it and move on instead of erroring.
    set({
      queueIndex: index,
      summaries: [...state.summaries, { name: playlist.name, kind: "empty", accepted: 0, downloaded: 0 }],
    });
    continueQueue();
    return;
  }
  const total = playlist.trackCount ?? tracks.length;
  set({
    step: "resolving",
    queueIndex: index,
    results: null,
    accepted: [],
    error: null,
    notice: null,
    progress: {
      phase: "resolve",
      id: null,
      label: playlist.name,
      total,
      completed: 0,
      done: [],
      active: {},
      status: "in_progress",
      startedAt: Date.now(),
    },
  });

  let progressId;
  try {
    const data = await apiPost(RESOLVE_ENDPOINT, {
      body: {
        playlistName: playlist.name,
        tracks: tracks.map((track) => ({
          title: track.title,
          artist: track.artist,
          album: track.album,
        })),
      },
    });
    progressId = requireProgressId(data);
  } catch (e) {
    set({ error: friendlyError(e) });
    return;
  }

  set({ progress: { ...state.progress, id: progressId } });

  streamProgress(progressId, {
    onDone: async (finalSnapshot) => {
      try {
        const outcome = await fetchResults(progressId);
        if (outcome.status === "failed" && outcome.results.length === 0) {
          throw new Error(outcome.error || i18n.t("Matching failed in your nest."));
        }
        const cancelled = outcome.status === "cancelled" || finalSnapshot?.status === "cancelled";
        set({
          step: "review",
          results: outcome.results,
          // Strong matches arrive pre-accepted; everything else needs a tick.
          accepted: outcome.results.map((row) => row.confidence === "strong"),
          progress: { ...state.progress, status: finalSnapshot?.status || outcome.status },
          error: null,
          notice: cancelled
            ? i18n.t("Stopped. {{reviewed}} of {{total}} songs were reviewed in time; you can import these and leave the rest for later.", { reviewed: outcome.results.length, total: outcome.total })
            : state.notice,
        });
      } catch (e) {
        set({ error: friendlyError(e) });
      }
    },
  });
}

/**
 * Ask the backend to stop resolving.
 *
 * Cooperative on both sides: the stream stays open on purpose so the terminal
 * "cancelled" snapshot still arrives and the partial results get loaded; the
 * backend keeps everything it resolved before the stop, and half a reviewed
 * playlist is worth far more than nothing. To walk away entirely, use "Back to playlists".
 */
export function cancelResolve() {
  const id = state.progress?.id;
  if (!id) {
    backToPicking();
    return;
  }
  set({ notice: i18n.t("Stopping… everything already reviewed will be kept.") });
  void apiPost("/api/playlists/spotify-export/resolve/{progress_id}/cancel", {
    params: { path: { progress_id: id } },
  }).catch((error) => {
    set({ error: friendlyError(error) });
  });
}

/**
 * Stop watching a download. There is no cancel route for downloads; they run
 * through the shared download service; so this only detaches the UI, and says
 * so instead of pretending the work stopped.
 */
export function stopWatchingImport() {
  // The download keeps its own stream; its summary row goes on counting.
  set({ step: "summary", progress: EMPTY_PROGRESS });
}

export function setAccepted(index: number, checked: boolean) {
  const accepted = [...state.accepted];
  accepted[index] = checked;
  set({ accepted });
}

/** Tick/untick every row of one confidence group at once. */
export function setGroupAccepted(confidence: string, checked: boolean) {
  const accepted = (state.results || []).map((row, i) =>
    row.confidence === confidence ? checked : state.accepted[i],
  );
  set({ accepted });
}

/** Step 4; download the confirmed matches for the current playlist. */
export async function startImport() {
  const playlist = state.queue[state.queueIndex];
  const chosen = (state.results || []).filter((_, i) => state.accepted[i]);
  if (!playlist || !chosen.length) return;

  closeStream();
  set({
    step: "importing",
    error: null,
    notice: null,
    progress: {
      phase: "import",
      id: null,
      label: playlist.name,
      total: chosen.length,
      completed: 0,
      done: [],
      active: {},
      status: "in_progress",
      startedAt: Date.now(),
    },
  });

  let progressId;
  try {
    const data = await apiPost(IMPORT_ENDPOINT, {
      // Send what was *found*, not what was asked for: the match is the thing the
      // user just approved, and it carries the corrected spelling/artist that
      // makes the download search land. Rows with no candidate at all (accepted
      // deliberately) fall back to the wanted text.
      body: {
        playlistName: playlist.name,
        // TODO(types): Open matcher rows may omit both titles; retain backend validation.
        tracks: chosen.map(({ wanted = {}, match }) => ({
          title: match?.title || wanted.title!,
          artist: match?.artist || wanted.artist || null,
          album: match?.album || wanted.album || null,
          durationSeconds: match?.durationSeconds ?? null,
          coverUrl: match?.coverUrl ?? null,
          provider: match?.provider ?? null,
          providerId: match?.providerId ?? null,
          isrc: match?.isrc ?? null,
          mbid: match?.mbid ?? match?.recordingMbid ?? null,
        })),
      },
    });
    progressId = requireProgressId(data);
    window.dispatchEvent(new CustomEvent("playlists-changed"));
  } catch (e) {
    set({ error: friendlyError(e) });
    return;
  }

  set({
    progress: { ...state.progress, id: progressId },
    summaries: [
      ...state.summaries,
      { id: progressId, name: playlist.name, kind: "downloading", accepted: chosen.length, downloaded: 0 },
    ],
  });
  trackDownload(progressId);
}

/** Move to the next selected playlist, or finish. */
export function continueQueue() {
  const next = state.queueIndex + 1;
  if (next < state.queue.length) resolvePlaylistAt(next);
  else set({ step: "summary", progress: EMPTY_PROGRESS });
}

/** Drop abandoned resolve jobs so they stop consuming provider quota. */
function abandonResolve() {
  const id = state.step === "resolving" ? state.progress?.id : null;
  closeStream();
  if (id) {
    void apiPost("/api/playlists/spotify-export/resolve/{progress_id}/cancel", {
      params: { path: { progress_id: id } },
    }).catch(() => {});
  }
}

/** Leave the current playlist alone and go on to the next one. */
export function skipPlaylist() {
  if (state.step === "importing") {
    // The download goes on in its own stream; only the screen moves on.
    set({ progress: EMPTY_PROGRESS, results: null, accepted: [] });
    continueQueue();
    return;
  }
  abandonResolve();
  set({
    summaries: [
      ...state.summaries,
      { name: state.queue[state.queueIndex]?.name, kind: "skipped", accepted: 0, downloaded: 0 },
    ],
    progress: EMPTY_PROGRESS,
    results: null,
    accepted: [],
  });
  continueQueue();
}

export function dismissError() {
  set({ error: null });
}

export function dismissNotice() {
  set({ notice: null });
}

/** Back to the playlist picker without losing the parsed export. */
export function backToPicking() {
  abandonResolve();
  set({ step: "picking", progress: EMPTY_PROGRESS, results: null, accepted: [], error: null });
}
