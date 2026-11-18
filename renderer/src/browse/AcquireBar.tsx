/** The message strip above song and album tables. Its height is always reserved,
 * so a message showing or clearing never moves the table. Rows and the downloads menu show progress;
 * this strip carries the failure and, for a missing audio source, the fix. */
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useCurrentUser } from "../data";
import { isNoSources } from "../acquisition/api";
import { useKnownSources, useSourceInstall } from "../settings/sourceInstall";
import { installFailureKey } from "../settings/installFailure";
import { openSettings } from "../shell/ServerBadge";
import "./page-strip.css";

type Acquisition = { error?: Error | null; resumeBlocked?: () => unknown; dismissError?: () => void };

const PHASE_STEP: Record<string, number> = { fetch: 1, validate: 2, build: 2, hello: 3, test: 3, publish: 3 };
const PHASE_WORD = ["Downloading", "Setting up", "Checking"] as const;

/** `inline` places the strip in a header's action row, in space the header already has, instead of its own row. */
export function AcquireBar({ acquisition, inline = false }: { acquisition: Acquisition; inline?: boolean }) {
  const { t } = useTranslation();
  const { error } = acquisition;
  const [installed, setInstalled] = useState<string | null>(null);
  useEffect(() => {
    if (!installed) return;
    const timer = window.setTimeout(() => setInstalled(null), 3000);
    return () => window.clearTimeout(timer);
  }, [installed]);
  let content: React.ReactNode = null;
  if (error && isNoSources(error)) {
    content = <NoSource onDismiss={() => acquisition.dismissError?.()} onInstalled={name => { setInstalled(name); void acquisition.resumeBlocked?.(); }} />;
  } else if (error) {
    const same = error.message === t("Could not add.");
    content = <Banner tone="bad" head={same ? error.message : t("Could not add.")} body={same ? "" : error.message} role="alert"
      actions={acquisition.dismissError ? <button type="button" className="page-strip__btn" onClick={acquisition.dismissError}>{t("Not now")}</button> : null} />;
  } else if (installed) {
    content = <Banner tone="ok" head={t("{{name}} installed", { name: installed })} body="" role="status" fading />;
  }
  return <div className={inline ? "page-strip page-strip--inline" : "page-strip"} data-testid="message-strip">{content}</div>;
}

function Banner({ tone, head, body, actions, role, fading = false, children }: {
  tone: "ok" | "wait" | "bad"; head: string; body: string; actions?: React.ReactNode; role: "status" | "alert"; fading?: boolean; children?: React.ReactNode;
}) {
  return <div className={`page-strip__banner is-${tone}${fading ? " is-fading" : ""}`} role={role}>
    <span className="page-strip__dot" aria-hidden />
    <b>{head}</b>
    {body ? <span className="page-strip__body">{body}</span> : null}
    {children}
    <span className="page-strip__end">{actions}</span>
  </div>;
}

/** Owners install the audio source here and the refused add replays by itself; members are told who can. */
function NoSource({ onDismiss, onInstalled }: { onDismiss: () => void; onInstalled: (name: string) => void }) {
  const { t } = useTranslation();
  const owner = useCurrentUser().data?.isOwner === true;
  const known = useKnownSources(owner);
  const source = known.data?.sources[0];
  const state = useSourceInstall(source?.id ?? "none");
  const name = source?.name ?? "YouTube";
  const started = useRef(false);
  const reported = useRef(false);
  useEffect(() => {
    if (!started.current || reported.current || !state.succeeded) return;
    reported.current = true;
    onInstalled(name);
  }, [state.succeeded, name, onInstalled]);
  const notNow = <button type="button" className="page-strip__btn" onClick={onDismiss}>{t("Not now")}</button>;
  if (!owner) return <Banner tone="wait" head={t("No audio source")} body={t("Ask an admin to install one.")} role="status" actions={notNow} />;
  const install = () => { if (!source) return; started.current = true; void state.install({ id: source.id }); };
  if (state.busy) {
    const step = PHASE_STEP[state.job?.phase ?? "fetch"] ?? 1;
    return <Banner tone="wait" head={t("Installing {{name}}", { name })} body="" role="status">
      <span className="page-strip__meter" role="progressbar" aria-label={t("Installing the plugin")} aria-valuemin={0} aria-valuemax={3} aria-valuenow={step}><i style={{ width: `${(step - 0.5) / 3 * 100}%` }} /></span>
      <span className="page-strip__step">{t("{{step}} · {{count}} of 3", { step: t(PHASE_WORD[step - 1]), count: step })}</span>
    </Banner>;
  }
  if (state.failed) {
    return <Banner tone="bad" head={t("Couldn't install {{name}}.", { name })} body={t(installFailureKey(state.cause))} role="alert"
      actions={<>{notNow}<button type="button" className="page-strip__btn is-primary" onClick={install}>{t("Retry")}</button></>} />;
  }
  // Installed but switched off or broken in Engines: reinstalling would be wrong, so point at the switch.
  if (source?.installed && !started.current) {
    return <Banner tone="wait" head={t("No audio source")} body="" role="status"
      actions={<>{notNow}<button type="button" className="page-strip__btn is-primary" title={t("Settings → Engines → Audio source")} onClick={() => openSettings("sources-audio")}>{t("Turn on")}</button></>} />;
  }
  return <Banner tone="wait" head={t("No audio source")} body="" role="status"
    actions={<>{notNow}{source ? <button type="button" className="page-strip__btn is-primary" title={t("Published by flipspin · runs on the nest")} onClick={install}>{t("Install {{name}}", { name })}</button> : null}</>} />;
}
