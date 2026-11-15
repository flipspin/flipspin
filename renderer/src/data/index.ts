/** Deprecated path kept for plugins; remove after v0.2. */
/** Import this bound data layer from screens so requests share origin resolution and error normalization. */

export { DataProvider } from './provider'
export { createQueryClient, retryDelayFor, shouldRetryRequest } from './query-client'
export { queryKeys } from './keys'

export {
  ApiError,
  isApiError,
  isClientError,
  isForbidden,
  isNotFound,
  isUnauthorized,
  serverDetail,
  type ApiErrorKind,
} from './errors'

export {
  apiDelete,
  apiGet,
  apiPatch,
  apiPost,
  apiPut,
  type ApiData,
  type ApiDataOr,
  type OrFallback,
  type PathsWith,
  type Unannotated,
  type Verb,
} from './http'

export { getApiClient, optionalBridge, resetApiClient } from './backend'

export { useServerHandshake, type HandshakeData } from './hooks/use-server-handshake'
export { useCurrentUser, type CurrentUser } from './hooks/use-current-user'
export { useLibraryAlbums, type LibraryAlbums } from './hooks/use-library-albums'

export { performRequest } from "./http";

export { useServerHost, type ServerHost } from './hooks/use-server-host'
export { useSpotifyStatus, spotifyConfigured, type SpotifyStatus } from './hooks/use-spotify-status'
