import { bridge, hasBridge } from '../bridge'

/** Each producer owns a stable reason; releasing playback cannot release uploads. */
export function activityHold(reason: string) {
  let held = false
  return (active: boolean) => {
    if (active === held || !hasBridge()) return
    held = active
    void bridge().invoke('playback:activity', { active, reason }).catch(() => {})
  }
}
