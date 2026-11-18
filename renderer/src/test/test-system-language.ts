/**
 * Pins the "system" language to Spanish for tests. Its own module because ES
 * imports are hoisted: a statement in `test-setup.ts` would run *after*
 * `../i18n` had already read `navigator.languages` at import time.
 */
Object.defineProperty(globalThis.navigator, 'languages', { value: ['es-ES'], configurable: true })
Object.defineProperty(globalThis.navigator, 'language', { value: 'es-ES', configurable: true })
