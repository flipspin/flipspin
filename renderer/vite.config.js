import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'fs'

const pkg = JSON.parse(readFileSync(path.resolve(__dirname, '../package.json'), 'utf-8'))

// Publish the dev server's *actual* port (Vite falls back off 5173 when it's
// taken) to .krobi-dev/frontend.port for browser-only development tooling.
function publishDevPort() {
  const stateDir = path.resolve(__dirname, '../.krobi-dev')
  const portFile = path.join(stateDir, 'frontend.port')
  const cleanup = () => { try { rmSync(portFile, { force: true }) } catch { /* ignore */ } }
  return {
    name: 'krobi-publish-dev-port',
    apply: 'serve',
    configureServer(server) {
      const httpServer = server.httpServer
      if (!httpServer) return
      httpServer.once('listening', () => {
        const addr = httpServer.address()
        const port = addr && typeof addr === 'object' ? addr.port : null
        if (!port) return
        try {
          mkdirSync(stateDir, { recursive: true })
          writeFileSync(portFile, String(port))
        } catch { /* best-effort; Electron falls back to probing */ }
      })
      httpServer.once('close', cleanup)
      process.once('exit', cleanup)
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  root: __dirname,
  plugins: [react(), tailwindcss(), publishDevPort()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    'import.meta.env.KROBI_PLAYBACK_TRACE': JSON.stringify(process.env.KROBI_PLAYBACK_TRACE ?? '0'),
  },
  resolve: {
    preserveSymlinks: true,
    alias: {
      '@state': path.resolve(__dirname, 'src/state'),
      '@lib': path.resolve(__dirname, 'src/lib'),
      '@context': path.resolve(__dirname, 'src/state'),
      '@utils': path.resolve(__dirname, 'src/lib'),
      // Never enabled by the player; keeps a 4 MB neural Opus enhancer out of the bundle.
      '@wasm-audio-decoders/opus-ml': path.resolve(__dirname, 'src/player/engine/opusMlStub.ts'),
    },
  },
  base: './', // Relative asset paths work inside the packaged app.
  // Format decoders are lazy worker chunks; the playback worker is a module.
  worker: { format: 'es' },
  server: {
    port: 5173,
    // Tauri's devUrl is fixed. Failing clearly is safer than opening a foreign
    // service on 5173 or silently moving Vite to a URL the native window lacks.
    strictPort: true,
  },
   build: {
    target: "esnext",
    outDir: "../build", // Empty the output directory so stale hashed chunks cannot be packaged.
    // All retained assets are copied again from renderer/public.
    emptyOutDir: true,
  },

})
