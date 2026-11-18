import { installFailure } from "./installErrors";
import { enginePhase } from "./copy";
import type { TFunction } from "i18next";
import type { LyricsEngine } from "./lyricsStore";
import type { MacState } from "./macEngine";

/** Alignment first shipped in krobi-lyrics 0.5.0. Unknown versions are not capabilities. */
export function supportsAlignment(version: string | null | undefined): boolean {
  const match = version?.match(/^(\d+)\.(\d+)\.(\d+)(?:\+.*)?$/);
  return Boolean(match && (Number(match[1]) > 0 || Number(match[2]) >= 5));
}

export function syncEngineState(engine: LyricsEngine | null | undefined, mac: MacState, t: TFunction) {
  const blocked = (label: string, repair: "install" | "start" | "settings" | null = "settings") => ({ ready: false, label, repair });
  if (!engine) return blocked(t("engine disconnected"));
  const agent = engine.mode === "agent";
  const installing = agent ? mac.status?.installing : engine.installing;
  if (installing) return blocked(enginePhase(installing.phase, t) || t("Installing…"), null);
  if (!agent && engine.addons && !engine.addons.lyrics.ready) return blocked(t("Install in Engines"));
  if (agent && engine.helpers && !engine.helpers.some(helper => helper.jobs.includes("align") && (helper.state === "idle" || helper.state === "working"))) return blocked(t("engine unavailable"));
  const installError = agent ? mac.status?.installError : engine.installError;
  if (installError) return blocked(t(installFailure(installError, "engine")), "install");
  const versions = agent ? (engine.queue?.agents ?? []).map((a) => a.version) : [engine.version];
  // A queue may be claimed by ANY online agent, so every one must support text.
  if (engine.ready && versions.length && versions.every(supportsAlignment)) {
    if (!agent && engine.running) return blocked(t("The engine is busy"), null);
    return { ready: true, label: t("ready"), repair: null };
  }
  const canInstall = agent ? Boolean(mac.available && mac.status?.supported && mac.status.uv) : engine.supported;
  if (engine.ready) {
    const old = versions.find((v) => v && !supportsAlignment(v));
    return blocked(old ? t("engine {{version}}, update required", { version: old }) : t("unknown engine version"), canInstall ? "install" : "settings");
  }
  if ((agent && mac.status?.supported && !mac.status.installed) || (!agent && engine.hint === "not-installed")) {
    return blocked(t("engine not installed"), canInstall ? "install" : "settings");
  }
  if (agent) return blocked(t("computer off"), mac.status?.installed && !mac.status.agentRunning ? "start" : "settings");
  return blocked(t("engine unavailable"), canInstall ? "install" : "settings");
}
