import type { ImportMatch, QueuePosition } from "./spotifyImport.types";
import React, { useMemo, useState } from "react";
import { ArrowRight, ChevronDown, ChevronRight, Download, SkipForward } from "lucide-react";
import {
  buttonStyle,
  cardStyle,
  chipStyle,
  confidenceStyle,
  formatDuration,
  monoStyle,
} from "./importStyles";
import { useTranslation } from "react-i18next";
import { APP_NAME } from "../brand";
import { Missing } from "../ui/react/components/Missing";

const GROUP_ORDER = ["review", "strong", "rejected"] as const;
type Confidence = typeof GROUP_ORDER[number];
type RowProps = { row: ImportMatch; index: number; checked: boolean; onToggle: (index: number, checked: boolean) => void };
// Open uncertain matches first; retain rejected rows so users can correct false rejections.
const DEFAULT_OPEN = { review: true, strong: false, rejected: true };

/** Loose comparison so "Túnel" vs "Tunel" or "Song (Remastered)" vs "Song" is judged on substance. */
function normalize(value: unknown) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function fieldsDiffer(a: unknown, b: unknown) {
  const left = normalize(a);
  const right = normalize(b);
  if (!left || !right) return false;
  return left !== right;
}

/** One line of the side-by-side, tinted when the two sides disagree. */
function CompareLine({ label, value, other, strong }: { label: string; value?: string | null; other?: string | null; strong?: boolean }) {
  const differs = fieldsDiffer(value, other);
  return (
    <div className="flex items-baseline gap-2 min-w-0">
      <span className="shrink-0" style={{ ...monoStyle, minWidth: 44 }}>
        {label}
      </span>
      <span
        className="min-w-0 truncate text-xs"
        title={value || undefined}
        style={{
          color: value ? "var(--ink)" : "var(--ink-4)",
          fontWeight: strong ? 700 : 500,
          background: differs ? "var(--rose-tint)" : "transparent",
          borderRadius: "var(--r-sm)",
          padding: differs ? "0 4px" : 0,
        }}
      >
        {value || <Missing kind="nodata" />}
      </span>
    </div>
  );
}

/** Full detail row: what you asked for, what was found, and why it is doubtful. */
function DetailedRow({ row, index, checked, onToggle }: RowProps) {
  const { t } = useTranslation();
  const wanted = row.wanted || {};
  const match = row.match;
  const reasons = match?.reasons || [];

  return (
    <li className="retro-song-table__row p-2.5 flex gap-2.5">
      <input
        type="checkbox"
        checked={Boolean(checked)}
        onChange={(e) => onToggle(index, e.target.checked)}
        className="mt-1 w-4 h-4 shrink-0 cursor-pointer accent-[var(--coral)]"
        aria-label={t("Accept {{title}}", { title: wanted.title || t("this song") })}
      />
      <div className="flex-1 min-w-0 flex flex-col gap-2">
        <div className="flex items-stretch gap-2 max-md:flex-col">
          <div className="flex-1 min-w-0 flex flex-col gap-0.5">
            <span className="text-[10px] font-extrabold uppercase" style={{ color: "var(--ink-3)" }}>
              {t("You asked for")}
            </span>
            <CompareLine label={t("title")} value={wanted.title} other={match?.title} strong />
            <CompareLine label={t("artist")} value={wanted.artist} other={match?.artist} />
            <CompareLine label={t("album")} value={wanted.album} other={match?.album} />
          </div>

          <div className="grid place-items-center shrink-0 px-1 max-md:hidden" aria-hidden>
            <ArrowRight size={16} strokeWidth={2.5} style={{ color: "var(--ink-4)" }} />
          </div>

          <div className="flex-1 min-w-0 flex flex-col gap-0.5">
            <span className="text-[10px] font-extrabold uppercase" style={{ color: "var(--ink-3)" }}>
              {t("Found")}
            </span>
            {match ? (
              <>
                <CompareLine label={t("title")} value={match.title} other={wanted.title} strong />
                <CompareLine label={t("artist")} value={match.artist} other={wanted.artist} />
                <CompareLine label={t("album")} value={match.album} other={wanted.album} />
              </>
            ) : (
              <span className="text-xs" style={{ color: "var(--ink-4)" }}>
                {t("No candidates.")}
              </span>
            )}
          </div>
        </div>

        {row.explanation && (
          <p
            className="text-xs m-0 px-2 py-1"
            style={{
              color: "var(--ink-2)",
              background: "var(--paper-2)",
              borderRadius: "var(--r-sm)",
            }}
          >
            {row.explanation}
          </p>
        )}

        {(reasons.length > 0 || match) && (
          <div className="flex items-center gap-1.5 flex-wrap">
            {reasons.map((reason, i) => (
              <span key={i} style={chipStyle({ bg: "var(--rose-tint)", fg: "var(--fg-rose)" })}>
                {reason}
              </span>
            ))}
            {match?.provider && (
              <span style={chipStyle({ bg: "var(--teal-tint)", fg: "var(--fg-teal)", mono: true })}>
                {match.provider}
              </span>
            )}
            {formatDuration(match?.durationSeconds) && (
              <span style={chipStyle({ mono: true })}>{formatDuration(match?.durationSeconds)}</span>
            )}
            {typeof match?.distance === "number" && (
              <span style={chipStyle({ mono: true })}>{t("distance {{n}}", { n: match.distance })}</span>
            )}
            {match?.isrc && (
              <span style={chipStyle({ bg: "var(--green-tint)", fg: "var(--fg-green)", mono: true })}>{' '}{t("ISRC")}{' '}{match.isrc}
              </span>
            )}
            {match?.recordingMbid && (
              <span style={chipStyle({ bg: "var(--green-tint)", fg: "var(--fg-green)", mono: true })}>{' '}{t("MBID")}{' '}{String(match.recordingMbid).slice(0, 8)}
              </span>
            )}
          </div>
        )}
      </div>
    </li>
  );
}

