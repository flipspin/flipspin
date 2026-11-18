import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import { readRecentSearches, removeRecentSearch } from './catalogSearchHistory';


export function RecentSearches({ onSelect }: { onSelect: (term: string) => void }) {
  const { t } = useTranslation();
  const [recent, setRecent] = useState(readRecentSearches);
  if (!recent.length) return null;
  // Prevent mousedown blur so WebKit keeps the list mounted until the click reaches its target.
  return <div onMouseDown={event => event.preventDefault()} className="absolute top-full left-0 z-(--z-dropdown) w-full mt-1 p-3 rounded-panel border-2 border-black bg-[var(--app-bg)] shadow-sm">
    <p className="m-0 mb-2 text-xs font-bold text-[var(--ink-3)]">{t("Recent searches")}</p>
    <ul className="m-0 p-0 list-none">
      {recent.map(term => <li key={term} className="flex items-center gap-2">
        <button type="button" className="flex-1 text-left py-1" onClick={() => onSelect(term)}>{term}</button>
        <button type="button" className="explore-button" aria-label={t("Remove search {{query}}", { query: term })} onClick={() => {
          setRecent(removeRecentSearch(term));
        }}><X size={12} aria-hidden /></button>
      </li>)}
    </ul>
  </div>;
}
