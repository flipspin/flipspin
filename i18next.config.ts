/**
 * English is the renderer's source language. Maintain identity English values
 * and Spanish translations by hand in both catalogs; do not run i18n:extract.
 * Use i18n:lint for hardcoded copy and i18n:status for translation coverage.
 */
import { defineConfig } from 'i18next-cli'

export default defineConfig({
  locales: ['en', 'es'],
  extract: {
    input: [
      'renderer/src/**/*.{ts,tsx}',
    ],
    ignore: ['**/plugins/**', '**/*.test.{ts,tsx}', '**/generated/**', '**/test-setup.ts'],
    output: 'renderer/locales/{{language}}/{{namespace}}.json',
    defaultNS: 'translation',
    primaryLanguage: 'en',
    // English copy contains punctuation, which belongs to the source key.
    keySeparator: false,
    nsSeparator: false,
    functions: ['t', '*.t', 'msg'],
    transComponents: ['Trans'],
    useTranslationNames: ['useTranslation'],
    defaultValue: '',
    removeUnusedKeys: true,
    sort: true,
    indentation: 2,
    outputFormat: 'json',
  },
  lint: {
    checkInterpolationParams: true,
    checkConcatenation: 'warn',
  },
})
