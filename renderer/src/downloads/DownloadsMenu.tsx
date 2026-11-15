import { OutboxJobs } from "../offline/OutboxJobs";
import { useOutbox } from "../offline/useOffline";
import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { Check, CloudOff, ListTodo, RotateCw, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { openUpload } from "../uploads/actions";
import { msg } from "../i18n";
import {
  cancelJob, clearJob, dismissFinished, getState, isLive, loadFailures, reconcile, retryJob, subscribe,
  type Job, type JobView,
} from "./downloadsStore";
import DownloadRetryModal from "./DownloadRetryModal";
import { Popover } from "../ui/react/components/Popover";
import FailedSongs from "./FailedSongs";
import JobRowLayout, { actionClass } from "./JobRowLayout";
import { acquisitionGroup, type GroupedWorkRow, type WorkGroup } from "./jobRowPresentation";
import { AcquisitionRow, LocalDownloadRows, type WorkExtensions } from './AcquisitionRows';
import { acquisitionLive, clearFinishedAcquisitions, refreshAcquisitions, useAcquisitionJobs, withoutAcquisitionStages } from './acquisitionJobs';
import { useOfflineStorage } from '../offline/useOfflineStorage';
import './jobs.css';

interface KindPresentation {
  mark: string;
  label: string;
  color: string;
  running: string;
  helper?: boolean;
}
// The generated wire union makes a new server kind a typecheck obligation.
const KINDS: Record<JobView["kind"], KindPresentation> = {
  "source-install": { mark: "PL", label: msg("Plugin"), color: "var(--yellow)", running: msg("Installing") },
  upload: { mark: "UP", label: msg("Upload music"), color: "var(--blue)", running: msg("Uploading") },
  download: { mark: "DL", label: msg("Download"), color: "var(--green)", running: msg("Downloading") },
  match: { mark: "CO", label: msg("Matches"), color: "var(--blue)", running: msg("Finding matches") },
  import: { mark: "IM", label: msg("Import"), color: "var(--green)", running: msg("Importing") },
  "lyrics-search": { mark: "LE", label: msg("Lyrics_plural"), color: "var(--purple)", running: msg("Searching for lyrics") },
  "lyrics-helper": { mark: "LE", label: msg("Lyrics_plural"), color: "var(--purple)", running: msg("Transcribing"), helper: true },
  stems: { mark: "SP", label: msg("Split songs"), color: "var(--blue)", running: msg("Separating vocals"), helper: true },
  scan: { mark: "BI", label: msg("Scan library"), color: "var(--yellow)", running: msg("Scanning") },
  analysis: { mark: "AN", label: msg("Analysis"), color: "var(--yellow)", running: msg("Analyzing"), helper: true },
  "library-edit": { mark: "ED", label: msg("Edit tags"), color: "var(--green)", running: msg("Saving tags") },
};
const DEFAULT_KIND: KindPresentation = { mark: "TR", label: msg("Job"), color: "var(--ink-3)", running: msg("Processing") };
function presentation(kind: string): KindPresentation {
  return Object.prototype.hasOwnProperty.call(KINDS, kind) ? KINDS[kind as JobView["kind"]] : DEFAULT_KIND;
}
function waitingForHelper(job: JobView) {
  return (job.state === "queued" || job.state === "waiting") && (presentation(job.kind).helper || !!job.waitingOn);
}
const PHASES: Record<string, string> = {
  resolving: msg("Finding matches"),
  searching: msg("Searching"), downloading: msg("Downloading"), normalizing: msg("Normalizing"),
  tagging: msg("Tagging"), embedding_cover: msg("Saving artwork"), lyrics: msg("Searching for lyrics"),
  decodificando: msg("Decoding"), separando: msg("Separating vocals"),
  transcribiendo: msg("Transcribing"), alineando: msg("Aligning"), guardando: msg("Saving"),
  entorno: msg("Creating the environment"), paquetes: msg("Installing packages"), modelos: msg("Downloading models"),
};
const HELPERS: Record<string, string> = {
  asleep: msg("asleep"), closed: msg("closed"), offline: msg("offline"), outdated: msg("outdated"),
};
const GROUPS = { running: msg("Running_progress"), waiting: msg("Waiting"), terminal: msg("Finished") };
function groupOf(job: JobView): WorkGroup {
  return job.state === "running" ? "running" : isLive(job) ? "waiting" : "terminal";
}

/** One topbar control, including when the nest is idle. */
export default function DownloadsMenu(extensions: WorkExtensions) {
  const { t } = useTranslation();
  const snapshot = useSyncExternalStore(subscribe, getState);
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const acquisition = useAcquisitionJobs();
  const jobs = withoutAcquisitionStages(snapshot.jobs, acquisition);
  const offline = useOfflineStorage();
  const local = offline.data?.status.tracks.filter(track => track.pool === 'offline') ?? [];
  const running = acquisition.requests.filter(acquisitionLive).length + local.filter(track => ['en fila', 'descargando'].includes(track.state)).length + jobs.filter((job) => job.state === "running").length;
  const waiting = jobs.filter(waitingForHelper).length;
  const failing = acquisition.requests.filter(job => job.state === 'fallido' || job.state === 'parcial').length + local.filter(track => track.state === 'fallido').length + jobs.filter((job) => !isLive(job) && (job.failedCount > 0 || job.state === "interrupted" || job.state === "failed")).length;
  const outbox = useOutbox();
  const needs = outbox.length + (failing || waiting);
  const counts = {
    running: running, waiting: jobs.filter((job) => groupOf(job) === "waiting").length,
    terminal: jobs.filter((job) => !isLive(job)).length,
  };
  const status = [
    outbox.length ? t("{{n}} changes are waiting for the nest", { n: outbox.length }) : "",
    failing ? t("{{n}} with failures", { n: failing }) : "",
    waiting ? t("{{n}} waiting for help", { n: waiting }) : "",
    running ? t("{{n}} in progress", { n: running }) : "",
    !needs && !running ? (counts.waiting ? t("{{n}} queued", { n: counts.waiting }) : t("Nothing running")) : "",
  ].filter(Boolean).join(" · ");

  useEffect(() => {
    const show = () => { setOpen(true); triggerRef.current?.focus(); };
    window.addEventListener("krobi:open-jobs", show);
    return () => window.removeEventListener("krobi:open-jobs", show);
  }, []);

  return (
    <>
      <div className="relative shrink-0" data-tauri-drag-region="false">
        <button type="button" ref={triggerRef} onClick={() => setOpen((value) => !value)}
          aria-expanded={open} aria-haspopup="dialog" aria-controls={panelId}
          aria-label={`${t("Jobs")} · ${status}`} title={status}
          className={`topbar-control topbar-control--jobs ${!running && !needs ? "text-[var(--ink-3)]" : "text-[var(--ink)]"}`}>
          {running ? <span data-testid="jobs-ring" aria-hidden="true" className="h-4 w-4 rounded-full border-[2.5px] border-[var(--line-med)] border-t-[var(--teal)] motion-safe:animate-spin" /> : <ListTodo aria-hidden="true" size={16} />}
          {t("Jobs")}
          {needs > 0 ? <span data-testid="jobs-count" data-tone={failing ? "failed" : "waiting"}
            className="grid place-items-center min-w-5 h-5 px-1 rounded-full border-2 border-black font-mono text-[11px] text-[var(--ink)]"
            style={{ background: failing ? "var(--rose-tint)" : "var(--yellow-tint)" }}>{needs}</span> : null}
        </button>
        <Popover open={open} onClose={() => setOpen(false)} anchorRef={triggerRef} initialFocus="container"
          id={panelId} aria-label={t("Jobs")}
          className="w-[380px] max-w-[calc(100vw-24px)] max-h-[min(560px,75vh)] custom-scrollbar rounded-[10px] border-2 border-black bg-[var(--panel)] text-[var(--ink)] shadow-[var(--shadow-pop)]">
            <header className="flex items-center gap-2.5 px-3 py-2 border-b-2 border-black">
              <b className="text-[15px]">{t("Jobs")}</b>
              <span className="font-mono text-[12px] text-[var(--ink-3)]">{jobs.length + acquisition.requests.length + local.length + outbox.length}</span>
              <ClearFinished className="ml-auto" />
            </header>
            <JobList {...extensions} />
        </Popover>
      </div>
      <DownloadRetryModal />
    </>
  );
}

/** "Clear": removes finished jobs. Shown only while there are some. */
export function ClearFinished({ className = "" }: { className?: string }) {
  const { t } = useTranslation();
  const snapshot = useSyncExternalStore(subscribe, getState);
  const acquisition = useAcquisitionJobs();
  const jobs = withoutAcquisitionStages(snapshot.jobs, acquisition);
  const [clearing, setClearing] = useState(false);
  const [error, setError] = useState(false);
  const hasFinishedJobs = jobs.some((job) => !isLive(job));
  const hasFinishedAcquisitions = acquisition.requests.some((job) => !acquisitionLive(job));
  if (!hasFinishedJobs && !hasFinishedAcquisitions) return null;
  const clear = async () => {
    setClearing(true); setError(false);
    try {
      const results = await Promise.allSettled([
        ...(hasFinishedJobs ? [dismissFinished()] : []),
        ...(hasFinishedAcquisitions ? [clearFinishedAcquisitions()] : []),
      ]);
      setError(results.some(result => result.status === 'rejected'));
    } finally { setClearing(false); }
  };
  return <>
    <button type="button" className={`${actionClass} ${className}`} disabled={clearing} onClick={() => void clear()}>{t("Clear")}</button>
    {error ? <span role="alert" className="text-[12px] text-[var(--rose)]">{t("Could not clear finished jobs. Try again.")}</span> : null}
  </>;
}

/** The jobs, grouped running → waiting → finished. The topbar menu and Home's panel both draw this. */
export function JobList({ uploadBatches, pendingChanges }: WorkExtensions = {}) {
  const { t } = useTranslation();
  const snapshot = useSyncExternalStore(subscribe, getState);
  const acquisition = useAcquisitionJobs();
  const jobs = withoutAcquisitionStages(snapshot.jobs, acquisition);
  const offline = useOfflineStorage();
  const outbox = useOutbox();
  const changes = pendingChanges ?? (outbox.length ? <OutboxJobs /> : null);
  const hasOtherRows = acquisition.requests.length > 0 || offline.data?.status.tracks.some(track => track.pool === 'offline') || uploadBatches || changes;
  const rows: GroupedWorkRow[] = [
    ...acquisition.requests.map(job => ({ key: `acquisition:${job.id}`, group: acquisitionGroup(job), row: <AcquisitionRow job={job} /> })),
    ...jobs.map(job => ({ key: `job:${job.id}:${job.attempt}`, group: groupOf(job), row: <JobRow job={job} /> })),
  ];
  const missing = snapshot.degraded.map((source) => source === "stems" ? t("Split songs") : source === "lyrics" ? t("Lyrics_plural") : t("Jobs")).join(", ");
  // Nothing to list: a quiet "all clear", or the failed read with its retry.
  if (!jobs.length && !hasOtherRows && !acquisition.error) return snapshot.unavailable ? <JobsUnreachable /> : (
    <div className="h-full min-h-[100px] grid place-content-center justify-items-center gap-2 px-4 py-3 text-center">
      <span aria-hidden="true" className="grid place-items-center w-[44px] h-[44px] rounded-[10px] border-2 border-black text-black" style={{ background: "var(--green)" }}><Check size={20} strokeWidth={3} /></span>
      <b className="text-[15px] text-[var(--ink)]">{t("Nothing running")}</b>
      {missing ? <span className="flex items-center gap-1.5 text-[12px] text-[var(--ink-3)]" title={t("Could not read some jobs: {{sources}}", { sources: missing })}>
        <span aria-hidden="true" className="w-1.5 h-1.5 rounded-full bg-[var(--yellow)]" />{t("Missing {{sources}}", { sources: missing })}
      </span> : null}
    </div>
  );
  return <>
    {acquisition.error ? <div className="px-3 py-2 text-[12px] text-[var(--rose)]">{t("Could not load acquisitions")} <button className={actionClass} type="button" onClick={() => void refreshAcquisitions()}>{t("Retry")}</button></div> : null}
    {uploadBatches}
    {changes}
    {snapshot.unavailable ? <JobsUnreachable compact /> : null}
    {missing ? <div role="status" title={t("Could not read some jobs: {{sources}}", { sources: missing })} className="flex items-center gap-2 px-3 py-2 border-b border-[var(--line-soft)] text-[12.5px] text-[var(--ink)]">
      <span aria-hidden="true" className="w-1.5 h-1.5 rounded-full bg-[var(--yellow)]" /><span className="font-semibold">{t("Missing {{sources}}", { sources: missing })}</span>
    </div> : null}
    <LocalDownloadRows storage={offline}>{localRows => {
      const allRows = [...rows, ...localRows];
      return (Object.keys(GROUPS) as Array<keyof typeof GROUPS>).map(group => {
        const grouped = allRows.filter(row => row.group === group);
        return grouped.length ? <div key={group}>
          <div className="flex items-center justify-between px-3 pt-3 pb-1 border-t border-[var(--line-soft)] text-[11px] font-bold uppercase tracking-wide text-[var(--ink-3)]">
            <span>{t(GROUPS[group])}</span><span className="font-mono">{grouped.length}</span>
          </div>
          {grouped.map(row => <div key={row.key}>{row.row}</div>)}
        </div> : null;
      });
    }}</LocalDownloadRows>
  </>;
}

/** The jobs read failed: when, and one way to try again. Full when there is nothing else to show; a strip above stale rows otherwise. */
function JobsUnreachable({ compact = false }: { compact?: boolean }) {
  const { t, i18n } = useTranslation();
  const [at] = useState(() => new Date());
  const [retrying, setRetrying] = useState(false);
  const time = at.toLocaleTimeString(i18n.language, { hour: "2-digit", minute: "2-digit" });
  const retry = async () => { setRetrying(true); try { await reconcile(); } finally { setRetrying(false); } };
  const button = <button type="button" className={`${actionClass} inline-flex items-center gap-1.5`} disabled={retrying} onClick={() => void retry()}>
    <RotateCw aria-hidden="true" size={12} className={retrying ? "motion-safe:animate-spin" : ""} />{retrying ? t("…") : t("Retry")}
  </button>;
  if (compact) return <div role="alert" className="flex items-center gap-2 px-3 py-2 border-b border-[var(--line-soft)] text-[12.5px] text-[var(--ink)]">
    <span aria-hidden="true" className="w-1.5 h-1.5 rounded-full bg-[var(--rose)]" />
    <span className="font-semibold">{t("Not updated")}</span>
    <span className="font-mono text-[11px] text-[var(--ink-3)]">· {time}</span>
    <span className="ml-auto">{button}</span>
  </div>;
  return <div role="alert" className="h-full min-h-[180px] grid place-content-center justify-items-center gap-3 px-4 py-6 text-center">
    <span aria-hidden="true" className="grid place-items-center w-[44px] h-[44px] rounded-[10px] border-2 border-black text-black" style={{ background: "var(--rose-tint)" }}><CloudOff size={20} /></span>
    <b className="text-[15px] text-[var(--ink)]">{t("Could not read the jobs")}</b>
    <span className="flex items-center gap-1.5 text-[12px] text-[var(--ink-3)]">
      <span aria-hidden="true" className="w-1.5 h-1.5 rounded-full bg-[var(--rose)]" />{t("The nest did not answer")}<span className="font-mono">· {time}</span>
    </span>
    {button}
  </div>;
}

function JobRow({ job }: { job: Job }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const detailsId = useId();
  const kind = presentation(job.kind);
  const helper = kind.helper || !!job.waitingOn;
  const progress = t("{{n}} of {{total}} songs", { count: job.total, n: job.completed, total: job.total });
  const running = job.state === "running";
  const failed = !isLive(job) && job.failedCount > 0;
  const pct = Math.max(0, Math.min(100, Math.round(job.percent)));
  const word = job.state === "interrupted" ? t("Interrupted")
    : job.state === "waiting" && job.waitingOn ? t("Waiting for {{helper}}", { helper: job.waitingOn.name })
    : waitingForHelper(job) ? t("Waiting for a helper")
    : job.state === "queued" || job.state === "waiting" ? t("Queued")
    : running ? t(PHASES[job.phase || ""] || kind.running)
    : job.kind === "match" && job.state === "partial" ? t("Review complete")
    : failed ? t("{{failed}} of {{total}} failed", { count: job.failedCount, failed: job.failedCount, total: job.total })
    : job.state === "cancelled" ? t("Cancelled") : job.state === "failed" ? t("Failed") : job.kind === "match" ? t("Review complete") : t("Done");
  const fact = job.state === "waiting" && job.waitingOn ? t(HELPERS[job.waitingOn.state] || msg("offline"))
    : helper ? [job.waitingOn?.name, running ? job.item : null].filter(Boolean).join(" · ")
    : running ? [job.item, `${job.completed} / ${job.total}`].filter(Boolean).join(" · ")
    : job.kind === "match" ? (job.state === "succeeded" ? t("{{n}} matches reviewed", { n: job.total }) : "")
    : job.state === "succeeded" ? t("{{n}} songs", { count: job.total, n: job.total }) : "";
  const tone = failed || job.state === "interrupted" || job.state === "failed" ? "var(--rose)"
    : waitingForHelper(job) || job.state === "waiting" ? "var(--yellow)" : running ? "var(--teal)" : !isLive(job) ? "var(--green)" : "var(--ink-3)";
  const run = async (action: () => Promise<void>) => {
    setBusy(true); setError(false);
    try { await action(); } catch { setError(true); } finally { setBusy(false); }
  };
  const toggleFailures = () => {
    if (expanded) { setExpanded(false); return; }
    setExpanded(true);
    void run(() => loadFailures(job.id, job.attempt));
  };
  return (
    <JobRowLayout label={job.label} title={helper ? `${t(kind.label)} · ${progress}` : job.label} kind={t(kind.label)} mark={kind.mark} color={kind.color}
      word={word} tone={tone} fact={fact} percent={running ? pct : undefined}
      actions={<>
          {!isLive(job) ? <button type="button" className={actionClass} disabled={busy}
            aria-label={t("Remove from list")} title={t("Remove from list")}
            onClick={() => void run(() => clearJob(job.id))}><X aria-hidden="true" size={14} /></button> : null}
          {job.kind === "upload" ? <button type="button" className={actionClass} onClick={() => openUpload(job.id)}>{t("View")}</button> : null}
          {job.canCancel ? <button type="button" className={actionClass} disabled={busy} onClick={() => void run(() => cancelJob(job.id))}>{t("Cancel")}</button>
            : job.state === "interrupted" && job.canRetry ? <button type="button" className={actionClass} disabled={busy} onClick={() => void run(() => retryJob(job.id, job.attempt))}>{t("Retry")}</button>
            : failed ? <button type="button" className={actionClass} disabled={busy} aria-expanded={expanded} aria-controls={detailsId} onClick={toggleFailures}>{t("View {{n}}", { n: job.failedCount })}</button>
            : job.canRetry ? <button type="button" className={actionClass} disabled={busy} onClick={() => void run(() => retryJob(job.id, job.attempt))}>{t("Retry")}</button> : null}
      </>}>
      {error ? <p role="alert" className="mt-2 text-[12px] text-[var(--rose)]">{t("Could not complete the action. Try again.")}</p> : null}
      {expanded ? <div id={detailsId} className="ml-10 mt-2 border-t border-[var(--line-soft)] pt-1">
        {busy ? <p role="status" className="text-[12px] text-[var(--ink-3)]">{t("Loading…")}</p>
          : job.kind === "download" ? <FailedSongs jobId={job.id} failures={job.failures} />
          : <ul aria-label={t("Songs that failed")} className="my-2 text-[12px]">{job.failures.map((failure) => <li key={failure.index}>{failure.item}{failure.reason ? <span className="text-[var(--ink-3)]"> · {failure.reason}</span> : null}</li>)}</ul>}
        {job.canRetry ? <button type="button" className={`${actionClass} mt-2`} disabled={busy} onClick={() => void run(() => retryJob(job.id, job.attempt))}>{t("Retry")}</button> : null}
      </div> : null}
    </JobRowLayout>
  );
}
