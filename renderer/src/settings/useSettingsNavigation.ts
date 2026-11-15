import { useEffect, useState } from 'react'

/** One request channel for the sidebar, header and legacy section shortcuts. */
export function useSettingsNavigation(onNavigate: () => void): { section: string | null; nonce: number } | null {
  const [request, setRequest] = useState<{ section: string | null; nonce: number } | null>(null)
  useEffect(() => {
    const open = (event: Event) => {
      const section = (event as CustomEvent<{ section?: string }>).detail?.section ?? null
      setRequest(previous => ({ section, nonce: (previous?.nonce ?? 0) + 1 }))
      onNavigate()
    }
    window.addEventListener('krobi-show-settings', open)
    window.addEventListener('krobi:open-settings', open)
    return () => {
      window.removeEventListener('krobi-show-settings', open)
      window.removeEventListener('krobi:open-settings', open)
    }
  }, [onNavigate])
  return request
}
