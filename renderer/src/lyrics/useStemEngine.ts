import type { StemEngine } from '../stems/stemEngine';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useLyricsJobs, watchJobs } from './lyricsStore';
import { refreshMac, useMacEngine } from './macEngine';
import { fastestHelper, helperSpeed } from '../settings/helper';

/** The Sync button's shared engine snapshot, using Stems capabilities and timings. */
export function useStemEngine(duration: number | undefined, active: boolean): StemEngine {
  const { t } = useTranslation();
  const snapshot = useLyricsJobs()?.engine;
  const mac = useMacEngine();
  useEffect(() => {
    if (!active) return;
    const unwatch = watchJobs();
    void refreshMac();
    return unwatch;
  }, [active]);
  const helper = fastestHelper(snapshot?.helpers?.length ? snapshot.helpers : snapshot?.worker ? [snapshot.worker] : [], 'stems');
  const local = snapshot?.mode === 'local';
  const available = Boolean(helper || (local && snapshot.installed !== false && (snapshot.addons ? snapshot.addons.stems.ready : snapshot.ready)));
  const backend = helper?.accel || (local ? mac.status?.hardware?.accel : undefined);
  const machine = helper ? helper.nest ? t("Nest") : helper.name : local ? t("Nest") : undefined;
  const speed = helperSpeed(helper, 'stems').value;
  // Same 3:10-song estimates as the Stems Add-ons card.
  const baseline = backend === 'mlx' || backend === 'cuda' ? 20 : backend === 'cpu' ? 150 : null;
  const estimate = speed != null && duration ? Math.round(speed * duration / 60)
    : baseline != null ? Math.round(baseline * (duration ? duration / 190 : 1)) : null;
  return { available, machine, backend: backend?.toUpperCase(), estimate };
}