/** Compact row for matches that need no argument. */
function CompactRow({ row, index, checked, onToggle }: RowProps) {
  const { t } = useTranslation();
  const wanted = row.wanted || {};
  const match = row.match || {};
  return (
    <li className="retro-song-table__row flex items-center gap-2.5 px-2.5 py-1.5">
      <input
        type="checkbox"
        checked={Boolean(checked)}
        onChange={(e) => onToggle(index, e.target.checked)}
        className="w-4 h-4 shrink-0 cursor-pointer accent-[var(--coral)]"
        aria-label={t("Accept {{title}}", { title: wanted.title || t("this song") })}
      />
      <span className="flex-1 min-w-0 truncate text-xs font-semibold" style={{ color: "var(--ink)" }}>
        {wanted.title}
        {wanted.artist ? ` — ${wanted.artist}` : ""}
      </span>
      <ArrowRight size={13} strokeWidth={2.5} style={{ color: "var(--ink-4)" }} aria-hidden />
      <span className="flex-1 min-w-0 truncate text-xs" style={{ color: "var(--ink-2)" }}>
        {match.title}
        {match.artist ? ` — ${match.artist}` : ""}
      </span>
      {formatDuration(match?.durationSeconds) && (
        <span className="shrink-0 max-md:hidden" style={monoStyle}>
          {formatDuration(match?.durationSeconds)}
        </span>
      )}
    </li>
  );
}

function Group({ confidence, rows, accepted, onToggle, onGroupToggle }: { confidence: Confidence; rows: { row: ImportMatch; index: number }[]; accepted: boolean[]; onToggle: RowProps["onToggle"]; onGroupToggle: (confidence: string, checked: boolean) => void }) {
  const { t } = useTranslation();
  const style = confidenceStyle(confidence);
  const [open, setOpen] = useState(DEFAULT_OPEN[confidence] ?? true);
  const checkedCount = rows.filter(({ index }) => accepted[index]).length;
  const allChecked = rows.length > 0 && checkedCount === rows.length;
  const Chevron = open ? ChevronDown : ChevronRight;

  if (rows.length === 0) return null;

  return (
    <section className="flex flex-col" style={cardStyle}>
      <div
        className="flex items-center gap-2 flex-wrap px-3 py-2"
        style={{ background: style.tint, borderBottom: open ? "2px solid var(--line)" : "none" }}
      >
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="flex items-center gap-2 min-w-0"
          style={{
            ...buttonStyle("ghost"),
            background: "transparent",
            border: "none",
            boxShadow: "none",
            padding: 0,
          }}
        >
          <Chevron size={16} strokeWidth={2.5} style={{ color: "var(--ink-2)" }} />
          <span
            className="w-3 h-3 shrink-0"
            style={{
              background: style.accent,
              border: "2px solid var(--line)",
              borderRadius: 3,
            }}
            aria-hidden
          />
          <span className="text-sm font-extrabold" style={{ color: "var(--ink)" }}>
            {t(style.label)}
          </span>
          <span style={chipStyle({ bg: "var(--panel)", fg: style.fg, mono: true })}>
            {checkedCount}/{rows.length}
          </span>
        </button>
        <span className="text-xs min-w-0 truncate max-md:hidden" style={{ color: "var(--ink-2)" }}>
          {t(style.hint, { app: APP_NAME })}
        </span>
        <button
          type="button"
          onClick={() => onGroupToggle(confidence, !allChecked)}
          className="ml-auto"
          style={buttonStyle("secondary")}
        >
          {allChecked ? t("Remove all") : t("Select all")}
        </button>
      </div>

      {open && (
        <ul className="retro-song-table retro-song-table--embedded retro-song-table--scroll retro-song-table__body max-h-[52vh] overflow-y-auto custom-scrollbar">
          {rows.map(({ row, index }) =>
            confidence === "strong" ? (
              <CompactRow
                key={index}
                row={row}
                index={index}
                checked={accepted[index]}
                onToggle={onToggle}
              />
            ) : (
              <DetailedRow
                key={index}
                row={row}
                index={index}
                checked={accepted[index]}
                onToggle={onToggle}
              />
            ),
          )}
        </ul>
      )}
    </section>
  );
}

