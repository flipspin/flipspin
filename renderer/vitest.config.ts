import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [react()],
  resolve: {
    preserveSymlinks: true,
    alias: {
      '@state': import.meta.dirname + '/src/state',
      '@lib': import.meta.dirname + '/src/lib',
      '@context': import.meta.dirname + '/src/state',
      '@utils': import.meta.dirname + '/src/lib',
      '@wasm-audio-decoders/opus-ml': import.meta.dirname + '/src/player/engine/opusMlStub.ts',
    },
  },
  test: {
    environment: 'jsdom',
    globals: false,
    // Browser colour assertions need the actual stylesheet text. Keep ordinary
    // CSS imports disabled in jsdom, but do not replace ?raw imports with "".
    css: { include: [/\.css\?raw$/] },
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    root: import.meta.dirname,
    setupFiles: ['./src/test/test-setup.ts'],
    // Enable both shipped catalogs because copy assertions also exercise Spanish.
    env: { VITE_UI_LANGUAGES: 'es,en' },
  },
})
