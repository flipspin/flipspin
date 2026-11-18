import type { ParsedExport } from "./spotifyImport.types";
import React from "react";
import { AlertTriangle, ArrowRight, FileQuestion, ListMusic, RotateCcw } from "lucide-react";
import { buttonStyle, cardStyle, chipStyle, formatBytes, monoStyle } from "./importStyles";
import { APP_NAME } from "../brand";
import { useTranslation } from "react-i18next";

/** Show parser warnings and unrecognized files so skipped playlists
 * remain distinguishable from playlists absent from the export. */
export default function PlaylistPicker({ parsed, selected, onToggle, onSetAll, onContinue, onRestart }: { parsed: ParsedExport | null; selected: string[]; onToggle: (name: string) => void; onSetAll: (checked: boolean) => void; onContinue: () => void; onRestart: () => void }) {
  const { t } = useTranslation();
  const playlists = parsed?.playlists || [];
  const warnings = parsed?.warnings || [];
  // Only the unrecognised ones. The PDF readme and the account files that never
  // held playlists are also reported, and listing them here would bury the one
  // entry that means something.
  const unknownFiles = (parsed?.unreadMembers || []).filter(
    (member) => member.category === "unrecognized",
  );
  const selectedSet = new Set(selected);
  const selectedTracks = playlists
    .filter((p) => selectedSet.has(p.name))
    .reduce((sum, p) => sum + (p.trackCount ?? p.tracks?.length ?? 0), 0);
  const allSelected = playlists.length > 0 && selected.length === playlists.length;

  return (
    <div className="flex flex-col gap-4 min-h-0">
      {warnings.length > 0 && (
        <div
          className="p-3"
          style={{
            ...cardStyle,
            background: "var(--yellow-tint)",
            borderColor: "var(--line)",
          }}
          role="status"
        >
          <div className="flex items-center gap-2">
            <AlertTriangle size={16} strokeWidth={2.5} style={{ color: "var(--fg-yellow)" }} />
            <h3 className="text-sm font-extrabold m-0" style={{ color: "var(--ink)" }}>
              {t("{{n}} warnings while reading the file", { count: warnings.length, n: warnings.length })}
            </h3>
          </div>
          <p className="text-xs mt-1.5 mb-2" style={{ color: "var(--ink-2)" }}>
            {t("This is what {{app}} couldn't interpret. If a playlist is missing, the explanation is below.", { app: APP_NAME })}
          </p>
          <ul className="m-0 pl-0 list-none flex flex-col gap-1 max-h-40 overflow-y-auto custom-scrollbar">
            {warnings.map((warning, i) => (
              <li
                key={i}
                className="text-xs px-2 py-1"
                style={{
                  color: "var(--ink-2)",
                  background: "var(--panel)",
                  border: "1.5px solid var(--line)",
                  borderRadius: "var(--r-sm)",
                }}
              >
                {warning}
              </li>
            ))}
          </ul>
        </div>
      )}

      {unknownFiles.length > 0 && (
        <div className="p-3" style={cardStyle} role="status">
          <div className="flex items-center gap-2">
            <FileQuestion size={16} strokeWidth={2.5} style={{ color: "var(--ink-2)" }} />
            <h3 className="text-sm font-extrabold m-0" style={{ color: "var(--ink)" }}>
              {t("{{n}} files in the ZIP that {{app}} didn't recognise", { count: unknownFiles.length, n: unknownFiles.length, app: APP_NAME })}
            </h3>
          </div>
          <p className="text-xs mt-1.5 mb-2" style={{ color: "var(--ink-2)" }}>
            {t("These aren't errors: they're files with a structure {{app}} couldn't read. If your playlists are complete, ignore it. If one is missing, Spotify has probably changed the export format, and this is what to show to get it fixed.", { app: APP_NAME })}
          </p>
          <ul className="m-0 pl-0 list-none flex flex-col gap-1 max-h-40 overflow-y-auto custom-scrollbar">
            {unknownFiles.map((member) => (
              <li
                key={member.filename}
                className="px-2 py-1"
                style={{
                  background: "var(--panel-2)",
                  border: "1.5px solid var(--line)",
                  borderRadius: "var(--r-sm)",
                }}
              >
                <div className="flex items-baseline gap-2">
                  <span className="truncate text-xs font-semibold" style={{ color: "var(--ink)" }}>
                    {member.filename}
                  </span>
                  {formatBytes(member.sizeBytes) && (
                    <span className="shrink-0" style={monoStyle}>
                      {formatBytes(member.sizeBytes)}
                    </span>
                  )}
                </div>
                <p className="text-xs m-0 break-words" style={{ color: "var(--ink-3)" }}>
                  {member.detail}
                </p>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex flex-col min-h-0 flex-1" style={cardStyle}>
        <div
          className="flex items-center gap-2 flex-wrap px-3 py-2.5"
          style={{ borderBottom: "2px solid var(--line)" }}
        >
          <ListMusic size={16} strokeWidth={2.5} style={{ color: "var(--ink-2)" }} />
          <h3 className="text-sm font-extrabold m-0" style={{ color: "var(--ink)" }}>
            {t("Playlists found")}
          </h3>
          <span style={chipStyle({ bg: "var(--teal-tint)", fg: "var(--fg-teal)", mono: true })}>
            {t("{{n}} playlists", { count: parsed?.playlistCount ?? playlists.length, n: parsed?.playlistCount ?? playlists.length })} · {t("{{n}} songs", { count: parsed?.trackCount ?? 0, n: parsed?.trackCount ?? 0 })}
          </span>
          <button
            type="button"
            onClick={() => onSetAll(!allSelected)}
            className="ml-auto"
            style={buttonStyle("ghost")}
          >
            {allSelected ? t("Remove all") : t("Select all")}
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar p-2">
          {playlists.length === 0 ? (
            <p className="text-sm p-4 text-center m-0" style={{ color: "var(--ink-3)" }}>
              {t("The file didn't contain any playlist {{app}} can read.", { app: APP_NAME })}
            </p>
          ) : (
            <ul className="m-0 p-0 list-none flex flex-col gap-1">
              {playlists.map((playlist) => {
                const checked = selectedSet.has(playlist.name);
                const count = playlist.trackCount ?? playlist.tracks?.length ?? 0;
                return (
                  <li key={playlist.name}>
                    <label
                      className="flex items-center gap-2.5 px-2.5 py-2 cursor-pointer"
                      style={{
                        background: checked ? "var(--coral-tint)" : "transparent",
                        border: `1.5px solid ${checked ? "var(--line)" : "transparent"}`,
                        borderRadius: "var(--r-sm)",
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => onToggle(playlist.name)}
                        className="w-4 h-4 shrink-0 cursor-pointer accent-[var(--coral)]"
                      />
                      <span
                        className="flex-1 min-w-0 truncate text-sm font-semibold"
                        style={{ color: "var(--ink)" }}
                        title={playlist.name}
                      >
                        {playlist.name}
                      </span>
                      {playlist.modifiedAt && (
                        <span className="shrink-0 max-md:hidden" style={monoStyle}>
                          {playlist.modifiedAt}
                        </span>
                      )}
                      <span className="shrink-0" style={monoStyle}>
                        {t("{{n}} songs", { count, n: count })}
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div
          className="flex items-center gap-2 flex-wrap px-3 py-2.5"
          style={{ borderTop: "2px solid var(--line)" }}
        >
          <button type="button" onClick={onRestart} style={buttonStyle("ghost")}>
            <RotateCcw size={14} strokeWidth={2.5} />
            {t("Another file")}
          </button>
          <span className="text-xs ml-1" style={{ color: "var(--ink-3)" }}>
            {t("{{n}} playlists", { count: selected.length, n: selected.length })} · {t("{{n}} songs to review", { count: selectedTracks, n: selectedTracks })}
          </span>
          <button
            type="button"
            onClick={onContinue}
            disabled={selected.length === 0}
            className="ml-auto"
            style={buttonStyle("primary", selected.length === 0)}
          >
            {t("Find matches")}
            <ArrowRight size={15} strokeWidth={2.5} />
          </button>
        </div>
      </div>
    </div>
  );
}
