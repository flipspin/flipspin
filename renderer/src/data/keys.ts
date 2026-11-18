/** Order query keys from broad scope to resource, with variables in one trailing object.
 * Build keys here so mutations can invalidate whole scopes consistently.
 * Keep credentials and origins out: auth changes clear cached data through the provider. */

export const queryKeys = {
  desktop: {
    credentials: () => ['desktop', 'credentials'] as const,
  },
  /** `GET /api/spotify/status`; are the app's Spotify credentials configured. */
  spotify: {
    status: () => ['spotify', 'status'] as const,
  },
  stems: {
    all: ['stems'] as const,
    splits: () => ['stems', 'splits'] as const,
    song: (track: { album: string; file: string } | null) => ['stems', 'song', track ? { album: track.album, file: track.file } : null] as const,
  },
  /** The server itself: who it is, not what it holds. */
  server: {
    all: ['server'] as const,
    secrets: () => ['server', 'secrets'] as const,
    /** `GET /api/status`; the public handshake. */
    handshake: () => ['server', 'handshake'] as const,
    /** `GET /api/server/network`; every address the nest can be reached at. */
    network: () => ['server', 'network'] as const,
    /** `GET /api/server/storage`; the data disk, split (admin). */
    host: () => ['server', 'host'] as const,
    storage: () => ['server', 'storage'] as const,
    update: () => ['server', 'update'] as const,
    config: () => ['server', 'config'] as const,
    configStatus: () => ['server', 'config-status'] as const,
    /** `GET /api/providers`; the source registry (admin). */
    extensions: () => ['server', 'extensions'] as const,
    providers: () => ['server', 'providers'] as const,
    /** `GET /api/config/analysis-tags`; whether analysis writes tags. */
    analysisTags: () => ['server', 'analysis-tags'] as const,
    /** `GET /api/logs`; one window of a log file. */
    logs: (query: { file: string; lines: number; q: string }) => ['server', 'logs', query] as const,
  },

  /** The accounts on this nest, as an admin sees them. */
  household: {
    all: ['household'] as const,
    /** `GET /api/users`. */
    users: () => ['household', 'users'] as const,
    /** The same route as its raw `{users}` body, for Library's person picker.
     *  Never share `users()`: Settings caches the mapped list there, and one key
     *  holding two shapes crashed Settings with `data.filter is not a function`. */
    usersBody: () => ['household', 'users', 'body'] as const,
  },

  /** Anything scoped to whoever is holding the credential. */
  me: {
    all: ['me'] as const,
    /** `GET /api/me`; which principal this install is. */
    profile: () => ['me', 'profile'] as const,
    attention: () => ['me', 'attention'] as const,
    /** GET /api/me/library: the caller's saved tracks. */
    library: () => ['me', 'library'] as const,
    libraryAccount: (accountId: string) => ['me', 'library', 'account', { accountId }] as const,
    /** Owners can inspect several accounts at once; accountId is a scope parameter. */
    libraryMissing: (accountId: string) => ['me', 'library', 'missing', { accountId }] as const,
    /** `GET /api/me/devices`; the machines signed in to this account. */
    devices: () => ['me', 'devices'] as const,
  },

  /** The shared catalog on disk, which every member of the household sees. */
  library: {
    all: ['library'] as const,
    /** `GET /api/listar-albums-con-metadata`. */
    albums: (options: { covers: boolean }) => ['library', 'albums', options] as const,
    /** `GET /api/library/summary`; the folder and what it holds, counted. */
    summary: () => ['library', 'summary'] as const,
  },
} as const
