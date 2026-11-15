/**
 * ogg-opus-decoder lazy-imports a 4 MB neural speech enhancer only when
 * `speechQualityEnhancement` is on. The player never turns it on, so the build
 * aliases the package here instead of shipping it (renderer/vite.config.js).
 */
export class OpusMLDecoder { constructor() { throw new Error('Opus speech enhancement is not bundled') } }
export class OpusMLDecoderWebWorker extends OpusMLDecoder {}
