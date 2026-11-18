import { useId, useRef, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { msg } from '../i18n'

export type ImportSource = 'playlist' | 'youtube'
const SOURCES: readonly { id: ImportSource; label: string }[] = [
  { id: 'playlist', label: msg('Playlist') },
  { id: 'youtube', label: msg('YouTube') },
]

/** Switching forms, not a setting: the existing tab primitive. One song is Browse's job. */
export function ImportSourceTabs({ source, onChange, panelId }: { source: ImportSource; onChange: (value: ImportSource) => void; panelId: string }) {
  const { t } = useTranslation()
  const id = useId()
  const tabs = useRef(new Map<ImportSource, HTMLButtonElement>())
  function navigate(event: KeyboardEvent<HTMLDivElement>) {
    const current = SOURCES.findIndex((entry) => entry.id === source)
    let next: number
    if (event.key === 'ArrowRight') next = (current + 1) % SOURCES.length
    else if (event.key === 'ArrowLeft') next = (current + SOURCES.length - 1) % SOURCES.length
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = SOURCES.length - 1
    else return
    event.preventDefault()
    onChange(SOURCES[next].id)
    tabs.current.get(SOURCES[next].id)?.focus()
  }
  return <div className="z-tabs" role="tablist" aria-label={t("From where")} onKeyDown={navigate}>
    {SOURCES.map((entry) => <button key={entry.id} type="button" role="tab" id={`${id}-${entry.id}`}
      ref={(element) => { if (element) tabs.current.set(entry.id, element); else tabs.current.delete(entry.id) }}
      aria-controls={panelId} aria-selected={source === entry.id} tabIndex={source === entry.id ? 0 : -1}
      onClick={() => onChange(entry.id)}>{t(entry.label)}</button>)}
  </div>
}
