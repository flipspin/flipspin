import { msg } from '../../i18n';
import { TagField } from "../../ui/components/TagField";
import { reportError } from '../../lib/log';
import { Fragment, useEffect, useId, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { buildCoverImageUrl, parseTrackPath } from "@lib/api";
import { relPathOf } from "@state/userLibraryStore";
import { announceLibraryChanged } from "@lib/libraryEvents";
import { apiGet, apiPut, isApiError, useCurrentUser } from "../../data";
import { AnalysisFields } from "../../analysis/AnalysisFields";
import { InformationAnalysis } from "../../analysis/InformationAnalysis";
import { notify } from "../../ui/notifications";
import { useOffline } from "../../offline/useOffline";
import { useHeld } from "../../ui/react/useHeld";
import { Missing } from "../../ui/react/components/Missing";
import PanelModal from "../../ui/components/PanelModal";
import CoverTile from "../../ui/components/CoverTile";
import SongDetails from "./SongDetails";
import type { SongTrack } from "./songWindowStore";
import { isTagView, undoSongTags, type TagValue, type TagView } from "./songTags";
import { FIELDS, FIELD_GROUPS, NUMBERS, tagText as text, type Field } from "./songTagFields";
import "./song-window.css";

const PREFERENCE = "krobi.tags.skipSingleConfirmation";
const skipConfirmation = () => { try { return localStorage.getItem(PREFERENCE) === "true"; } catch { return false; } };

interface SongWindowProps {
  open: boolean;
  track: SongTrack | null;
  onClose: () => void;
  onMatch?: (track: SongTrack) => void;
  onAnalysisChanged?: () => void;
  // Legacy callers can keep their props while the shared window owns its write.
  onSave?: (payload: unknown) => void;
  saving?: boolean;
}

export default function SongWindow(props: SongWindowProps) {
  const held = useHeld(props.open ? props.track : null);
  return held ? <SongEditor key={held.path} {...props} track={held} /> : null;
}

function SongEditor({ open, track, onClose, onMatch, onAnalysisChanged }: SongWindowProps & { track: SongTrack }) {
  const { t } = useTranslation();
  const me = useCurrentUser();
  const offline = useOffline();
  const client = useQueryClient();
  const id = useId();
  const relPath = track.relPath || relPathOf(track);
  const query = useQuery({ queryKey: ["song-tags", relPath], queryFn: ({ signal }) => apiGet("/api/library/tags/{relPath}", { params: { path: { relPath: relPath! } }, signal }), enabled: open && !!relPath && !offline, refetchOnWindowFocus: false, refetchOnReconnect: false });
  const baseline = isTagView(query.data) ? query.data : null;
  const [draft, setDraft] = useState<Partial<Record<Field, string>>>({});
  const [manual, setManual] = useState<Set<string>>(new Set());
  const [confirm, setConfirm] = useState(false);
  const [remember, setRemember] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const pending = useRef(false);
  const owner = me.data?.role === "owner";
  const editable = owner && !offline && !!baseline?.writable && !query.isFetching && !saving;
  useEffect(() => {
    if (!open) { setDraft({}); setConfirm(false); setRemember(false); setMessage(""); setManual(new Set()); }
  }, [open]);


  const displayValue = (value: TagValue | undefined) => typeof value === "boolean" ? t(value ? "Yes" : "No") : text(value) || t("Empty");
  const album = typeof track.album === "object" ? track.album : null;
  const fallback = { ...track, album: album?.album || track.album, albumArtist: track.albumArtist ?? track.album_artist, trackNumber: track.trackNumber ?? track.track_number, trackTotal: track.trackTotal ?? track.track_total, discNumber: track.discNumber ?? track.disc_number, discTotal: track.discTotal ?? track.disc_total };
  const value = (field: Field) => draft[field] ?? text(baseline ? baseline.fields[field] : fallback[field] as TagValue);
  const patch: Record<string, TagValue> = {};
  for (const [field] of FIELDS) {
    const next = value(field).trim();
    if (baseline && field in draft && value(field) !== text(baseline.fields[field]) && next !== text(baseline.fields[field])) patch[field] = next === "" ? null : field === "compilation" ? next === "true" : NUMBERS.has(field) ? Number(next) : next;
  }
  const changed = Object.keys(patch);
  const names = changed.map(field => t(FIELDS.find(([key]) => key === field)![1]).toLocaleLowerCase()).join(", ");
  const refresh = () => {
    announceLibraryChanged();
    void client.invalidateQueries({ queryKey: ["library"] });
    void client.invalidateQueries({ queryKey: ["analysis"] });
    onAnalysisChanged?.();
  };
  const errorMessage = (error: unknown) => {
    const reason = error instanceof Error ? error.message : "";
    const body = isApiError(error) && error.body && typeof error.body === "object" && "detail" in error.body ? error.body.detail : null;
    const code = body && typeof body === "object" && "reason" in body ? String(body.reason) : reason;
    const errors = {
      "no-space": msg("Not enough space to write the file"), "hardlinked": msg("The file has hard links"),
      "write-failed": msg("Could not write the file"), "expired": msg("Undo has expired"),
      "changed-since": msg("The file changed on the nest. The edit could not be undone."),
      "undo-pending": msg("Undo is still in progress"), "undo-failed": msg("Could not undo the edit"),
      "unsupported-format": msg("This format cannot be edited"), "unreadable": msg("Could not read the file_present"),
    };
    return t(errors[code] || "Could not save the change");
  };
  const accept = (next: TagView) => {
    client.setQueryData(["song-tags", relPath], next);
    setDraft({});
  };
  const write = async () => {
    if (!editable || !baseline || !relPath || !changed.length || pending.current) return;
    pending.current = true; setSaving(true); setMessage("");
    const edited = [...changed];
    try {
      const result = await apiPut("/api/library/tags/{relPath}", { params: { path: { relPath } }, headers: { "If-Match": baseline.rev }, body: { set: patch, id3Version: 4 } });
      if (remember) { try { localStorage.setItem(PREFERENCE, "true"); } catch { /* Device storage can be unavailable. */ } }
      setConfirm(false);
      accept({ ...baseline, rev: result.rev, fields: { ...baseline.fields, ...patch } });
      setManual(previous => new Set([...previous, ...edited]));
      refresh();
      if (result.changed && result.editId) {
        const editId = result.editId;
        const savedNames = names;
        notify({ id: `song-tags-${editId}`, level: "success", sticky: true, message: t("Wrote {{fields}} to 1 file", { fields: savedNames }), action: { label: t("Undo"), onSelect: () => {
          void (async () => {
            try {
              await undoSongTags(editId);
              setManual(new Set());
              refresh();
              await client.invalidateQueries({ queryKey: ["song-tags", relPath] });
              notify({ level: "success", message: t("Edit undone") });
            } catch (error) { reportError('library', { userMessage: errorMessage(error), error }); }
          })();
        } } });
      }
    } catch (error) {
      setConfirm(false);
      const body = isApiError(error) ? error.body : null;
      const detail = body && typeof body === "object" && "detail" in body ? body.detail : null;
      const current = detail && typeof detail === "object" && "current" in detail ? detail.current : null;
      const reason = detail && typeof detail === "object" && "reason" in detail ? detail.reason : null;
      if (isApiError(error) && error.status === 409 && (reason === "changed-since" || isTagView(current))) {
        try {
          const next = isTagView(current) ? current : await apiGet("/api/library/tags/{relPath}", { params: { path: { relPath } } });
          if (!isTagView(next)) throw new Error("read-failed");
          // Reload only externally changed fields. Keep unrelated local drafts.
          setDraft(previous => Object.fromEntries(FIELDS.map(([field]) => [field, text(next.fields[field]) !== text(baseline.fields[field]) ? text(next.fields[field]) : previous[field] ?? text(next.fields[field])])));
          client.setQueryData(["song-tags", relPath], next);
          setMessage(t("The value changed on the nest. The latest version was loaded."));
          refresh();
        } catch (reloadError) { setMessage(errorMessage(reloadError)); }
      } else setMessage(errorMessage(error));
    } finally { pending.current = false; setSaving(false); }
  };

  const title = value("title") || track.title || t("(untitled)");
  const cover = album?.cover || (typeof track.cover === "string" ? track.cover : null) || buildCoverImageUrl(parseTrackPath(track.path).albumName);
  const unavailable = offline ? t("Editing tags requires the nest") : baseline?.reason ? errorMessage(new Error(baseline.reason)) : undefined;
  return <>
    <PanelModal open={open} title={t("Song")} className="song-window" width="max-w-3xl" accent="var(--teal)" onClose={onClose} dismissible={!saving}
      headerExtra={<span className="song-format">{baseline?.format || track.path.split(".").pop()?.toUpperCase()}</span>}
      footer={<>
        <span className="song-change-count" role="status">{t("{{n}} changes", { count: changed.length, n: changed.length })}</span>
        {onMatch && owner ? <button type="button" className="ti-edit-tags" disabled={offline || saving} onClick={() => onMatch(track)}>{t("Match…")}</button> : null}
        {owner ? <button type="button" className="ti-edit-tags" disabled={!editable} title={unavailable} onClick={() => document.getElementById(`${id}-title`)?.focus()}>{t("Edit tags")}</button> : null}
        <button type="button" className="k-btn k-btn--text" disabled={saving} onClick={onClose}>{t("Cancel")}</button>
        {owner ? <button type="submit" form={id} className="k-btn song-write" disabled={!editable || !changed.length} title={unavailable}>{saving ? t("Saving…") : t("Write to file")}</button> : null}
      </>}>
      <form id={id} className="song-body" onSubmit={event => { event.preventDefault(); if (editable && changed.length) { if (skipConfirmation()) void write(); else setConfirm(true); } }}>
        <header className="ti-head"><CoverTile src={cover} label={String(title)} className="ti-cover" /><div className="ti-names"><b className="ti-title">{title}</b><span className="ti-artist">{value("artist")}</span></div></header>
        <dl className="song-fields">
          {FIELD_GROUPS.map(group => <Fragment key={group[0][0]}>
            <dt>{group.length > 1 ? t("Year · track · disc") : <label htmlFor={`${id}-${group[0][0]}`}>{t(group[0][1])}</label>}</dt>
            <dd className={group.length > 1 ? "song-numbers" : undefined}>
            {group.map(([field, label]) => <Fragment key={field}>
              {field === "trackTotal" || field === "discTotal" ? <span aria-hidden>/</span> : null}
              <TagField id={`${id}-${field}`} field={field} label={t(label)} value={value(field)} original={baseline?.fields[field]} changed={field in patch} manual={manual.has(field)} editable={editable} saving={saving} unavailable={unavailable}
                onChange={next => setDraft(previous => ({ ...previous, [field]: next }))}
                onOriginal={() => setDraft(previous => ({ ...previous, [field]: text(baseline?.fields[field]) }))} />
            </Fragment>)}
            </dd>
          </Fragment>)}
        </dl>
        {relPath ? owner && !offline ? <AnalysisFields relPath={relPath} onChanged={refresh} inPlace /> : <dl className="song-fields"><InformationAnalysis relPath={relPath} track={track} readOnly /></dl> : null}
        <dl className="song-fields"><dt>{t("File")}</dt><dd className="song-path" title={relPath || undefined}>{relPath || <Missing kind="nodata" />}</dd></dl>
        {query.isError ? <div role="alert">{t("Could not read tags")} <button type="button" className="k-btn k-btn--text" onClick={() => void query.refetch()}>{t("Retry")}</button></div> : null}
        {message ? <div role="alert">{message}</div> : null}
        <SongDetails track={track} />
      </form>
    </PanelModal>
    {confirm ? <PanelModal open={open} role="alertdialog" title={t("Write {{fields}} to 1 file?", { fields: names })} width="max-w-lg" onClose={() => setConfirm(false)} dismissible={!saving} footer={<>
      <button type="button" className="k-btn k-btn--text" disabled={saving} onClick={() => setConfirm(false)}>{t("Cancel")}</button>
      <button type="button" className="k-btn song-write" disabled={saving} onClick={() => void write()}>{t("Write {{fields}}", { fields: names })}</button>
    </>}>
      <div className="song-confirm"><ul>{changed.map(field => <li key={field}><b>{t(FIELDS.find(([key]) => key === field)![1])}:</b> {displayValue(baseline?.fields[field])} → {displayValue(patch[field])}</li>)}</ul>
        <label><input type="checkbox" checked={remember} disabled={saving} onChange={event => setRemember(event.target.checked)} />{t("Don’t ask again for single songs")}</label>
      </div>
    </PanelModal> : null}
  </>;
}
