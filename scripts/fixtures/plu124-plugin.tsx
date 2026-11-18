// Verification-only plugin: injected at build time by verify-settings-page.mjs.
import { lazy } from 'react'
import { Puzzle } from 'lucide-react'
import type { KrobiPlugin } from '../../renderer/src/plugins/types'

export default {
  id: 'review-plugin',
  settingsSections: [{ id: 'review-plugin-settings', label: 'Complemento de prueba', icon: Puzzle, color: 'purple',
    Component: lazy(async () => ({ default: () => <p>Ajustes del complemento de prueba</p> })),
  }],
  pages: [{ id: 'review-plugin-settings', title: 'Complemento de prueba', color: 'purple', Component: () => <p>Página del complemento de prueba</p> }],
  complemento: {
    id: 'review-plugin', name: 'Complemento de prueba', icon: Puzzle, kind: 'Extensión',
    nido: { value: 'Datos de verificación', state: { label: 'Activo', tone: 'ok' } },
    computer: { value: 'Motor de prueba', state: { label: 'Sin instalar', tone: 'off' },
      install: { run: () => { localStorage.setItem('review-plugin-action', 'install') } },
      remove: { run: () => { localStorage.setItem('review-plugin-action', 'remove') } },
    },
    open: { kind: 'settings', id: 'review-plugin-settings' },
  },
  locales: { en: { 'Complemento de prueba': 'Test add-on', 'Datos de verificación': 'Verification data', 'Motor de prueba': 'Test engine' } },
} satisfies KrobiPlugin
