import React, { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { TFunction } from "i18next";
import { Clock3, Minus, Plus, RotateCcw, Timer } from "lucide-react";
import { formatTime } from "@lib/formatting";
import { enginePhase, lyricSource } from "./copy";
import { Missing } from "../ui/react/components/Missing";
import { reasons, useCompute } from "../settings/background/data";
import type { SchemaComputeSummary } from "../api/generated/schema";
import { parseLyrics } from "./lrc";
import type { LyricsDoc } from "./lyricsStore";
import { openSyncAddons, type LyricsSyncEngine } from "./useLyricsSync";
import type { LineSync } from "./useLineSync";
import "./sync.css";
import {
  formatOffset,
  HOLD_DELAY_MS,
  HOLD_REPEAT_MS,
  NUDGE_S,
  parseOffsetDraft,
  syncFootText,
} from "./overlayModel";

/** One glass panel for lyric provenance, engine work and fine adjustment. */
export default function LyricsSyncControl({ t, lyric, engine, onSync, actionEnabled = true, inline = false, sidebar = false, statusLabel, statusTitle, open = false, onToggle, onClose, shown, onChange, onStep, onReset, saveState, lineSync, useAndSync = false }: {
  lineSync?: LineSync;
  useAndSync?: boolean;
  t: TFunction;
  lyric: Pick<LyricsDoc, "kind" | "text" | "source" | "edited"> & Partial<LyricsDoc>;
  engine: LyricsSyncEngine;
  onSync: () => void;
  actionEnabled?: boolean;
  inline?: boolean;
  sidebar?: boolean;
  statusLabel?: string;
  statusTitle?: string;
  open?: boolean;
  onToggle?: () => void;
  onClose?: () => void;
  shown: number;
  onChange: (seconds: number) => void;
  onStep: (delta: number) => void;
  onReset: () => void;
  saveState: string;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const nowRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => { if (lineSync?.active) nowRef.current?.focus(); }, [lineSync?.active]);
  const [draft, setDraft] = useState<string | null>(null);

  useEffect(() => {
    if (!open || lineSync?.active) return undefined;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && e.target instanceof Node && !rootRef.current.contains(e.target)) onClose?.();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open, onClose, lineSync?.active]);

  const commitDraft = () => {
    if (draft === null) return;
    const n = parseOffsetDraft(draft);
    if (n !== null) onChange(n);
    setDraft(null);
  };

  const foot = syncFootText(saveState, t);
  const synced = lyric.kind === "synced";
  const running = Boolean(engine.run?.running);
  const failed = !running && Boolean(engine.run?.error);
  const phase = engine.run?.phase;
  const queued = running && (phase === "queued" || phase === "en cola");
  const compute = useCompute(queued, queued);
  const waiting = queued && !compute.isError ? queuedCopy(compute.data, t) : null;
  const phaseLabel = enginePhase(phase === "aligning" ? "alineando" : phase === "saving" ? "guardando"
    : ["queued", "en cola", "claimed", "decoding", "decodificando", "separating", "separando", "transcribiendo", "alineando", "guardando", "uploading", "subiendo"].includes(phase || "") ? phase : "en cola", t);
  const percent = Math.round(Math.max(0, Math.min(100, engine.run?.percent ?? 0)));
  const status = waiting ? t("Queued") : running ? t("Syncing · {{percent}} %", { percent }) : failed ? t("Couldn’t sync")
    : synced ? lyric.edited ? t("Synced · edited ✎") : t("Synced") : t("Not timed");
  const krobi = Boolean(lyric.result?.timingSource) || /^(aligned:|stt:)/.test(lyric.source);
  const source = lyricSource(lyric.source, t);
  const heading = synced ? krobi ? t("Timed by Flipspin") : ["manual", "file"].includes(lyric.source) ? source : t("Timed by {{source}}", { source })
    : ["manual", "file"].includes(lyric.source) ? source : t("Words from {{source}}", { source });
  const facts = lyricFacts(lyric, t, engine.songDuration);

  return (
    <div className={`lyrics-sync${inline ? " lyrics-sync--inline" : ""}${sidebar ? " lyrics-sync--sidebar" : ""}`} ref={rootRef}>
      {!inline && <button
        type="button"
        className={`waveform-btn${open || shown !== 0 ? " waveform-btn--on" : ""}`}
        onClick={onToggle}
        aria-expanded={open}
        aria-haspopup="dialog"
        title={t("Adjust the lyrics timing")}
      >
        <Timer size={13} strokeWidth={2.5} aria-hidden />
        {shown !== 0 ? formatOffset(shown) : t("Sync_verb")}
      </button>}
      {(inline || open) && (
        <div className="lyrics-pop" role={inline ? "group" : "dialog"} aria-label={lineSync?.active ? t("Sync to a line") : t("Lyrics sync")}>
          {lineSync?.active ? <>
            <div className="lyrics-pop-head"><span className="lyrics-pop-title">{t("SYNC TO A LINE")}</span><button type="button" className="lyrics-sync-link" onClick={lineSync.cancel}>{t("Cancel")}</button></div>
            <div className="lyrics-now-prompt">{t("Press when it's sung")}</div>
            <div className="lyrics-now-line">“{lineSync.line}”</div>
            <button ref={nowRef} type="button" className="lyrics-krobi-action lyrics-now" onClick={lineSync.now}>{t("Now")}{sidebar ? " " : " · "}<kbd>{t("Space")}</kbd></button>
            <div className="lyrics-now-hint">{t("Click another line to change it")}</div>
          </> : <>
          <div className="lyrics-pop-head">
            <span className="lyrics-pop-title">{t("SYNC")}</span>
            <span className="lyrics-pop-status" role={sidebar ? "status" : undefined} data-state={running ? "running" : failed ? "failed" : synced ? "synced" : "plain"} title={failed ? engine.run?.error : statusTitle}><i aria-hidden />{!running && !failed ? statusLabel || (sidebar ? synced ? t("Synced") : t("Not timed") : status) : status}</span>
          </div>
          {(synced || running || !sidebar) && <div className="lyrics-pop-source">{waiting ? waiting.title : running ? t("Timing from audio") : heading}</div>}
          {running && <div className="lyrics-pop-facts" title={waiting?.tooltip}>{waiting ? waiting.detail : [engine.machine, engine.backend, phaseLabel, t("{{n}} s", { n: engine.elapsed })].filter(Boolean).join(" · ") || <Missing kind="nodata" />}</div>}
          {(synced || !sidebar) && !running && facts && <div className="lyrics-pop-facts" title={krobi && lyric.lowLines != null ? t("Lines the aligner was unsure of (confidence under 0.15)") : undefined}>{facts}</div>}
          {running && <div className="lyrics-sync-work">{!waiting && <progress className="lyrics-engine-progress" aria-label={t("Syncing")} value={percent} max={100} />}<div className="lyrics-sync-work-row"><SyncSteps phase={engine.run?.phase || ""} t={t} /><button type="button" className="lyrics-sync-link" disabled={!engine.run?.progressId} onClick={engine.cancel}>{t("Cancel")}</button></div></div>}
          {synced && !running && <div className="lyrics-pop-row" title={foot ?? undefined}>
            <StepButton onStep={(size) => onStep(-size)} label={t("Delay")}>
              <Minus size={14} strokeWidth={3} aria-hidden />
            </StepButton>
            <label className={`lyrics-pop-field${shown !== 0 ? " is-adjusted" : ""}`}>
              <input
                type="text"
                inputMode="decimal"
                value={draft === null ? formatOffset(shown).replace(/ s$/, "") : draft}
                onFocus={(e) => { setDraft(shown.toFixed(1)); e.target.select(); }}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={commitDraft}
                onKeyDown={(e) => {
                  if (e.key === "ArrowUp" || e.key === "ArrowDown") { e.preventDefault(); onStep((e.key === "ArrowUp" ? 1 : -1) * (e.shiftKey ? 1 : NUDGE_S)); setDraft(null); }
                  if (e.key === "Enter") { e.preventDefault(); e.currentTarget.blur(); }
                  if (e.key === "Escape") { e.preventDefault(); setDraft(null); e.currentTarget.blur(); }
                }}
                aria-label={t("Offset in seconds")}
              />
              <span>s</span>{" "}
              {shown !== 0 && <span className="lyrics-offset-direction">{shown > 0 ? t("sooner") : t("later")}</span>}
            </label>
            <StepButton onStep={onStep} label={t("Advance")}>
              <Plus size={14} strokeWidth={3} aria-hidden />
            </StepButton>
            <button type="button" className="lyrics-step" onClick={onReset} disabled={shown === 0} aria-label={t("Reset the sync")} title={t("Reset the sync")}>
              <RotateCcw size={14} strokeWidth={3} aria-hidden />
            </button>
          </div>}
          {synced && !running && lineSync && <button type="button" className="lyrics-line-sync" onClick={lineSync.enter}><Clock3 size={14} aria-hidden />{t("Sync to a line")}</button>}
          {actionEnabled && !running && <LyricsEngineAction t={t} synced={synced} engine={engine} onSync={onSync} useAndSync={useAndSync} />}
          </>}
        </div>
      )}
    </div>
  );
}

