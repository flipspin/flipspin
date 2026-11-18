import { engineError } from './mp3'
export const RANGE_BYTES = 262144
async function readSlice(src: string, offset: number, signal: AbortSignal, firstByte?: (fields: object) => void) {
  if (signal.aborted) throw new DOMException('Cancelled', 'AbortError')
  const request = new AbortController()
  const abort = () => request.abort()
  signal.addEventListener('abort', abort, { once: true })
  const timeout = setTimeout(abort, 10001)
  try {
    let response: Response
    try { response = await fetch(src, { headers: { Range: `bytes=${offset}-${offset + RANGE_BYTES - 1}` }, signal: request.signal }) }
    catch (error) { throw Object.assign(new Error(String(error)), engineError('network')) }
    const cache = response.headers.get('x-cache') || response.headers.get('x-krobi-cache-hit')
    if (cache !== null) {
      let sources = localSources.get(signal)
      if (!sources) { sources = new Set(); localSources.set(signal, sources) }
      if (/^(hit|true)$/i.test(cache)) sources.add(src)
      else sources.delete(src)
    }
    firstByte?.({ receivedAt: performance.timeOrigin + performance.now(),
      cacheHit: response.headers.has('x-cache') || response.headers.has('x-krobi-cache-hit') ? /^(hit|true)$/i.test(response.headers.get('x-cache') || response.headers.get('x-krobi-cache-hit') || '') : undefined,
      requestId: response.headers.get('x-request-id') })
    if (!response.ok) throw Object.assign(new Error(`HTTP ${response.status}`), engineError('network', response.status))
    const contentRange = response.headers.get('content-range')
    const parts = contentRange?.match(/^bytes (\d+)-(\d+)\/(\d+)$/)
    const total = Number(parts?.[3] || response.headers.get('content-length'))
    // Never accept an unbounded 200 response to a Range request.
    if (!Number.isFinite(total) || total <= 0 || (!parts && total > RANGE_BYTES) || (parts && Number(parts[1]) !== offset)) {
      await response.body?.cancel(); throw Object.assign(new Error('Invalid Range response'), engineError('network'))
    }
    let bytes: Uint8Array
    try { bytes = new Uint8Array(await response.arrayBuffer()) }
    catch (error) { throw Object.assign(new Error(String(error)), engineError('network')) }
    if (bytes.length > 1048576 || (offset > 0 && response.status !== 206) || (parts && bytes.length !== Number(parts[2]) - offset + 1)) throw Object.assign(new Error('Invalid Range slice'), engineError('network'))
    return { bytes, total }
  } finally {
    clearTimeout(timeout); signal.removeEventListener('abort', abort)
  }
}

// Scope provenance to a load's cancellation signal: no URL cache can outlive a
// selection/account change. Keep the decoder and byte offset while retrying I/O.
const localSources = new WeakMap<AbortSignal, Set<string>>()
const BACKOFF = [1000, 2000, 4000, 8000, 15000]
export async function range(src: string, offset: number, signal: AbortSignal, firstByte?: (fields: object) => void) {
  let attempt = 0
  for (;;) {
    signal.throwIfAborted()
    try { return await readSlice(src, offset, signal, firstByte) }
    catch (error) {
      signal.throwIfAborted()
      if (!(localSources.get(signal)?.has(src) || /^(file|blob):/.test(src)) ||
          !error || typeof error !== 'object' || !('code' in error) || error.code !== 2) throw error
      await new Promise<void>((resolve, reject) => {
        const abort = () => { clearTimeout(timer); reject(new DOMException('Cancelled', 'AbortError')) }
        const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, BACKOFF[Math.min(attempt++, BACKOFF.length - 1)])
        signal.addEventListener('abort', abort, { once: true })
        if (signal.aborted) abort()
      })
    }
  }
}
