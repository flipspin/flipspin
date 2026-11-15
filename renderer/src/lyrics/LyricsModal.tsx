import { reportError } from '../lib/log';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { useAudioPlayer } from "@state/AudioPlayerContext";
import { isApiError, serverDetail } from "../data";
import { notify } from "../ui/notifications";
import { formatTime } from "@lib/formatting";
import { lyricSource } from "./copy";
import { bakeLyricsOffset, currentLineIndex, isSynced, parseLyrics, setLyricsOffset } from "./lrc";
import { clearSyncRun, startCurrentSync } from "./syncRunStore";
import { useLyricsSync } from "./useLyricsSync";
import { useLyricClock } from "./useLyricClock";
import { useLyricOffset } from "./useLyricOffset";
import LyricsSyncControl from "./LyricsSyncControl";
import { useLineSync, type LineSync } from "./useLineSync";
import {
  deleteLyrics, loadLyrics, lyricsKeyOf, saveLyrics, searchLyrics,
  useLocalLyricsEnabled, useLocalLyricsStatus, useLyricsFor, useLyricsModalMode,
} from "./lyricsStore";
import type { LyricsDoc, LyricsSearch, SavePayload } from "./lyricsStore";
import PanelModal from "../ui/components/PanelModal";
import { missingWord } from "../ui/react/components/missingWords";
import { Missing } from "../ui/react/components/Missing";
import { useHeld } from "../ui/react/useHeld";
import "./dialog.css";

interface LyricsModalProps {
  open: boolean;
  relPath: string | null;
  track?: { title?: string | null; artist?: string | null; duration?: number | null } | null;
  onClose: () => void;
}
interface Selection {
  payload: SavePayload;
  fitting: boolean;
  duration?: number | null;
  detail?: string;
  lineCount?: number;
  facts?: Record<string, unknown>;
}
interface Editor { selection: Selection; current: boolean; sync?: boolean }
const fromDoc = (doc: LyricsDoc): SavePayload => ({ kind: doc.kind, text: doc.text, source: doc.source, providerRef: doc.providerRef, edited: doc.edited });

