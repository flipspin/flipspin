import { afterEach, describe, expect, it } from 'vitest'

import en from '../locales/en/translation.json'
import es from '../locales/es/translation.json'
import i18n, { LANGUAGE_STORAGE_KEY, currentLanguage, languageLocale, msg, registerPluginTranslations, resolveLanguage, setLanguage } from './i18n'

afterEach(() => {
  setLanguage('es')
  localStorage.removeItem(LANGUAGE_STORAGE_KEY)
})

describe('the language switch', () => {
  it('boots in Spanish and translates English source keys', () => {
    // test-setup pins the system language to Spanish; nothing is stored, and
    // booting must not store the detected value either.
    expect(currentLanguage()).toBe('es')
    expect(localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBeNull()
    expect(i18n.t("Save")).toBe("Guardar")
    // A sentence with the characters i18next would otherwise parse as
    // nesting or a namespace comes back whole.
    expect(i18n.t("Search: {{query}}", { query: 'radiohead' })).toBe('Buscar: radiohead')
    expect(i18n.t("Downloaded.")).toBe("Descargado.")
  })

  it('switches to English and persists the choice', () => {
    setLanguage('en')
    expect(i18n.t("Save")).toBe('Save')
    expect(localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe('en')
    expect(document.documentElement.lang).toBe('en')
  })

  it('renders an unknown English key instead of a blank', () => {
    setLanguage('en')
    expect(i18n.t('An untranslated sentence')).toBe('An untranslated sentence')
  })

  it('agrees plurals per language from one key', () => {
    expect(i18n.t("{{n}} songs", { count: 1, n: '1' })).toBe('1 canción')
    expect(i18n.t("{{n}} songs", { count: 12, n: '12' })).toBe('12 canciones')
    setLanguage('en')
    expect(i18n.t("{{n}} songs", { count: 1, n: '1' })).toBe('1 song')
    expect(i18n.t("{{n}} songs", { count: 12, n: '12' })).toBe('12 songs')
  })

  it('follows a change made in another window of the app', () => {
    // The player window is a second renderer; it writes the same key and the
    // `storage` event is the only thing that reaches this one.
    window.dispatchEvent(new StorageEvent('storage', { key: LANGUAGE_STORAGE_KEY, newValue: 'en' }))
    expect(currentLanguage()).toBe('en')
    window.dispatchEvent(new StorageEvent('storage', { key: LANGUAGE_STORAGE_KEY, newValue: 'klingon' }))
    expect(currentLanguage()).toBe('en')
  })

  it('msg() only marks, never translates', () => {
    setLanguage('en')
    expect(msg("Save")).toBe('Save')
  })
})

describe('the language a window boots in', () => {
  it('keeps regional number formats within the selected catalog', async () => {
    expect(languageLocale('es', ['en-US', 'es-MX'])).toBe('es-MX')
    expect(languageLocale('en', ['es-MX'])).toBe('en')
    expect(languageLocale('es', ['bad_tag_!', 'es_419'])).toBe('es-419')
    await i18n.changeLanguage(languageLocale('es', ['es-MX']))
    expect(currentLanguage()).toBe('es')
    expect((2856).toLocaleString(i18n.language)).toBe('2,856')
    expect(i18n.t("{{n}} songs", { count: 1, n: '1' })).toBe('1 canción')
  })

  it('keeps a stored choice over whatever the system says', () => {
    expect(resolveLanguage('es', ['en-GB'])).toBe('es')
    expect(resolveLanguage('en', ['es-MX'])).toBe('en')
  })

  it('speaks Spanish on a Spanish system', () => {
    expect(resolveLanguage(null, ['es-MX'])).toBe('es')
    expect(resolveLanguage(null, ['es'])).toBe('es')
    expect(resolveLanguage(null, ['fr-FR', 'es-419'])).toBe('es')
  })

  it('speaks English on any other system', () => {
    expect(resolveLanguage(null, ['en-GB'])).toBe('en')
    expect(resolveLanguage(null, ['fr'])).toBe('en')
    expect(resolveLanguage(null, [])).toBe('en')
  })

  it('ignores a stored value that is not a language', () => {
    expect(resolveLanguage('de', ['es-MX'])).toBe('es')
    expect(resolveLanguage('', ['en-US'])).toBe('en')
  })
})

describe('the catalogs', () => {
  it('are one inventory: en and es hold the same keys', () => {
    // `_many` exists only in Spanish's plural rules; everything else must match.
    const enKeys = Object.keys(en).sort()
    const esKeys = Object.keys(es)
      .filter((k) => !k.endsWith('_many'))
      .sort()
    expect(esKeys).toEqual(enKeys)
  })

  it('never interpolate a slot the key does not provide', () => {
    // A translation may drop a slot (a singular that says "Ya estaba en el servidor." instead of "La 1 ya estaba…"), but one that names a slot the
    // call site never passes renders the braces literally.
    const slots = (s: string) => new Set(s.match(/{{\s*\w+\s*}}/g) ?? [])
    const check = (catalog: Record<string, string>) => {
      for (const [key, value] of Object.entries(catalog)) {
        if (!value) continue
        const allowed = slots(key.replace(/_(one|many|other)$/, ''))
        for (const slot of slots(value)) expect(allowed.has(slot), `${key} → ${slot}`).toBe(true)
      }
    }
    check(en)
    check(es)
  })

  it('give the Spanish singular of every plural key', () => {
    for (const key of Object.keys(es).filter((k) => k.endsWith('_one'))) {
      expect(es[key as keyof typeof es], key).not.toBe('')
    }
  })
})


describe('English source and legacy boundaries', () => {
  it('uses English as fallback and keeps English catalog values as source copy', () => {
    expect(i18n.options.fallbackLng).toEqual(['en'])
    for (const [key, value] of Object.entries(en)) {
      expect(value, key).not.toBe('')
      if (/_(one|other|many)$/.test(key)) continue
      expect(key === value || key.startsWith(`${value}_`), key).toBe(true)
    }
    setLanguage('es')
    i18n.addResourceBundle('en', 'translation', { 'English fallback probe': 'English fallback probe' })
    try { expect(i18n.t('English fallback probe')).toBe('English fallback probe') }
    finally { delete i18n.getResourceBundle('en', 'translation')['English fallback probe'] }
  })

  it('preserves legacy wire labels, interpolation and unknown server messages', () => {
    setLanguage('en')
    expect(i18n.t('Guardar')).toBe('Save')
    expect(i18n.t('No se pudo analizar esta canción')).toBe('Could not analyze this song')
    expect(i18n.t('An unknown server diagnostic')).toBe('An unknown server diagnostic')
    setLanguage('es')
    expect(i18n.t('Guardar')).toBe('Guardar')
  })

  it('keeps plugin Spanish keys, namespaces and empty identity values plugin-owned', () => {
    registerPluginTranslations('es', { Guardar: 'Guardar del complemento', 'Clave del complemento': '' }, 'example-plugin')
    registerPluginTranslations('en', { Guardar: 'Store in plugin', 'Clave del complemento': 'Plugin key' }, 'example-plugin')
    registerPluginTranslations('es', { 'Clave de extensión': '' })
    registerPluginTranslations('en', { 'Clave de extensión': 'Extension key' })
    try {
      setLanguage('es')
      expect(i18n.t('Guardar', { ns: 'example-plugin' })).toBe('Guardar del complemento')
      expect(i18n.t('Clave del complemento', { ns: 'example-plugin' })).toBe('Clave del complemento')
      expect(i18n.t('Clave de extensión')).toBe('Clave de extensión')
      setLanguage('en')
      expect(i18n.getFixedT('en', 'example-plugin')('Guardar')).toBe('Store in plugin')
      expect(i18n.t('Save')).toBe('Save')
    } finally {
      i18n.removeResourceBundle('es', 'example-plugin')
      i18n.removeResourceBundle('en', 'example-plugin')
      delete i18n.getResourceBundle('es', 'translation')['Clave de extensión']
      delete i18n.getResourceBundle('en', 'translation')['Clave de extensión']
    }
  })
})
