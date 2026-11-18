/** Auto motion in the fullscreen view is off unless the person turns it on.
 * Its own key, written only by the toggle: the previous key was written on every open,
 * so it held "on" for people who never chose it. */
const MOTION_KEY = "krobi.vizAutoMotion";

export function readMotion(): boolean {
  try {
    return localStorage.getItem(MOTION_KEY) === "1";
  } catch {
    return false;
  }
}

/** Called by the toggle only, never on open. */
export function writeMotion(on: boolean): void {
  try {
    localStorage.setItem(MOTION_KEY, on ? "1" : "0");
  } catch { /* per-viewer convenience only */ }
}
