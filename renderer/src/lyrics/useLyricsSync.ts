import { useEffect, useState } from "react";
import type { TFunction } from "i18next";
import { fastestHelper, helperSpeed } from "../settings/helper";
import { refreshMac, useMacEngine } from "./macEngine";
import { useLyricsJobs, watchJobs } from "./lyricsStore";
import { supportsAlignment, syncEngineState } from "./syncEngine";
import { cancelSync, useSyncRun } from "./syncRunStore";

/** Both lyrics surfaces read the existing shared engine poll and song run. */
export function useLyricsSync(relPath: string, duration: number | null | undefined, t: TFunction, active = true) {
  const snapshot = useLyricsJobs()?.engine;
  const mac = useMacEngine();
  const run = useSyncRun(relPath);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!active) return;
    const unwatch = watchJobs();
    void refreshMac();
    return unwatch;
  }, [active]);
  useEffect(() => {
    if (!active || !run?.running) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active, run?.running]);
  const state = syncEngineState(snapshot, mac, t);
  const helper = fastestHelper(snapshot?.helpers?.length ? snapshot.helpers : snapshot?.worker ? [snapshot.worker] : [], "align");
  const available = state.ready || Boolean(snapshot?.mode === "local" && supportsAlignment(snapshot.version)
    && snapshot.installed !== false && (!snapshot.addons || snapshot.addons.lyrics.ready));
  const backend = helper?.accel || (snapshot?.mode === "local" ? mac.status?.hardware?.accel : undefined);
  const speed = helperSpeed(helper, "align").value;
  // Same 3:30-song estimates shown in the first-run Add-ons step.
  const baseline = backend === "mlx" ? 25 : backend === "cuda" ? 20 : backend === "cpu" ? 240 : null;
  const estimate = speed != null && duration ? Math.round(speed * duration / 60)
    : baseline != null ? Math.round(baseline * (duration ? duration / 210 : 1)) : null;
  const machine = snapshot?.mode === "local" || helper?.nest ? t("Nest") : helper?.name || snapshot?.queue?.agents?.[0]?.name;
  const elapsed = run?.startedAt ? Math.max(0, Math.floor((now - run.startedAt) / 1000)) : 0;
  const cancel = () => { void cancelSync(relPath).catch(error => console.error("Lyrics cancellation failed", error)); };
  return { ...state, available, songDuration: duration, machine, backend: backend?.toUpperCase(), estimate, elapsed, run, cancel };
}
export type LyricsSyncEngine = ReturnType<typeof useLyricsSync>;

export const openSyncAddons = () => window.dispatchEvent(new CustomEvent("krobi-show-settings", { detail: { section: "complementos" } }));
