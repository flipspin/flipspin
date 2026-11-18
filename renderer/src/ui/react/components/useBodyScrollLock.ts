/* krobi-ui; AGPL-3.0; see LICENSE. */
import { useEffect } from "react";

let locks = 0;
let previousOverflow = "";

/** Reference-counted body scroll lock for nested modal layers. */
export function useBodyScrollLock(active: boolean) {
  useEffect(() => {
    if (!active) return;
    if (locks === 0) {
      previousOverflow = document.body.style.overflow;
      document.body.style.overflow = "hidden";
    }
    locks += 1;
    return () => {
      locks = Math.max(0, locks - 1);
      if (locks === 0) document.body.style.overflow = previousOverflow;
    };
  }, [active]);
}

