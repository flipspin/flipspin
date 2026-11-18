// Share the runtime color fallback order between canvas visualizers.

/**
 * Resolve the first non-empty value from a list of candidates against the
 * document root's computed style.
 *
 * @param {CSSStyleDeclaration} cs - getComputedStyle(document.documentElement)
 * @param {...string} candidates - CSS var names (e.g. '--viz-ising') tried in
 *   order; the first plain (non `--`) string is returned as a literal fallback.
 * @returns {string} the resolved color (or '' if nothing matched)
 */
export function readThemeVar(cs: CSSStyleDeclaration, ...candidates: string[]) {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.startsWith('--')) {
      const value = cs.getPropertyValue(candidate).trim();
      if (value) return value;
    } else if (candidate) {
      return candidate; // literal fallback (e.g. '#EF7E55')
    }
  }
  return '';
}
