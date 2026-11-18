/** Node can shadow jsdom localStorage with an unavailable global.
 * Install a per-file memory store before modules that read storage at import time. */
function memoryStorage(): Storage {
  const map = new Map<string, string>()
  return {
    get length() {
      return map.size
    },
    clear: () => map.clear(),
    getItem: (key) => map.get(String(key)) ?? null,
    key: (index) => [...map.keys()][index] ?? null,
    removeItem: (key) => {
      map.delete(String(key))
    },
    setItem: (key, value) => {
      map.set(String(key), String(value))
    },
  }
}

if (typeof globalThis.localStorage?.getItem !== 'function') {
  Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage(), configurable: true, writable: true })
}
