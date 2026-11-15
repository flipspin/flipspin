import { createContext, useContext, useMemo, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useLibraryMissing } from './hooks/use-library-missing'

// One observer for the current account. Scoped callers keep their own queries;
// song rows only read this set, even when hundreds are mounted together.
const LibraryMissingContext = createContext({ missing: new Set<string>() as ReadonlySet<string>, language: '' })
export function LibraryMissingProvider({ children }: { children: ReactNode }) {
  const missing = useLibraryMissing()
  const { i18n } = useTranslation()
  const language = i18n.resolvedLanguage || i18n.language
  const value = useMemo(() => ({ missing, language }), [missing, language])
  return <LibraryMissingContext.Provider value={value}>{children}</LibraryMissingContext.Provider>
}
// eslint-disable-next-line react-refresh/only-export-components
export function useRowLibraryMissing() { return useContext(LibraryMissingContext).missing }
