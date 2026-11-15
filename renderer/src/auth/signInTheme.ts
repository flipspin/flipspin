import { useEffect, useState } from 'react'

/** Follow the app's mode, including before SettingsProvider has mounted. */
export function useSignInTheme(): 'light' | 'dark' {
  const read = () => (document.documentElement.getAttribute('data-mode') ?? localStorage.getItem('krobi.mode') ?? '').match(/^(dark|night)$/) ? 'dark' : 'light'
  const [theme, setTheme] = useState<'light' | 'dark'>(read)
  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(read()))
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-mode'] })
    return () => observer.disconnect()
  }, [])
  return theme
}
