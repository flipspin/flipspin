import { useSyncExternalStore } from 'react';
import { stemPlayer } from './StemPlayer';

/** The stems card reads this store and calls the stable singleton actions. */
export function useStemPlayer() {
  const status = useSyncExternalStore(stemPlayer.subscribe, stemPlayer.getSnapshot);
  return {
    ...status,
    setLevel: stemPlayer.setLevel,
    previewLevel: stemPlayer.previewLevel,
    toggleMute: stemPlayer.toggleMute,
    toggleSolo: stemPlayer.toggleSolo,
    setPreset: stemPlayer.setPreset,
    reset: stemPlayer.reset,
    retry: stemPlayer.retry,
    refresh: stemPlayer.refresh,
  };
}
