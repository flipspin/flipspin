import type { MenuItem } from '../albums/TrackContextMenu';

/** The same ordered actions rendered directly in either selection toolbar. */
export default function RemovalButtons({ items, buttonClassName, dangerClassName, ruleClassName }: {
  items: MenuItem[]; buttonClassName: string; dangerClassName: string; ruleClassName: string;
}) {
  return <>{items.map((item, index) => item.type === 'separator'
    ? <span key={index} className={ruleClassName} role="separator" />
    : item.type !== 'input' && <button key={item.label} type="button" className={`${buttonClassName} ${item.danger ? dangerClassName : ''}`} onClick={item.onClick}>{item.label}</button>)}</>;
}
