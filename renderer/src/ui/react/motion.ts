/* krobi-ui; AGPL-3.0; see LICENSE. */

/**
 * Motion roles for JavaScript animations (`element.animate`, timers that pace
 * a choreography). They read the same tokens as the CSS (ui/tokens/app.css),
 * so a retune lands everywhere and reduced motion; which zeroes the duration
 * tokens; makes every role 0 ms without a check at each call site.
 */
export type MotionRole = "press" | "state" | "enter" | "exit" | "move" | "settle";

const ROLES: Record<MotionRole, { duration: string; easing: string }> = {
  press: { duration: "--dur-press", easing: "--ease" },
  state: { duration: "--dur-fast", easing: "--ease" },
  enter: { duration: "--dur-fast", easing: "--ease-out" },
  exit: { duration: "--dur-fast", easing: "--ease-out" },
  move: { duration: "--dur", easing: "--ease" },
  settle: { duration: "--dur-slow", easing: "--ease" },
};

// Used only where no stylesheet is loaded (tests): the token values themselves.
const FALLBACK: Record<string, string> = {
  "--dur-press": "60ms",
  "--dur-fast": "140ms",
  "--dur": "240ms",
  "--dur-slow": "480ms",
  "--ease": "cubic-bezier(0.4, 0, 0.2, 1)",
  "--ease-out": "cubic-bezier(0.16, 1, 0.3, 1)",
};

function token(name: string): string {
  const value = typeof document === "undefined" ? "" : getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || FALLBACK[name];
}

function toMs(value: string): number {
  const n = Number.parseFloat(value);
  if (!Number.isFinite(n)) return 0;
  return value.endsWith("ms") ? n : n * 1000;
}

/** `{ duration, easing }` for a role, ready for `element.animate(keyframes, motion("enter"))`. */
export function motion(role: MotionRole): { duration: number; easing: string } {
  const { duration, easing } = ROLES[role];
  return { duration: toMs(token(duration)), easing: token(easing) };
}
