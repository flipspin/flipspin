// Camelot code ("8A"/"12B") -> monotonic index (number*2, +1 for B) so the
// wheel orders 1A,1B,2A,2B…; non-codes sort last (Infinity).
export function camelotIndex(code: unknown) {
  const m = typeof code === "string" ? code.match(/^(\d{1,2})([AB])$/) : null;
  return m ? Number(m[1]) * 2 + (m[2] === "B" ? 1 : 0) : Infinity;
}
