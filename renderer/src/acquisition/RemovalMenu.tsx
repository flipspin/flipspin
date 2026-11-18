import { useState } from 'react';
import { MoreHorizontal } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import Menu, { menuPointFrom, type MenuItem } from '../albums/TrackContextMenu';

/** Headers use the same menu items as right-click and selections. */
export default function RemovalMenu({ items, className = 'acquire-action', title }: { items: MenuItem[]; className?: string; title?: string }) {
  const { t } = useTranslation();
  const [point, setPoint] = useState<{ x: number; y: number } | null>(null);
  if (!items.some(item => item.type !== 'separator')) return null;
  return <>
    <button type="button" className={className} aria-label={title || t("More options")} title={title || t("More options")} aria-haspopup="menu" aria-expanded={point != null}
      onClick={event => { event.stopPropagation(); setPoint(menuPointFrom(event)); }}><MoreHorizontal size={16} aria-hidden="true" /></button>
    <Menu open={point != null} x={point?.x ?? 0} y={point?.y ?? 0} items={items} onClose={() => setPoint(null)} />
  </>;
}
