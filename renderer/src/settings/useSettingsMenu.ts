import { useEffect, useState } from 'react'
import { menuSection, type SectionId } from './sections'

type Expanded = Partial<Record<SectionId, boolean>>

/** Account ids are scoped to a nest; anonymous/local viewers have their own slot. */
export function settingsMenuKey(nest: string | null, viewer: string | null): string {
  return `krobi.settings.menu.${JSON.stringify([nest, viewer])}`
}

function read(key: string, current: SectionId): Expanded {
  let saved: Expanded = {}
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? '{}')
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      saved = Object.fromEntries(Object.entries(value).filter(([, open]) => typeof open === 'boolean'))
    }
  } catch { /* Settings also works when storage is unavailable. */ }
  return { ...saved, [menuSection(current)]: true }
}

export function useSettingsMenu(key: string, current: SectionId) {
  const [state, setState] = useState(() => ({ key, current, expanded: read(key, current) }))
  // Resolve a changed viewer or destination before commit, without replacing
  // the navigation element or briefly writing another viewer's preferences.
  if (state.key !== key || state.current !== current) {
    setState({ key, current, expanded: state.key !== key ? read(key, current) : { ...state.expanded, [menuSection(current)]: true } })
  }
  useEffect(() => {
    try { localStorage.setItem(state.key, JSON.stringify(state.expanded)) } catch { /* Optional preference. */ }
  }, [state])
  return {
    expanded: state.expanded,
    toggle: (id: SectionId) => setState(previous => ({ ...previous, expanded: { ...previous.expanded, [id]: !previous.expanded[id] } })),
    show: (id: SectionId) => setState(previous => ({ ...previous, expanded: { ...previous.expanded, [menuSection(id)]: true } })),
  }
}
