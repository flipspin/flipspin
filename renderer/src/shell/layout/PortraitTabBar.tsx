import { Compass, Home, Library, ListMusic, SlidersHorizontal } from 'lucide-react'
import type { ComponentType } from 'react'
import { useTranslation } from 'react-i18next'

import { msg } from '../../i18n'
import type { BuiltinPage, Page } from '../pageTable'

/** Use a bottom bar in portrait to preserve content width. Match sidebar accents
 * so pages stay recognizable across orientations. Translate table keys at render time. */
export type PortraitTab = Extract<BuiltinPage, 'home' | 'dashboard' | 'albums' | 'playlists'>

interface TabSpec {
  id: PortraitTab
  label: string
  accent: string
  Icon: ComponentType<{ size?: number; strokeWidth?: number; color?: string; 'aria-hidden'?: boolean }>
}

const PORTRAIT_TABS: readonly TabSpec[] = [
  { id: 'home', label: msg("Home"), accent: 'var(--coral)', Icon: Home },
  { id: 'dashboard', label: msg("Explore"), accent: 'var(--purple)', Icon: Compass },
  { id: 'albums', label: msg("Library"), accent: 'var(--blue)', Icon: Library },
  { id: 'playlists', label: msg('Playlists'), accent: 'var(--yellow)', Icon: ListMusic },
]

const LINE = 'var(--line)'
const CARD = 'var(--panel)'

interface ItemProps {
  label: string
  accent: string
  active: boolean
  onClick: () => void
  Icon: TabSpec['Icon']
}

function TabItem({ label, accent, active, onClick, Icon }: ItemProps) {
  const { t } = useTranslation()
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      className="flex flex-1 flex-col items-center gap-1.5 pt-1.5 pb-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-black focus-visible:ring-inset"
      // Inline so it beats the unlayered global `button {}` rule (coral bg,
      // 36 px min-height); same reason PlayerTransport styles its squares.
      style={{ minHeight: 0, padding: '6px 0 4px', background: 'transparent', border: 'none', cursor: 'pointer' }}
    >
      <span
        aria-hidden
        className="grid place-items-center rounded-panel border-2 transition-all duration-(--dur-fast)"
        style={{
          width: 44,
          height: 34,
          borderColor: LINE,
          background: active ? accent : CARD,
          // The selected box is lifted the way the sidebar's active row is;
          // the others sit flat so the bar reads as one plane with one thing
          // raised off it.
          boxShadow: active ? `2px 2px 0 0 ${LINE}` : `1px 1px 0 0 ${LINE}`,
          transform: active ? 'translate(-1px, -1px)' : 'none',
        }}
      >
        <Icon size={18} strokeWidth={2.5} color={active ? "#151515" : "var(--dm-ink, #151515)"} aria-hidden />
      </span>
      <span
        className="leading-none"
        style={{
          fontFamily: 'var(--font-main)',
          fontSize: 11,
          fontWeight: active ? 800 : 600,
          color: active ? 'var(--ink)' : 'var(--ink-3)',
        }}
      >
        {t(label)}
      </span>
    </button>
  )
}

interface Props {
  activePage: Page | 'settings'
  onSelect: (page: PortraitTab) => void
  onOpenSettings: () => void
}

export default function PortraitTabBar({ activePage, onSelect, onOpenSettings }: Props) {
  const { t } = useTranslation()
  return (
    <nav
      aria-label={t("Sections")}
      className="shrink-0 w-full flex items-stretch border-t-2 border-black"
      style={{ background: CARD, padding: '4px 6px' }}
    >
      {PORTRAIT_TABS.map((tab) => (
        <TabItem
          key={tab.id}
          label={tab.label}
          accent={tab.accent}
          Icon={tab.Icon}
          active={activePage === tab.id}
          onClick={() => onSelect(tab.id)}
        />
      ))}
      <TabItem
        label={msg("Settings")}
        accent="var(--ink-4)"
        Icon={SlidersHorizontal}
        active={activePage === 'settings'}
        onClick={onOpenSettings}
      />
    </nav>
  )
}
