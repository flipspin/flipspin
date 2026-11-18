import type { TFunction } from "i18next";
import type { ImportState, ImportSummary } from "./spotifyImport.types";
import React, { useSyncExternalStore } from "react";
import { AlertOctagon, CheckCircle2, Info, RotateCcw, X } from "lucide-react";
import ExportDropZone from "./ExportDropZone";
import MatchReview from "./MatchReview";
import PlaylistPicker from "./PlaylistPicker";
import ProgressPanel from "./ProgressPanel";
import { buttonStyle, cardStyle, monoStyle } from "./importStyles";
import {
  backToPicking,
  cancelResolve,
  continueQueue,
  dismissError,
  dismissNotice,
  getState,
  parseExport,
  reset,
  retryResolve,
  setAccepted,
  setAllPlaylists,
  setGroupAccepted,
  skipPlaylist,
  startImport,
  startResolve,
  stopWatchingImport,
  subscribe,
  togglePlaylist,
} from "./spotifyImportStore";
import { useTranslation } from "react-i18next";
import { ImportSteps } from "./ImportSteps";

/** Dismissible banner. `tone` picks the token pair; actions render on the right. */
function Banner({ tone, icon, children, onDismiss, actions }: { tone: "error" | "info"; icon: React.ReactNode; children?: React.ReactNode; onDismiss: () => void; actions?: React.ReactNode }) {
  const { t } = useTranslation();
  const tones = {
    error: { bg: "var(--rose-tint)", fg: "var(--fg-rose)" },
    info: { bg: "var(--blue-tint)", fg: "var(--fg-blue)" },
  };
  const palette = tones[tone] || tones.info;
  return (
    <div
      className="flex items-start gap-2 px-3 py-2.5"
      style={{ ...cardStyle, background: palette.bg }}
      role={tone === "error" ? "alert" : "status"}
    >
      <span className="mt-0.5 shrink-0" style={{ color: palette.fg }} aria-hidden>
        {icon}
      </span>
      <p className="flex-1 min-w-0 text-xs m-0" style={{ color: "var(--ink-2)", lineHeight: 1.5 }}>
        {children}
      </p>
      {actions}
      <button
        type="button"
        onClick={onDismiss}
        aria-label={t("Dismiss notice")}
        style={{ ...buttonStyle("secondary"), padding: 4, minHeight: 0 }}
      >
        <X size={13} strokeWidth={3} />
      </button>
    </div>
  );
}

// How each finished playlist reads in the summary list. Each takes the render
// site's `t`, so the prose is produced in the current language, not at import.
const SUMMARY_LABELS: Record<ImportSummary["kind"], (entry: ImportSummary, t: TFunction) => string> = {
  downloaded: (entry, t) => t("{{done}}/{{accepted}} downloaded", { done: entry.downloaded, accepted: entry.accepted }),
  downloading: (entry, t) => t("{{done}}/{{accepted}} · downloading", { done: entry.downloaded, accepted: entry.accepted }),
  background: (entry, t) => t("{{done}}/{{accepted}} · continues in the background", { done: entry.downloaded, accepted: entry.accepted }),
  skipped: (_entry, t) => t("skipped"),
  empty: (_entry, t) => t("no songs"),
};