/** A catalog choice stays in memory until Use/Save commits the single sidecar. */
export default function LyricsModal({ open, relPath: currentRelPath, track: currentTrack, onClose }: LyricsModalProps) {
  const { t } = useTranslation();
  const target = useHeld(useMemo(() => currentRelPath ? { relPath: currentRelPath, track: currentTrack } : null, [currentRelPath, currentTrack]));
  const relPath = target?.relPath ?? null;
  const { doc, known } = useLyricsFor(relPath);
  const engine = useLyricsSync(relPath || "", target?.track?.duration, t, open);
  const run = engine.run;
  const initialMode = useLyricsModalMode(relPath);
  const [search, setSearch] = useState<LyricsSearch | null>(null);
  const [searching, setSearching] = useState(true);
  const [selected, setSelected] = useState<Selection | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [confirmation, setConfirmation] = useState<Editor | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(0);
  const actionId = useRef(0);
  const actionBusy = useRef(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const retryUntil = useRef(0);

  const report = (failure: unknown) => {
    console.error("Lyrics action failed", failure);
    setError(isApiError(failure) ? serverDetail(failure) || failure.message : failure instanceof Error ? failure.message : String(failure));
  };
  const runSearch = async () => {
    if (!relPath || Date.now() < retryUntil.current) return;
    const id = ++requestId.current;
    setSearching(true);
    try {
      const result = await searchLyrics(relPath, {});
      if (id === requestId.current) { setSearch(result); retryUntil.current = 0; }
    } catch (failure) {
      if (id !== requestId.current) return;
      // Provider failures remain diagnostics; the window still offers Paste/Open.
      console.error("Lyrics search failed", failure);
      const seconds = isApiError(failure) ? Number((failure.body as { retryAfter?: number })?.retryAfter) : 0;
      retryUntil.current = Number.isFinite(seconds) && seconds > 0 ? Date.now() + seconds * 1000 : 0;
    } finally { if (id === requestId.current) setSearching(false); }
  };
  useEffect(() => {
    if (!open || !relPath) return;
    setSearch(null); setSelected(null); setSearching(true);
    setEditor(initialMode === "own" ? { current: false, selection: { fitting: true, payload: { kind: "plain", source: "manual", text: "", edited: true } } } : null);
    setError(null); setConfirmation(null); setSaving(false); retryUntil.current = 0;
    actionBusy.current = false;
    let active = true;
    void loadLyrics(relPath, { force: true }).catch(failure => { if (active) report(failure); });
    void runSearch();
    return () => { active = false; requestId.current++; actionId.current++; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, relPath, initialMode]);

  // Catalogs repeat the same text under several entries; one row per distinct text, best-ranked first.
  const seenTexts = new Set<string>();
  const candidates: Selection[] = (search?.candidates ?? []).filter(candidate => {
    const key = `${candidate.kind}\u0000${candidate.text.trim()}`;
    if (seenTexts.has(key)) return false;
    seenTexts.add(key);
    return true;
  }).map(candidate => ({
    payload: { kind: candidate.kind, text: candidate.text, source: candidate.provider, providerRef: candidate.providerRef },
    fitting: candidate.withinTolerance && (candidate.durationDeltaSeconds == null || Math.abs(candidate.durationDeltaSeconds) <= 2),
    duration: candidate.durationSeconds,
    detail: versionDetail(candidate),
    lineCount: candidate.lineCount,
    facts: { title: candidate.album || candidate.artist, durationSeconds: candidate.durationSeconds, durationDeltaSeconds: candidate.durationDeltaSeconds },
  }));
  const current: Selection | null = doc ? { payload: fromDoc(doc), fitting: true, detail: ["manual", "file"].includes(doc.source) ? undefined : versionDetail({ ...doc.result, ...doc }), lineCount: parseLyrics(doc.text).filter(line => line.text.trim()).length } : null;
  const preview = editor?.selection ?? selected ?? current ?? candidates[0] ?? null;
  const isCurrent = !editor && !selected && Boolean(doc);
  const busy = saving || Boolean(run?.running);
  const syncing = Boolean(run?.running);
  const empty = !preview && (!known || searching);
  const instrumental = preview?.payload.kind === "instrumental";
  const previewSynced = preview?.payload.kind === "synced" && isSynced(parseLyrics(preview.payload.text));
  const localEnabled = useLocalLyricsEnabled();
  const localStatus = useLocalLyricsStatus(relPath || "");
  const offset = useLyricOffset(relPath || "", isCurrent && open ? doc : null, previewSynced && !editor && !syncing, localEnabled,
    JSON.stringify([open, run?.startedAt, isCurrent ? "current" : editor ? "editor" : "catalog", isCurrent ? null : preview?.payload]), preview?.payload.text);
  const lineSync = useLineSync(relPath || "", preview?.payload.text || "", offset.shown,
    open && isCurrent && previewSynced && !editor && !busy, offset.saveShown);
  const useAndSync = !isCurrent && !instrumental && (!previewSynced || !preview?.fitting);
  const status = (selection: Selection) => selection.payload.kind === "instrumental" ? t("Instrumental")
    : selection.payload.kind !== "synced" ? t("Not timed")
    : !selection.fitting && selection.duration != null ? t("For {{duration}}", { duration: durationLabel(selection.duration) }) : t("Synced");
  const statusTitle = (selection: Selection) => selection.payload.kind === "synced" && !selection.fitting && selection.duration != null
    ? t("Timed for a {{version}} version; this song is {{song}}", { version: durationLabel(selection.duration), song: target?.track?.duration != null ? durationLabel(target.track.duration) : missingWord("unmeasured") }) : undefined;
  const versions = [...(current ? [{ selection: current, current: true }] : []), ...candidates.map(selection => ({ selection, current: false }))];
  const previewIndex = versions.findIndex(row => row.current ? isCurrent : !editor && !isCurrent && row.selection.payload.text === preview?.payload.text && row.selection.payload.providerRef === preview?.payload.providerRef);

  if (!relPath) return null;
  const choose = (selection: Selection | null) => { setSelected(selection); setEditor(null); setConfirmation(null); setError(null); };
  const paste = () => {
    setEditor({ current: false, selection: { fitting: true, payload: { kind: "plain", text: "", source: "manual", edited: true } } });
    setConfirmation(null); setError(null);
  };
  const adjusted = (selection: Selection): Selection => ({ ...selection, payload: { ...selection.payload, text: setLyricsOffset(selection.payload.text, Math.round(offset.shown * 1000)) } });
  const edit = () => { if (preview) { const selection = adjusted(preview); setEditor({ current: isCurrent, selection: { ...selection, payload: { ...selection.payload, edited: true } } }); setError(null); } };
  const commit = async (choice: Editor, force = false) => {
    if (actionBusy.current || busy || !known) return;
    if (doc?.edited && !choice.current && !force) { setConfirmation(choice); return; }
    actionBusy.current = true;
    const id = ++actionId.current;
    const before = doc;
    setConfirmation(null); setError(null); setSaving(true);
    const payload = choice.selection.payload;
    try {
      const saved = await saveLyrics(relPath, {
        ...payload,
        force: force || Boolean(choice.current && doc?.edited), expectedRevision: doc?.revision ?? "",
      });
      // The only reference to the replaced document belongs to this transient toast.
      notify({ level: "success", message: t("Now using {{source}}", { source: lyricSource(saved.source, t) }), durationMs: 5000,
        onExpire: () => {}, action: { label: t("Undo"), onSelect: () => {
          void (async () => {
            if (before) await saveLyrics(relPath, { ...fromDoc(before), restore: {
              fetchedAt: before.fetchedAt, title: before.title, artist: before.artist,
              lineConfidence: before.lineConfidence, lowLines: before.lowLines, result: before.result,
            }, force: true, expectedRevision: saved.revision });
            else {
              await deleteLyrics(relPath, saved.revision);
            }
            clearSyncRun(relPath);
            if (id === actionId.current) { setSelected(null); setEditor(null); }
          })().catch(failure => { reportError('lyrics', { userMessage: t("Couldn’t undo the lyric change"), error: failure }); });
        } },
      });
      clearSyncRun(relPath);
      if (id === actionId.current) { setSelected(null); setEditor(null); }
      if (choice.sync) await startCurrentSync(relPath, saved);
    } catch (failure) {
      if (id !== actionId.current) return;
      if (isApiError(failure) && failure.status === 409 && !force) {
        const latest = await loadLyrics(relPath, { force: true });
        if (latest?.edited) setConfirmation({ ...choice, current: false }); else report(failure);
      } else report(failure);
    } finally { if (id === actionId.current) { setSaving(false); actionBusy.current = false; } }
  };
  const sync = () => {
    if (busy || !engine.ready) return;
    if (useAndSync && preview) { void commit({ selection: adjusted(preview), current: false, sync: true }); return; }
    if (!doc) return;
    setError(null);
    void startCurrentSync(relPath, doc);
  };
  const bake = async () => {
    if (!doc || busy || actionBusy.current) return;
    if (bakeLyricsOffset(doc.text, Math.round(offset.shown * 1000)).clamps
      && !window.confirm(t("Some timestamps would fall before 0:00 and will be clamped to 0:00. Continue?"))) return;
    actionBusy.current = true; setSaving(true); setError(null);
    try { await offset.bake(); } catch (failure) { report(failure); }
    finally { actionBusy.current = false; setSaving(false); }
  };
  const importFile = async (file?: File) => {
    if (!file) return;
    if (!/\.(txt|lrc)$/i.test(file.name)) { report(new Error(t("Use an .lrc or .txt file"))); return; }
    const id = actionId.current;
    try {
      const text = await file.text();
      if (id === actionId.current) { setEditor({ current: false, selection: { fitting: true, payload: { kind: isSynced(parseLyrics(text)) ? "synced" : "plain", text, source: "file", edited: true } } }); setError(null); }
    } catch (failure) { if (id === actionId.current) report(failure); }
  };
  return <PanelModal open={open} onClose={onClose} onKeyDownCapture={lineSync.onKeyDownCapture} title={<>{target?.track?.title || <Missing kind="noTitle" />}<span className="lyrics-track">{target?.track?.artist || <Missing kind="noArtist" />} · {target?.track?.duration != null ? formatTime(target.track.duration) : <Missing kind="unmeasured" />}</span></>} accent="var(--purple)" className="lyrics-dlg"
    footer={<>
      <div className="lyrics-footer-links">
        {instrumental ? <button type="button" className="k-btn k-btn--text" disabled={busy} onClick={paste}>{t("Paste lyrics")}</button> : doc && <>
          <button type="button" className="k-btn k-btn--text" disabled={busy} onClick={() => { if (current) { const selection = isCurrent ? adjusted(current) : current; setSelected(null); setEditor({ current: true, selection: { ...selection, payload: { ...selection.payload, edited: true } } }); setConfirmation(null); setError(null); } }}>{t("Edit text")}</button>
          <button type="button" className="k-btn k-btn--text lyrics-delete" disabled={busy} onClick={() => { void deleteLyrics(relPath).then(() => { clearSyncRun(relPath); choose(null); }).catch(report); }}>{t("Delete lyrics")}</button>
        </>}
      </div>
      <div className={`lyrics-footer-actions${confirmation ? " is-confirmation" : ""}`}>
        {isCurrent && previewSynced && !editor && !lineSync.active && offset.shown !== 0 && <button type="button" className="k-btn k-btn--text lyrics-bake" disabled={busy} title={t("For players that ignore the offset tag")} onClick={() => void bake()}>{t("Write into timestamps")}</button>}
        {confirmation ? <><span>{t("Lose your edits?")}</span><button type="button" className="k-btn k-btn--text" onClick={() => setConfirmation(null)}>{t("Keep mine")}</button><button type="button" className="k-btn k-btn--coral" onClick={() => void commit(confirmation, true)}>{t("Use {{source}}", { source: lyricSource(confirmation.selection.payload.source, t) })}</button></>
          : editor ? <><button type="button" className="k-btn k-btn--text" disabled={saving} onClick={() => { setEditor(null); setError(null); }}>{t("Cancel")}</button><button type="button" className="k-btn k-btn--coral" disabled={saving || !known || !editor.selection.payload.text.trim()} onClick={() => void commit(editor)}>{t("Save")}</button></>
          : preview && !isCurrent ? <><button type="button" className="k-btn" disabled={busy} onClick={edit}>{t("Edit")}</button><button type="button" className="k-btn k-btn--coral" disabled={busy || !known} onClick={() => void commit({ selection: adjusted(preview), current: false })}>{!previewSynced ? t("Use untimed lyrics") : !preview.fitting ? t("Use as is") : t("Use these lyrics")}</button></> : null}
      </div>
    </>}>
    <div className="lyrics-dlg-body">
      <div className="lyrics-preview-column">
        {error && <span role="alert" className="lyrics-error" title={t("Couldn't save lyrics")}>{t("Couldn't save lyrics")}</span>}
        {editor ? <textarea className="k-field lyrics-editor" aria-label={t("Lyric text")} value={editor.selection.payload.text} disabled={busy} onChange={event => {
          const text = event.target.value;
          setEditor({ ...editor, selection: { ...editor.selection, payload: { ...editor.selection.payload, text, kind: isSynced(parseLyrics(text)) ? "synced" : "plain", edited: true } } }); setConfirmation(null);
        }} /> : empty ? <div className="lyrics-skeleton" aria-label={t("Searching…")}>{Array.from({ length: 5 }, (_, i) => <div key={i} />)}</div>
          : instrumental ? <div className="lyrics-empty" role="status">{t("No vocals")}</div>
          : preview ? <LyricPreview text={preview.payload.text} offset={offset.shown} relPath={relPath} active={open && preview.payload.kind === "synced"} lineSync={lineSync} /> : null}
      </div>
      <aside className="lyrics-sidebar" aria-label={t("Lyric versions")}>
        <h4 className="lyrics-section-title">{t("VERSIONS")}</h4>
        <div className="lyrics-versions" role="group" aria-label={t("Lyric versions")} onKeyDown={event => {
          if (!["ArrowUp", "ArrowDown"].includes(event.key) || busy) return;
          const rows = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button"));
          const index = rows.indexOf(event.target as HTMLButtonElement);
          if (index < 0) return;
          event.preventDefault();
          const next = (index + (event.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length;
          rows[next].focus(); rows[next].click();
        }}>
          {versions.map((row, index) => {
            const selection = row.selection;
            const detail = [selection.detail, selection.lineCount != null ? t("{{n}} lines", { count: selection.lineCount, n: selection.lineCount }) : ""].filter(Boolean).join(" · ");
            return <button type="button" key={row.current ? "current" : selection.payload.providerRef || index} className="lyrics-version" aria-current={row.current ? "true" : undefined} aria-pressed={index === previewIndex} disabled={busy}
              title={statusTitle(selection) || [lyricSource(selection.payload.source, t), detail].filter(Boolean).join(" · ")} onClick={() => choose(row.current ? null : selection)}>
              <span className="lyrics-version-check" aria-hidden>{row.current ? "✓" : ""}</span>
              <span className="lyrics-version-main"><span className="lyrics-version-source">{lyricSource(selection.payload.source, t)}{row.current && <> <span className="lyrics-current-tag">{t("Current")}</span></>}</span><span className="lyrics-version-detail">{detail || <Missing kind="nodata" />}</span></span>
              <span className="lyrics-version-status" data-state={row.current && syncing ? "running" : selection.payload.kind === "synced" && selection.fitting ? "synced" : "plain"}><i aria-hidden />{row.current && syncing ? t("Syncing") : status(selection)}</span>
            </button>;
          })}
          {!preview && <span role="status" title={!empty ? (search?.providers ?? []).map(provider => lyricSource(provider, t)).join(", ") : undefined}>{empty ? t("Searching…") : t("No lyrics found")}</span>}
        </div>
        <div className="lyrics-import-links"><button type="button" disabled={busy} onClick={paste}>{t("Paste your own…")}</button><button type="button" disabled={busy} onClick={() => fileInput.current?.click()}>{t("Open file…")}</button></div>
        {!preview && !empty && <button type="button" className="k-btn k-btn--text" onClick={() => void runSearch()}>{t("Search again")}</button>}
        {preview && !instrumental && !editor && <LyricsSyncControl key={isCurrent ? "current" : preview.payload.providerRef || preview.payload.text} t={t} inline sidebar
          lyric={isCurrent && doc ? doc : { ...preview.payload, edited: Boolean(preview.payload.edited), result: preview.facts }}
          engine={isCurrent ? engine : { ...engine, run: null }} onSync={sync} actionEnabled={!busy && (isCurrent || useAndSync)} useAndSync={useAndSync} lineSync={isCurrent ? lineSync : undefined} statusTitle={statusTitle(preview)} statusLabel={!isCurrent ? status(preview) : undefined}
          shown={offset.shown} onChange={offset.setShown} onStep={offset.nudge} onReset={offset.reset} saveState={isCurrent ? localStatus || offset.saveState : "idle"} />}
      </aside>
      <input ref={fileInput} type="file" accept=".txt,.lrc,text/plain" aria-label={t("Import .txt or .lrc")} hidden onChange={event => { const file = event.target.files?.[0]; event.target.value = ""; void importFile(file); }} />
    </div>
  </PanelModal>;
}

function LyricPreview({ text, offset, relPath, active, lineSync }: { text: string; offset: number; relPath: string; active: boolean; lineSync: LineSync }) {
  const player = useAudioPlayer();
  const lines = useMemo(() => parseLyrics(text, offset * 1000), [text, offset]);
  const matching = active && lyricsKeyOf(player.nowPlaying) === relPath;
  const clock = useLyricClock(player.audioRef, matching, player.isPlaying && matching);
  const current = useSyncExternalStore(clock.subscribe, () => matching ? currentLineIndex(lines, clock.read()) : -1);
  // Untimed stanza breaks must survive preview and subsequent alignment.
  if (!isSynced(lines)) return <pre className="lyrics-preview">{text}</pre>;
  return <div className={`lyrics-preview is-following${lineSync.active ? " is-picking" : ""}`}>{lines.map((line, index) => <p key={index} aria-current={index === current ? "true" : undefined}>{lineSync.active ? <button type="button" aria-pressed={index === lineSync.picked} onClick={() => lineSync.pick(index)}>{line.text || "\u00a0"}</button> : line.text || "\u00a0"}</p>)}</div>;
}
const durationLabel = (seconds: number) => formatTime(seconds).replace(/^0(?=\d:)/, "");
const versionDetail = (record: { album?: string | null; artist?: string | null; durationSeconds?: number | null }) =>
  [record.album || record.artist, record.durationSeconds != null ? durationLabel(record.durationSeconds) : ""].filter(Boolean).join(" · ");
