import type { ImportProgress, QueuePosition } from "./spotifyImport.types";
import React, { useEffect, useState } from "react";
import { Loader2, SkipForward, XCircle } from "lucide-react";
import { buttonStyle, cardStyle, chipStyle, formatElapsed, monoStyle } from "./importStyles";
import { APP_NAME } from "../brand";
import { useTranslation } from "react-i18next";
import { msg } from "../i18n";

// Backend phase names → something readable. Unknown phases fall through as-is
// rather than being hidden, so a new backend phase still shows up. `msg` only
// marks the copy; the render site translates it with `t(PHASE_LABELS[...])`.
const PHASE_LABELS: Record<string, string> = {
  searching: msg("searching"),
  matching: msg("comparing"),
  resolving: msg("identifying"),
  downloading: msg("downloading"),
  converting: msg("converting"),
  tagging: msg("tagging"),
  embedding: msg("adding cover art"),
  saving: msg("saving"),
};

/** Show phase, elapsed time and progress for long jobs; cancellation preserves the parsed export. */
export default function ProgressPanel({ progress, queuePosition, onCancel, onSkip }: { progress: ImportProgress | null; queuePosition: QueuePosition; onCancel: () => void; onSkip: () => void }) {
  const { t } = useTranslation();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  if (!progress) return null;

  const total = progress.total || 0;
  const completed = progress.completed || 0;
  const percent = total > 0 ? Math.min(100, Math.round((completed / total) * 100)) : 0;
  const elapsed = progress.startedAt ? now - progress.startedAt : 0;
  const remaining =
    completed > 0 && total > completed ? (elapsed / completed) * (total - completed) : null;
  const isResolve = progress.phase === "resolve";
  const active = Object.entries(progress.active || {});

  return (
    <div className="flex flex-col gap-4 min-h-0">
      <div className="p-4 flex flex-col gap-3" style={cardStyle}>
        <div className="flex items-center gap-2 flex-wrap">
          <Loader2
            size={16}
            strokeWidth={2.5}
            className="animate-spin"
            style={{ color: "var(--coral)" }}
          />
          <h3 className="text-sm font-extrabold m-0" style={{ color: "var(--ink)" }}>
            {isResolve ? t("Working out which song each line refers to") : t("Downloading what you approved")}
          </h3>
          {queuePosition && queuePosition.total > 1 && (
            <span style={chipStyle({ bg: "var(--paper-2)", mono: true })}>
              {t("playlist {{index}} of {{total}}", { index: queuePosition.index + 1, total: queuePosition.total })}
            </span>
          )}
          <span
            className="ml-auto truncate max-w-[45%] text-xs font-semibold"
            style={{ color: "var(--ink-2)" }}
            title={progress.label}
          >
            {progress.label}
          </span>
        </div>

        {/* Bar */}
        <div
          className="w-full overflow-hidden"
          style={{
            height: 14,
            background: "var(--paper-2)",
            border: "2px solid var(--line)",
            borderRadius: 999,
          }}
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
        >
          <div
            style={{
              width: `${percent}%`,
              height: "100%",
              background: isResolve ? "var(--teal)" : "var(--coral)",
              transition: "width var(--dur) var(--ease)",
            }}
          />
        </div>

        <div className="flex items-center gap-3 flex-wrap" style={monoStyle}>
          <span style={{ color: "var(--ink-2)", fontWeight: 700 }}>
            {t("{{completed}}/{{total}} ({{percent}}%)", { completed, total: total || "?", percent })}
          </span>
          <span>{t("{{elapsed}} so far", { elapsed: formatElapsed(elapsed) })}</span>
          {remaining != null && <span>{t("~{{remaining}} left", { remaining: formatElapsed(remaining) })}</span>}
        </div>

        {active.length > 0 && (
          <ul className="retro-song-table retro-song-table--embedded retro-song-table--scroll retro-song-table__body">
            {active.map(([item, sub]) => (
              <li
                key={item}
                className="retro-song-table__row flex items-center gap-2 px-2.5 py-1.5"
              >
                <span
                  className="flex-1 min-w-0 truncate text-xs font-semibold"
                  style={{ color: "var(--ink)" }}
                  title={item}
                >
                  {item}
                </span>
                <span className="shrink-0" style={monoStyle}>
                  {PHASE_LABELS[sub?.phase ?? ""] ? t(PHASE_LABELS[sub.phase ?? ""]) : sub?.phase || ""}
                  {typeof sub?.percent === "number" ? ` ${Math.round(sub.percent)}%` : ""}
                </span>
              </li>
            ))}
          </ul>
        )}

        <p className="text-xs m-0" style={{ color: "var(--ink-3)", lineHeight: 1.5 }}>
          {isResolve
            ? t("This can take a while for large playlists. The work runs in your nest: you can switch pages or leave {{app}} open and come back when it's done. If you stop it, everything already reviewed is kept and you can import that part.", { app: APP_NAME })
            : t("Downloads keep going in the background even if you switch pages or stop watching them.")}
        </p>

        <div className="flex items-center gap-2 flex-wrap">
          <button type="button" onClick={onCancel} style={buttonStyle("secondary")}>
            <XCircle size={14} strokeWidth={2.5} />
            {isResolve ? t("Stop and review what's there") : t("Stop following the download")}
          </button>
          {queuePosition && queuePosition.index + 1 < queuePosition.total && (
            <button type="button" onClick={onSkip} style={buttonStyle("ghost")}>
              <SkipForward size={14} strokeWidth={2.5} />
              {isResolve ? t("Skip to the next playlist") : t("Next playlist")}
            </button>
          )}
        </div>
      </div>

      {(progress.done?.length ?? 0) > 0 && (
        <div className="flex flex-col min-h-0" style={cardStyle}>
          <div className="px-3 py-2" style={{ borderBottom: "2px solid var(--line)" }}>
            <h4 className="text-xs font-extrabold m-0 uppercase" style={{ color: "var(--ink-2)" }}>
              {t("Ready ({{n}})", { n: progress.done!.length })}
            </h4>
          </div>
          <ul className="retro-song-table retro-song-table--embedded retro-song-table--scroll retro-song-table__body max-h-48 overflow-y-auto custom-scrollbar">
            {progress.done!.map((item, i) => (
              <li
                key={`${item}-${i}`}
                className="retro-song-table__row text-xs truncate px-2 py-1"
                style={{ color: "var(--ink-3)" }}
                title={item}
              >
                {item}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
