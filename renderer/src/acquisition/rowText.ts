import i18n from '../i18n';

// Plain labels repeat hundreds of times in a table. Resolve each once in the
// current language. These row labels have no plural/context variants; reuse
// i18next's interpolator for their titles, durations and percentages.
let language: string;
const labels = new Map<string, string>();
const clear = () => labels.clear();
i18n.on('loaded', clear);
i18n.store.on('added', clear);
i18n.store.on('removed', clear);
export function rowText(key: string, values?: Record<string, unknown>): string {
  if (language !== i18n.language) { language = i18n.language; clear(); }
  let text = labels.get(key);
  if (text === undefined) { text = i18n.t(key, { skipInterpolation: true }); labels.set(key, text); }
  return values ? i18n.services.interpolator.interpolate(text, values, i18n.language, values) : text;
}