function Summary({ summaries, queue, queueIndex }: Pick<ImportState, "summaries" | "queue" | "queueIndex">) {
  const { t } = useTranslation();
  const remaining = queue.length - queueIndex - 1;
  return (
    <div className="flex flex-col gap-3">
      <div className="p-4 flex flex-col gap-2" style={cardStyle}>
        <div className="flex items-center gap-2">
          <CheckCircle2 size={18} strokeWidth={2.5} style={{ color: "var(--green)" }} />
          <h3 className="text-sm font-extrabold m-0" style={{ color: "var(--ink)" }}>
            {t("Import summary")}
          </h3>
        </div>
        {summaries.length === 0 ? (
          <p className="text-xs m-0" style={{ color: "var(--ink-3)" }}>
            {t("No playlist has been imported yet.")}
          </p>
        ) : (
          <ul className="m-0 p-0 list-none flex flex-col gap-1">
            {summaries.map((entry, i) => (
              <li
                key={`${entry.name}-${i}`}
                className="flex items-center gap-2 px-2.5 py-1.5"
                style={{
                  background: "var(--panel-2)",
                  border: "2px solid var(--line)",
                  borderRadius: "var(--r-sm)",
                }}
              >
                <span
                  className="flex-1 min-w-0 truncate text-xs font-semibold"
                  style={{ color: "var(--ink)" }}
                >
                  {entry.name}
                </span>
                <span style={monoStyle} title={entry.status || ""}>
                  {SUMMARY_LABELS[entry.kind]?.(entry, t) ?? ""}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="flex items-center gap-2 flex-wrap px-3 py-2.5" style={cardStyle}>
        {remaining > 0 ? (
          <>
            <span className="text-xs" style={{ color: "var(--ink-2)" }}>
              {t("{{n}} playlists left to review.", { count: remaining, n: remaining })}
            </span>
            <button
              type="button"
              onClick={continueQueue}
              className="ml-auto"
              style={buttonStyle("primary")}
            >
              {t("Continue with “{{name}}”", { name: queue[queueIndex + 1]?.name })}
            </button>
          </>
        ) : (
          <>
            <span className="text-xs" style={{ color: "var(--ink-2)" }}>
              {summaries.some((entry) => entry.kind === "downloading")
                ? t("Downloading. The songs show up in your library when it finishes.")
                : t("Done. The new songs are now in your library.")}
            </span>
            <button type="button" onClick={reset} className="ml-auto" style={buttonStyle("secondary")}>
              <RotateCcw size={14} strokeWidth={2.5} />
              {t("Import another file")}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

// The wizard as a page: its own scroller, page padding, centred column.
function PageShell({ children }: { children?: React.ReactNode }) {
  return (
    <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar p-4 md:p-6">
      <div className="mx-auto w-full max-w-4xl flex flex-col gap-4 min-h-0">{children}</div>
    </div>
  );
}

// The wizard inside the settings modal: no scroller of its own; the pane is
// already one, and nesting two means the inner lists' own `max-h` caps end up
// scrolling against a container that never grows.
function EmbeddedShell({ children }: { children?: React.ReactNode }) {
  return <div className="flex flex-col gap-4 min-h-0">{children}</div>;
}

/** Keep resolve state and progress subscriptions in spotifyImportStore so leaving Settings
 * does not cancel a long import. Embedded mode uses the host pane's scrolling and chrome. */
export default function SpotifyExportImport({ embedded = false }: { embedded?: boolean }) {
  const { t } = useTranslation();
  const state = useSyncExternalStore(subscribe, getState);
  const { step, error, notice, progress, queue, queueIndex } = state;
  const queuePosition = queue.length ? { index: queueIndex, total: queue.length } : null;
  const canRetry = step === "resolving" && Boolean(error);

  const Shell = embedded ? EmbeddedShell : PageShell;

  return (
    <Shell>
        <header className="flex flex-col gap-2">
          {!embedded && (
            <h2
              className="text-xl font-extrabold m-0"
              style={{ fontFamily: "var(--font-pixel)", color: "var(--ink)" }}
            >
              {t("Import from Spotify")}
            </h2>
          )}
          <ImportSteps step={step} />
        </header>

        {error && (
          <Banner
            tone="error"
            icon={<AlertOctagon size={16} strokeWidth={2.5} />}
            onDismiss={dismissError}
            actions={
              canRetry ? (
                <button type="button" onClick={retryResolve} style={buttonStyle("secondary")}>
                  {t("Retry")}
                </button>
              ) : null
            }
          >
            {error}
          </Banner>
        )}

        {notice && (
          <Banner
            tone="info"
            icon={<Info size={16} strokeWidth={2.5} />}
            onDismiss={dismissNotice}
          >
            {notice}
          </Banner>
        )}

        {step === "drop" && (
          <ExportDropZone file={state.file} parsing={state.parsing} onFile={parseExport} />
        )}

        {step === "picking" && (
          <PlaylistPicker
            parsed={state.parsed}
            selected={state.selected}
            onToggle={togglePlaylist}
            onSetAll={setAllPlaylists}
            onContinue={startResolve}
            onRestart={reset}
          />
        )}

        {(step === "resolving" || step === "importing") && (
          <ProgressPanel
            progress={progress}
            queuePosition={queuePosition}
            onCancel={step === "resolving" ? cancelResolve : stopWatchingImport}
            onSkip={skipPlaylist}
          />
        )}

        {step === "review" && (
          <MatchReview
            results={state.results}
            accepted={state.accepted}
            playlistName={queue[queueIndex]?.name}
            queuePosition={queuePosition}
            onToggle={setAccepted}
            onGroupToggle={setGroupAccepted}
            onConfirm={startImport}
            onSkip={skipPlaylist}
            onBack={backToPicking}
          />
        )}

        {step === "summary" && (
          <Summary summaries={state.summaries} queue={queue} queueIndex={queueIndex} />
        )}
    </Shell>
  );
}