/** Show requested and found tracks with differing fields and backend reasons
 * so users can decide whether an uncertain match is acceptable. */
export default function MatchReview({
  results,
  accepted,
  playlistName,
  queuePosition,
  onToggle,
  onGroupToggle,
  onConfirm,
  onSkip,
  onBack,
}: { results: ImportMatch[] | null; accepted: boolean[]; playlistName?: string; queuePosition: QueuePosition; onToggle: RowProps["onToggle"]; onGroupToggle: (confidence: string, checked: boolean) => void; onConfirm: () => void; onSkip: () => void; onBack: () => void }) {
  const { t } = useTranslation();
  const grouped = useMemo(() => {
    const buckets: Record<Confidence, { row: ImportMatch; index: number }[]> = { strong: [], review: [], rejected: [] };
    (results || []).forEach((row, index) => {
      const key = GROUP_ORDER.find(key => key === row.confidence) ?? "rejected";
      buckets[key].push({ row, index });
    });
    return buckets;
  }, [results]);

  const acceptedCount = (accepted || []).filter(Boolean).length;

  return (
    <div className="flex flex-col gap-3 min-h-0">
      <div className="flex items-center gap-2 flex-wrap px-3 py-2.5" style={cardStyle}>
        <h3 className="text-sm font-extrabold m-0 truncate" style={{ color: "var(--ink)" }}>
          {playlistName}
        </h3>
        {queuePosition && queuePosition.total > 1 && (
          <span style={chipStyle({ bg: "var(--paper-2)", mono: true })}>
            {t("playlist {{index}} of {{total}}", { index: queuePosition.index + 1, total: queuePosition.total })}
          </span>
        )}
        {GROUP_ORDER.map((confidence) => {
          const style = confidenceStyle(confidence);
          const count = grouped[confidence].length;
          if (!count) return null;
          return (
            <span key={confidence} style={chipStyle({ bg: style.tint, fg: style.fg })}>
              {t("{{n}} {{group}}", { n: count, group: t(style.label).toLowerCase() })}
            </span>
          );
        })}
        <span className="ml-auto text-xs font-semibold" style={{ color: "var(--ink-2)" }}>
          {t("{{marked}} of {{total}} selected", { marked: acceptedCount, total: results?.length || 0 })}
        </span>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar flex flex-col gap-3 pr-0.5">
        {GROUP_ORDER.map((confidence) => (
          <Group
            key={confidence}
            confidence={confidence}
            rows={grouped[confidence]}
            accepted={accepted || []}
            onToggle={onToggle}
            onGroupToggle={onGroupToggle}
          />
        ))}
      </div>

      <div className="flex items-center gap-2 flex-wrap px-3 py-2.5" style={cardStyle}>
        <button type="button" onClick={onBack} style={buttonStyle("ghost")}>
          {t("Back to playlists")}
        </button>
        {queuePosition && queuePosition.index + 1 < queuePosition.total && (
          <button type="button" onClick={onSkip} style={buttonStyle("ghost")}>
            <SkipForward size={14} strokeWidth={2.5} />
            {t("Skip this playlist")}
          </button>
        )}
        <button
          type="button"
          onClick={onConfirm}
          disabled={acceptedCount === 0}
          className="ml-auto"
          style={buttonStyle("primary", acceptedCount === 0)}
        >
          <Download size={15} strokeWidth={2.5} />
          {t("Download {{n}} songs", { count: acceptedCount, n: acceptedCount })}
        </button>
      </div>
    </div>
  );
}