function queuedCopy(summary: SchemaComputeSummary | undefined, t: TFunction) {
  const kind = summary?.kinds.find(kind => kind.kind === "align");
  if (!kind?.reason) return null;
  const name = kind.waitingFor;
  const computer = kind.reason === "helpers-offline" && name ? summary?.computers.find(computer => computer.name === name) : undefined;
  const seen = computer ? new Date(computer.lastSeenAt * 1000) : null;
  const time = seen ? `${String(seen.getHours()).padStart(2, "0")}:${String(seen.getMinutes()).padStart(2, "0")}` : "";
  const detail = computer?.state === "asleep" ? t("Asleep · starts when it wakes")
    : computer?.state === "closed" ? t("Closed · starts when it opens")
    : computer?.state === "offline" ? t("Offline · starts when it's back")
    : t(reasons[kind.reason === "helpers-only" ? "no-helper" : kind.reason]);
  const tooltip = computer?.state === "asleep" ? t("{{name}} is asleep · last seen {{time}}", { name, time })
    : computer?.state === "closed" ? t("{{name}} is closed · last seen {{time}}", { name, time })
    : computer?.state === "offline" ? t("{{name}} is offline · last seen {{time}}", { name, time }) : undefined;
  return { title: kind.reason === "helpers-offline" && name ? t("Waiting for {{name}}", { name }) : t("Queued"), detail, tooltip };
}

