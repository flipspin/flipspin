import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// Three fonts ship with the app (OFL-1.1, @fontsource), so the window never
// asks Google Fonts for anything: Inter for text, Geist for the song tables,
// Geist Mono for every label, count and number.
import '@fontsource/inter/400.css'
import '@fontsource/inter/500.css'
import '@fontsource/inter/600.css'
import '@fontsource/inter/700.css'
import '@fontsource/inter/800.css'
import '@fontsource/geist/400.css'
import '@fontsource/geist/500.css'
import '@fontsource/geist/600.css'
import '@fontsource/geist/700.css'
import '@fontsource/geist-mono/400.css'
import '@fontsource/geist-mono/500.css'
import '@fontsource/geist-mono/600.css'
import '@fontsource/geist-mono/700.css'
// App-wide motion + layer tokens and the modal layer, before any skin.
import './ui/tokens/app.css'
import './ui/overlay.css'
import './ui/buttons.css'
import './index.css'

import { installTauriBridge } from './desktop/tauri'

// Native state (server origin and credential) must exist before apiAuth or any
// screen module evaluates. Dynamic imports preserve that ordering in Tauri;
// plain Vite/browser development keeps the existing HTTP fallback.
await installTauriBridge()
await import('@lib/apiAuth')
// UI language: bundled catalogs, synchronous init, so no screen renders keys.
await import('./i18n')
const [{ default: App }, { default: Gate }] = await Promise.all([
  import('./shell/App'),
  import('./shell/Gate'),
])

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Gate>
      <App />
    </Gate>
  </StrictMode>,
)
