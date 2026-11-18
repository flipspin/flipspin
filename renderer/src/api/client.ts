/** Use generated OpenAPI shapes so renamed server fields fail compilation. */

// The renderer bundles this client, so it does not need a packaged runtime dependency.
import createClient from 'openapi-fetch'

import type { paths } from './generated/schema'

/** Bind the origin after the shell selects a server; import-time configuration
 * can capture the wrong backend. The transport resolves credentials per request. */
export function createApiClient(origin: string) {
  return createClient<paths>({
    baseUrl: origin.replace(/\/+$/, ''),
    // Resolve fetch per call so later auth wrappers and test fakes take effect.
    // Quiet-when-unfocused applies to scheduled polls only (data/poll.ts).
    // A request something asked for (playback, the player window, an upload) goes out now.
    fetch: (request) => globalThis.fetch(request),
  })
}

export type ApiClient = ReturnType<typeof createApiClient>