/** Both surfaces use the same engine readiness and add-on navigation. */
export function LyricsEngineAction({ t, synced, engine, onSync, disabled = false, useAndSync = false }: {
  t: TFunction; synced: boolean; engine: LyricsSyncEngine; onSync: () => void; disabled?: boolean; useAndSync?: boolean;
}) {
  const details = [engine.machine, engine.backend, engine.estimate != null ? t("≈ {{n}} s", { n: engine.estimate }) : null].filter(Boolean).join(" · ") || engine.label;
  const title = !engine.available ? t("Needs the Lyrics add-on · opens Settings → Engines")
    : useAndSync ? `${t("Uses these lyrics, then times them to this song")} · ${details}` : details;
  return <button type="button" className="lyrics-krobi-action" title={title} disabled={disabled || (engine.available && !engine.ready) || Boolean(engine.run?.running)} onClick={engine.available ? onSync : openSyncAddons}>
    {useAndSync ? t("Use and sync with Flipspin") : synced ? t("Re-sync with Flipspin") : t("Sync with Flipspin")}{!engine.available && <> <span className="lyrics-addon-pill">{t("Add-on")}</span></>}
  </button>;
}

function SyncSteps({ phase, t }: { phase: string; t: TFunction }) {
  const current = ["decoding", "decodificando"].includes(phase) ? 0 : ["separating", "separando"].includes(phase) ? 1
    : ["aligning", "alineando"].includes(phase) ? 2 : ["saving", "guardando", "uploading", "subiendo"].includes(phase) ? 3 : -1;
  return <div className="lyrics-engine-steps">{[t("decode"), t("separate"), t("align"), t("save")].map((step, index) => <React.Fragment key={step}>
    {index > 0 && " · "}<span className={index === current ? "is-current" : undefined} aria-current={index === current ? "step" : undefined}>{step}{index < current ? " ✓" : ""}</span>
  </React.Fragment>)}</div>;
}

