import { Check } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { msg } from '../i18n';
import './spotify-import.css';

const STEPS = [
  { label: msg("File"), states: ['drop'] },
  { label: msg('Playlists'), states: ['picking'] },
  { label: msg("Review"), states: ['resolving', 'review'] },
  { label: msg("Download"), states: ['importing', 'summary'] },
];

/** A progress indicator, not clickable navigation: later stages need prior data. */
export function ImportSteps({ step }: { step: string }) {
  const { t } = useTranslation();
  const activeIndex = Math.max(0, STEPS.findIndex((entry) => entry.states.includes(step)));
  return <ol className="spotify-import-steps" aria-label={t("Import progress")}>
    {STEPS.map((entry, index) => <li key={entry.label} aria-current={index === activeIndex ? 'step' : undefined} data-complete={index < activeIndex || undefined}>
      <span className="spotify-import-steps__number" aria-hidden="true">{index < activeIndex ? <Check size={16} /> : index + 1}</span>
      <span>{t(entry.label)}</span>
    </li>)}
  </ol>;
}
