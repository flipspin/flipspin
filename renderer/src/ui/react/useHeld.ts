/* krobi-ui; AGPL-3.0; see LICENSE. */
import { useState } from "react";

/**
 * The value, or the last non-null one it had. A dialog whose data is cleared
 * the moment it closes (`setTrack(null)`) renders from this so its content
 * stays on screen while the exit animation plays.
 */
export function useHeld<T>(value: T | null | undefined): T | null {
  const [held, setHeld] = useState<T | null>(value ?? null);
  if (value != null && value !== held) setHeld(value);
  return value ?? held;
}
