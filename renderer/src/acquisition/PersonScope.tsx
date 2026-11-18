import { useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Popover } from '../ui/react/components/Popover';
import type { LibraryPerson } from '../albums/hooks/useLibraryScope';
import './acquisition.css';

type Props = { owner?: boolean; people?: LibraryPerson[]; selectedId?: string; name: string; count: number; disabled: boolean; scoped: boolean; onSelect: (id: string) => void };
export default function PersonScope({ owner, people = [], selectedId, name, count, disabled, scoped, onSelect }: Props) {
  const { t } = useTranslation();
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const reason = disabled ? t("Sign in with your account in Settings → My account to have a library of your own.") : undefined;
  return <>
    <span title={reason}><button ref={anchor} type="button" className="retro-table-segment__button border-0 px-3 py-0.5 text-xs font-bold" disabled={disabled} title={reason} aria-pressed={scoped} aria-haspopup={owner ? 'menu' : undefined} aria-expanded={owner ? open : undefined} onClick={() => owner ? setOpen(!open) : onSelect('mine')} style={{ background: scoped ? 'var(--paper-2)' : 'transparent', color: disabled ? 'var(--ink-4)' : 'var(--ink)', display: 'flex', alignItems: 'center', gap: 6 }}>
      {name} · {count}{owner && <ChevronDown size={13} strokeWidth={2.5} />}
    </button></span>
    {owner && <Popover className="acquire-person-menu" open={open} onClose={() => setOpen(false)} anchorRef={anchor} role="menu" aria-label={t("Account")} placement="bottom-start">
      {people.map(person => <button type="button" role="menuitemradio" aria-checked={person.id === selectedId} className="acquire-person" key={person.id} onClick={() => { onSelect(person.id); setOpen(false); }}><span>{person.label}</span>{' '}<span>{person.count}</span></button>)}
    </Popover>}
  </>;
}
