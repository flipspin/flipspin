import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { enginePhase } from "./copy";
import { cancelEngineRun, closeLyrics, openLyricsModal, useLyricsJobs, watchJobs, type LyricsDoc } from "./lyricsStore";
import { refreshMac, useMacEngine } from "./macEngine";
import { isSynced, parseLyrics } from "./lrc";
import { syncEngineState } from "./syncEngine";
import { startSync, useSyncRun } from "./syncRunStore";
import "./timing.css";

interface Props {
  textActions?: boolean;
  relPath: string;
  doc: Pick<LyricsDoc, "text" | "kind" | "lowLines"> | null;
  known: boolean;
  onSearch?: () => void;
  onReview?: (index: number) => void;
  onSettings?: () => void;
  acquisition?: boolean;
  syncLabel?: string;
  beforeSync?: () => Promise<boolean>;
}

export default function LyricsTimingRow({ relPath, doc, known, onSearch, onReview, onSettings, acquisition = true, syncLabel, beforeSync, textActions = false }: Props) {
  const action = textActions ? "k-btn k-btn--text" : "waveform-btn";
  const { t } = useTranslation();
  const id = useId();
  const jobs = useLyricsJobs();
  const mac = useMacEngine();
  const run = useSyncRun(relPath);
  const [saving, setSaving] = useState(false);
  const [repairing, setRepairing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => watchJobs(), []);
  useEffect(() => {
    void refreshMac();
  }, []);
  useEffect(() => { setError(null); }, [relPath]);
  const lines = parseLyrics(doc?.kind === "instrumental" ? "" : doc?.text);
  // Keep stanza breaks for plain lyrics; unfold repeated LRC stamps for a resync.
  const synced = isSynced(lines);
  const words = synced ? lines.map((line) => line.text).filter(Boolean).join("\n") : doc?.kind === "plain" ? doc.text.trim() : "";
  const hasWords = lines.some((line) => Boolean(line.text.trim()));
  const engine = syncEngineState(jobs?.engine, mac, t);
  const workers = jobs?.engine?.queue?.agents ?? [];
  const workerStatus = !jobs?.engine ? `${t("Sync worker")} · ${t("Offline")}` : jobs.engine.mode === "agent"
    ? workers.length
      ? workers.map((worker) => `${worker.name || t("Computer")} · ${!engine.ready ? t("Unavailable") : worker.busy ? t("Busy · will queue") : t("Available")}`).join(" · ")
      : jobs.engine.worker ? `${t("Computer")} · ${t("Offline")}` : t("No helper")
    : `${t("Local engine")} · ${engine.ready ? t("Available") : t("Unavailable")}`;
  const low = [...new Set(doc?.lowLines ?? [])].filter((i) => synced && i >= 0 && i < lines.length).sort((a, b) => a - b);
  const phase = run?.error === "connection" ? t("disconnected · retrying") : enginePhase(run?.phase, t);
  const state = run?.running ? phase : !known ? t("Loading…") : !hasWords ? t("lyrics missing") : run?.error ? t("Couldn’t sync") : engine.ready ? (synced ? t("Already synced_synced") : t("untimed")) : engine.label;
  const disabled = !known || !hasWords || !engine.ready || run?.running || saving;
  const settings = () => {
    closeLyrics();
    onSettings?.();
    window.dispatchEvent(new CustomEvent("krobi-show-settings", { detail: { section: "complementos" } }));
  };
  const repair = async () => {
    setError(null);
    setRepairing(true);
    try {
      settings();
    } catch (e) { setError(e instanceof Error ? e.message : t("Could not install")); }
    finally { setRepairing(false); }
  };
  const sync = async () => {
    setSaving(true); setError(null);
    try {
      if (beforeSync && !await beforeSync()) return;
      await startSync(relPath, words);
    } catch (e) { setError(e instanceof Error ? e.message : t("Couldn’t sync")); }
    finally { setSaving(false); }
  };
  return (
    <section className="lyrics-timing" aria-label={t("timing")}>
      <div className="lyrics-timing-row">
        <span className="lyrics-timing-state" role="status" aria-label={t("Sync worker")}>{workerStatus}</span>
        {acquisition && <span className="lyrics-timing-label">{t("timing")}</span>}
        <span id={id} className="lyrics-timing-state" role="status" title={run?.error || (jobs?.engine?.mode === "agent" ? mac.status?.installError : jobs?.engine?.installError) || undefined}>{!acquisition && !hasWords && !run?.running ? engine.label : state}{run?.running && run.percent != null ? ` · ${Math.round(run.percent)}%` : ""}</span>
        {(hasWords || acquisition) && <button type="button" className={textActions ? `${action} k-btn--text-primary` : `waveform-btn${hasWords && !synced ? " waveform-btn--on" : ""}`} disabled={Boolean(disabled)} aria-describedby={id} onClick={() => void sync()}>
          {syncLabel || (synced ? t("Resync") : t("Sync_verb"))}
        </button>}
        {run?.running && run.progressId && <button type="button" className={action} onClick={() => {
          void cancelEngineRun(run.progressId).catch((e) => setError(e instanceof Error ? e.message : t("Could not cancel")));
        }}>{t("Cancel")}</button>}
        {low.length > 0 && onReview && <button type="button" className={action} onClick={() => onReview(low[0])}>{t("Review {{n}}", { n: low.length })}</button>}
        {!engine.ready && !run?.running && <>
          {acquisition && !hasWords && <span className="lyrics-timing-state">{engine.label}</span>}
          {engine.repair && <button type="button" className={action} disabled={repairing} onClick={() => void repair()}>{t("Install in Engines")}</button>}
        </>}
        {acquisition && known && !hasWords && <>
          <button type="button" className={action} onClick={onSearch ?? (() => openLyricsModal(relPath))}>{t("Search")}</button>
          <button type="button" className={action} onClick={() => openLyricsModal(relPath, "own")}>{t("Paste or import lyrics")}</button>
        </>}
      </div>
      {error && <span className="lyrics-error" role="alert">{error}</span>}
    </section>
  );
}
