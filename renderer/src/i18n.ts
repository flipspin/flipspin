/**
 * Owns UI language selection, translation catalogs and cross-window updates.
 * English sentences are source keys; Spanish values preserve the translated copy.
 * Disable key/namespace separators so punctuation remains part of the source sentence.
 * Use msg() for static tables and translate at render time; never translate at module scope.
 * Pass count for plurals. The saved language overrides system preferences.
 * Keep localStorage, storage events and the document language synchronized.
 */
import i18next from 'i18next'
import { initReactI18next } from 'react-i18next'
import { legacySpanishKeys } from './legacySpanishKeys'

import en from '../locales/en/translation.json'
import es from '../locales/es/translation.json'

export const LANGUAGES = ['es', 'en'] as const
export type Language = (typeof LANGUAGES)[number]

/**
 * The languages this build offers. The alpha ships English only: Spanish remains
 * a translated catalog but is not offered, and
 * every picker hides while there is one. A build setting, `VITE_UI_LANGUAGES`
 * (comma-separated, default `en`); the test run sets `es,en`.
 */
export const SHIPPED_LANGUAGES: readonly Language[] = (() => {
  let raw = 'en'
  try {
    raw = String(import.meta.env?.VITE_UI_LANGUAGES || 'en')
  } catch { /* not a Vite build */ }
  const list = raw.split(',').map((x) => x.trim()).filter(isLanguage)
  return list.length ? list : ['en']
})()

/** Show a language picker only when there is a choice to make. */
export const LANGUAGE_CHOICE = SHIPPED_LANGUAGES.length > 1

function shipped(lng: Language): Language {
  return SHIPPED_LANGUAGES.includes(lng) ? lng : SHIPPED_LANGUAGES[0]
}

export const LANGUAGE_STORAGE_KEY = 'krobi.language'
const DEFAULT_LANGUAGE: Language = 'en'

/** Native-script names, the way a language picker should read whichever is active. */
export const LANGUAGE_NAMES: Record<Language, string> = {
  es: 'Español',
  en: 'English',
}

export function isLanguage(value: unknown): value is Language {
  return typeof value === 'string' && (LANGUAGES as readonly string[]).includes(value)
}

/** An explicit language choice wins over the system preference list.
 * Leave detected choices out of storage so later OS language changes still apply. */
export function resolveLanguage(stored: unknown, systemLanguages: readonly string[]): Language {
  if (isLanguage(stored)) return stored
  for (const tag of systemLanguages) {
    const base = tag.toLowerCase().split(/[-_]/)[0]
    if (base === 'es') return 'es'
    if (base === 'en') return 'en'
  }
  return DEFAULT_LANGUAGE
}

function readStoredLanguage(): string | null {
  try {
    return globalThis.localStorage?.getItem(LANGUAGE_STORAGE_KEY) ?? null
  } catch {
    return null
  }
}

function readSystemLanguages(): string[] {
  const nav = globalThis.navigator
  if (!nav) return []
  if (nav.languages?.length) return [...nav.languages]
  return nav.language ? [nav.language] : []
}

/** Keep the selected catalog while retaining the system's matching regional formats. */
export function languageLocale(language: Language, systemLanguages: readonly string[]): string {
  for (const tag of systemLanguages) {
    try {
      const locale = Intl.getCanonicalLocales(tag.replaceAll('_', '-'))[0]
      if (locale?.split('-')[0] === language) return locale
    } catch { /* Ignore malformed system tags, as language detection does. */ }
  }
  return language
}

function initialLanguage(): string {
  const system = readSystemLanguages()
  return languageLocale(shipped(resolveLanguage(readStoredLanguage(), system)), system)
}

/** Mark source keys without translating them so static tables can follow language changes at render time. */
export function msg<S extends string>(key: S): S {
  return key
}

// Only unresolved host keys may use aliases. A plugin's own resource (including
// one in a separate namespace) always wins, even when it resembles host copy.
i18next.use({
  type: 'postProcessor',
  name: 'legacySpanishKeys',
  process(value, keys, options) {
    const key = Array.isArray(keys) ? keys[0] : keys
    const alias = Object.hasOwn(legacySpanishKeys, key) ? legacySpanishKeys[key] : undefined
    if (!alias) return value
    const namespaces = options.ns ? typeof options.ns === 'string' ? [options.ns] : options.ns : ['translation']
    if (namespaces.length !== 1 || namespaces[0] !== 'translation' || i18next.exists(key, options)) return value
    return i18next.t(alias, { ...options, postProcess: [] })
  },
}).use(initReactI18next).init({
  lng: initialLanguage(),
  supportedLngs: [...LANGUAGES],
  nonExplicitSupportedLngs: true,
  fallbackLng: 'en',
  postProcess: ['legacySpanishKeys'],
  resources: { es: { translation: es }, en: { translation: en } },
  // Bundled resources, so init can be synchronous: `t` is usable the moment
  // this module has evaluated, and no screen renders keys for one frame.
  initAsync: false,
  keySeparator: false,
  nsSeparator: false,
  returnEmptyString: false,
  returnNull: false,
  interpolation: { escapeValue: false }, // React escapes; double-escaping shows `&#39;`
})

/** Register plugin-owned keys unchanged, in their requested namespace. */
export function registerPluginTranslations(language: string, bundle: Record<string, string>, namespace = 'translation') {
  const explicit = Object.fromEntries(Object.entries(bundle).map(([key, value]) => [key, value || key.replace(/_(one|other|many)$/, '')]))
  i18next.addResourceBundle(language, namespace, explicit, true, false)
}

function applyDocumentLanguage(lng: string) {
  if (typeof document !== 'undefined') document.documentElement.lang = lng
}
applyDocumentLanguage(i18next.language)
i18next.on('languageChanged', applyDocumentLanguage)

/** The user picked a language. Persists it and re-renders every subscribed component. */
export function setLanguage(lng: Language) {
  lng = shipped(lng)
  try {
    globalThis.localStorage?.setItem(LANGUAGE_STORAGE_KEY, lng)
  } catch {
    // Private mode or a blocked store: the session still switches, it just won't stick.
  }
  void i18next.changeLanguage(languageLocale(lng, readSystemLanguages()))
}

export function currentLanguage(): Language {
  const base = i18next.language.split('-')[0]
  return isLanguage(base) ? base : DEFAULT_LANGUAGE
}

// Another window of this app (the player) changed the language: follow it.
// `storage` never fires in the window that wrote, so this cannot loop.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key === LANGUAGE_STORAGE_KEY && isLanguage(event.newValue) && event.newValue !== i18next.language) {
      void i18next.changeLanguage(languageLocale(shipped(event.newValue), readSystemLanguages()))
    }
  })
}

export default i18next