function lyricFacts(lyric: Pick<LyricsDoc, "kind" | "text" | "source"> & Partial<LyricsDoc>, t: TFunction, songDuration?: number | null): string {
  const count = parseLyrics(lyric.text).filter(line => line.text.trim()).length;
  if (lyric.kind !== "synced") return t("{{n}} lines · no timing", { n: count });
  const result = lyric.result;
  if (result?.timingSource || /^(aligned:|stt:)/.test(lyric.source)) {
    // fetchedAt changes on ordinary saves; it is not a reliable timing date.
    return [typeof result?.helperName === "string" ? result.helperName : null,
      lyric.lowLines != null ? t("{{n}} of {{total}} lines unsure", { n: lyric.lowLines.length, total: count }) : null].filter(Boolean).join(" · ");
  }
  const metadata: Record<string, unknown> = { ...result, ...lyric };
  const duration = typeof metadata.durationSeconds === "number" ? metadata.durationSeconds : null;
  const delta = typeof metadata.durationDeltaSeconds === "number" ? metadata.durationDeltaSeconds
    : duration != null && songDuration ? Math.round((duration - songDuration) * 10) / 10 : null;
  return [lyric.title || (typeof result?.title === "string" ? result.title : null), duration == null ? null : formatTime(duration).replace(/^0(?=\d:)/, ""),
    delta == null ? null : t("Δ {{delta}} s", { delta: `${delta < 0 ? "−" : "+"}${Math.abs(delta)}` })].filter(Boolean).join(" · ");
}

/** A − / + step: a press moves once, holding repeats; a keyboard click moves once. */
function StepButton({ onStep, label, children }: { onStep: (size: number) => void; label: string; children: ReactNode }) {
  const timer = useRef<number | null>(null);
  const stop = useCallback(() => {
    if (timer.current !== null) { window.clearTimeout(timer.current); timer.current = null; }
  }, []);
  useEffect(() => stop, [stop]);
  const down = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return;
    stop();
    const started = Date.now();
    const shifted = e.shiftKey;
    onStep(shifted ? 1 : NUDGE_S);
    const repeat = () => { onStep(shifted ? 1 : Date.now() - started >= 1000 ? 0.5 : NUDGE_S); timer.current = window.setTimeout(repeat, HOLD_REPEAT_MS); };
    timer.current = window.setTimeout(repeat, HOLD_DELAY_MS);
  };
  return (
    <button
      type="button"
      className="lyrics-step"
      onPointerDown={down}
      onPointerUp={stop}
      onPointerLeave={stop}
      onPointerCancel={stop}
      // A pointer press already stepped on pointerdown; only a keyboard click (detail 0) steps here.
      onClick={(e) => { if (e.detail === 0) onStep(e.shiftKey ? 1 : NUDGE_S); }}
      aria-label={label}
      title={label}
    >
      {children}
    </button>
  );
}
