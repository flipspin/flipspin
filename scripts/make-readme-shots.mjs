// Regenerate public screenshots: node scripts/make-readme-shots.mjs
// Home, album, Explorar, lyrics, Settings, remote access, Spotify import, first run, the home and album at night, and a 2x hero.
// Real Vite app + Chromium, with fixture responses at the HTTP boundary only.
// All names are invented. Covers are original procedural SVG, generated here.
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { mkdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { chromium } from 'playwright'
import { makeCover } from './readme-covers.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const out = `${root}docs/images`
const { version } = JSON.parse(await readFile(`${root}package.json`, 'utf8'))
const names = [
  ['Hyperbolic Escape', 'Nebula Workshop', 'Perihelion'],
  ['Phyllotaxis', 'Hexagon Haze', 'Sunflower'],
  ['Helmholtz Beats', 'Nebula Workshop', 'Two Close Tones'],
  ['Gibbs Overshoot', 'Prism Nine Trio', 'Odd Harmonics'],
  ['Dispersion', 'Saffron Circle', 'All the Colours You Were'],
  ['Dipole Field', 'Hexagon Haze', 'Fridge Magnets'],
  ['Lorenz Attractor', 'Prism Nine Trio', 'Sensitive Dependence'],
  ['L-System', 'Saffron Circle', 'Axiom F'],
  ['Logistic Map', 'Hexagon Haze', 'Period Doubling'],
  ['Voronoi', 'Nebula Workshop', 'Voronoi'],
]
const trackNames = ['Silk Threshold', 'Ceramic Steps', 'A Thread of Amber', 'Prism Dust', 'The Folded Echo', 'Origami Coda']
const years = [1979, 1984, 1991, 1997, 2003, 2009, 2014, 2019, 2023, 2026]
const genres = ['Electronic', 'Ambient', 'Jazz', 'Electronic', 'Indie', 'Post-rock', 'Electronic', 'Ambient', 'Jazz', 'Indie']
const moods = ['calm', 'upbeat', 'melancholic', 'groovy', 'romantic', 'dark']
const albums = names.map(([album, artist, title], i) => ({
  album, artist, path: `/music/fixture-${i + 1}`, year: years[i], genre: genres[i],
  dateAdded: 1793000000 - i * 86400, cover: null,
  tracks: [title, ...trackNames].map((name, j) => ({
    title: name, artist, album, path: `/music/fixture-${i + 1}/${j + 1}.flac`,
    duration: 180 + j * 17, track_number: j + 1, year: years[i], key: `${(i * 5 + j * 7) % 12 + 1}${(i + j) % 3 ? 'A' : 'B'}`, mood: moods[(i * 3 + j) % moods.length],
    dateAdded: 1793000000 - i * 86400 - j, bpm: [124, 98, 128, 86, 112, 140, 104, 122, 78, 132, 94, 158, 118, 70, 126, 108, 146, 172, 116, 90][(i * 7 + j * 3) % 20],
  })),
}))
const cover = makeCover(names)
const me = { id: 'demo', label: 'José Arcadio', username: 'José Arcadio', role: 'owner', isOwner: true, source: 'token', createdAt: '2026-01-01T00:00:00Z', lastSeenAt: null }
// An invented household: the owner and two members, each with their own devices.
const household = [me,
  { id: 'aureliano', label: 'Aureliano', role: 'member', createdAt: '2026-03-02T00:00:00Z', lastSeenAt: '2026-10-27T08:10:00Z' },
  { id: 'leo', label: 'Leo', role: 'member', createdAt: '2026-05-19T00:00:00Z', lastSeenAt: '2026-10-26T21:40:00Z' }]
const device = (id, label, seen, extra = {}) => ({ id, label, createdAt: '2026-06-01T00:00:00Z', lastSeenAt: seen, isCurrent: false, helper: false, ...extra })
const devicesOf = {
  demo: [device('demo-desktop', 'Sample Desktop', '2026-10-27T10:00:00Z', { isCurrent: true }), device('demo-phone', 'Pixel 8', '2026-10-27T09:12:00Z'), device('demo-helper', 'Studio Mac', '2026-10-27T09:58:00Z', { helper: true })],
  aureliano: [device('aureliano-phone', 'Aureliano’s iPhone', '2026-10-27T08:10:00Z'), device('aureliano-laptop', 'Aureliano’s Laptop', '2026-10-24T19:30:00Z')],
  leo: [device('leo-phone', 'Leo’s Phone', '2026-10-26T21:40:00Z')],
}
const providers = ['deezer', 'musicbrainz', 'lrclib', 'genius', 'lyricsovh', 'youtube'].map((id, position) => ({
  id, name: id === 'lrclib' ? 'LRCLIB' : id, kind: ['lrclib', 'genius', 'lyricsovh'].includes(id) ? 'lyrics' : 'metadata',
  enabled: id !== 'genius', available: id !== 'genius', position,
  description: '', capabilities: [], requiresCredentials: id === 'genius',
}))
const fixture = {
  '/api/status': { app: 'krobi', version, instanceId: 'readme-fixture', name: 'Sample Nest', isInit: true, setupDone: true, authMethods: ['token'] },
  '/api/me': me,
  // The owned catalog rows on the Explorar shot are saved to this account, so they show as marked.
  '/api/me/library': { tracks: [1, 2, 3, 4].map(n => ({ relPath: `fixture-3/${n}.flac`, addedAt: '2026-10-20T12:00:00Z', liked: false, offline: false, playCount: 0, lastPlayedAt: null })), count: 4 },
  '/api/get-basedir': { basedir: '/music' },
  '/api/listar-albums-con-metadata': albums,
  '/api/library/summary': { folder: '/music', songs: 70, albums: 10, artists: 4 },
  '/api/server/storage': { disk: { total: 64e9, free: 48e9 }, music: 12e9, stems: 3e9, other: 1e9 },
  '/api/users': { users: household },
  '/api/me/devices': { devices: devicesOf.demo },
  ...Object.fromEntries(Object.entries(devicesOf).map(([id, devices]) => [`/api/users/${id}/devices`, { devices }])),
  // Tailscale picked and proven: a signed-in device came in through the tailnet two hours ago.
  '/api/server/network': {
    lan: ['http://nest.local:8000'],
    tailscale: { ip: '100.101.102.103', name: 'sample-nest.tailnet-example.ts.net', url: 'http://100.101.102.103:8000' },
    externalUrl: null, route: 'tailscale', outside: { at: '2026-10-27T10:00:00Z', via: 'tailscale' },
  },
  '/api/providers': { providers },
  '/api/config/analysis-tags': { writeAnalysisTags: false },
  '/api/playlists': ['Morning Sketches', 'Walk Through Prisms', 'Paper Afternoon', 'Workshop Nights', 'Night Errands', 'Saturday Cleanup', 'Rain Study'].map((name, i) => ({ name, trackCount: 7 + i * 3, coverAlbums: [0, 1, 2, 3].map(k => `fixture-${((i * 3 + k * 2) % 9) + 1}`) })),
  '/api/downloads/active': { jobs: [] },
  '/api/jobs': { jobs: [], degraded: [] },
  '/api/lyrics/jobs': { autoFetch: false, withLyrics: 70, pendingCount: 0, pending: [], running: null, queued: 0, lastRun: null,
    engine: { mode: 'agent', queue: { queued: 0, leased: 0, online: false, agents: [] }, supported: false, installed: false, ready: false, hint: 'agent-needed', running: null, installing: null } },
  '/api/logs': { lines: [], total: 0, size: 0 },
  '/api/me/sign-in-requests': { requests: [] },
  // Nothing needs the owner's attention: no newer version, no helper machine to watch.
  '/api/me/attention': { version: null, helper: null, helpers: 0, flag: null, flagTone: null },
  '/api/server/update': { checking: false, current: version, latest: version, updateAvailable: false, releaseUrl: null,
    install: 'compose', pinned: false, command: null, checkedAt: '2026-10-27T11:00:00Z', lastError: null },
}
// The catalog album on the Explorar shot: invented, with a mix of verdicts.
const catalogId = '900001'
const catalogTitle = 'Chladni Figures'
const catalogArtist = 'Ember Orchestra'
const catalogTracks = ['Chalk Compass', 'The Faint Hours', 'Paper Kite', 'Lighthouses Out', 'Cricket Road', 'Astrolabe Waltz', 'Ten Thousand Miles', 'Nameless Harbor', 'Sepia Epilogue']
const dataSvg = svg => `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`
const catalogCover = dataSvg(makeCover(Array(11).fill([catalogTitle, catalogArtist]))(10))
const ref = (kind, id) => ({ id, provider: 'deezer', url: `https://www.deezer.com/${kind}/${id}` })
const browseAlbum = {
  album: {
    artistName: catalogArtist, artistRef: { id: '700001', provider: 'deezer', url: null }, coverUrl: catalogCover,
    genres: ['Electronic'], kind: 'album', label: 'Imaginary Records', recordType: 'album',
    ref: ref('album', catalogId), releaseDate: '2026-04-17', title: catalogTitle, trackCount: catalogTracks.length,
  },
  tracks: catalogTracks.map((title, i) => ({
    albumRef: ref('album', catalogId), albumTitle: catalogTitle, artistName: catalogArtist, artistRef: null,
    coverUrl: catalogCover, discNumber: 1, durationSeconds: 168 + i * 23, explicit: false, isrc: null, kind: 'track',
    previewUrl: null, ref: { id: String(800001 + i), provider: 'deezer', url: null }, title, trackPosition: i + 1,
  })),
}
const owned = i => ({
  match: { album: catalogTitle, artist: catalogArtist, durationSeconds: 168 + i * 23, path: `/music/fixture-3/${i + 1}.flac`, title: catalogTracks[i], trackNumber: i + 1 },
  nearMatch: null, owned: true, reason: null,
})
const ownership = { results: catalogTracks.map((_, i) => {
  if (i < 4) return owned(i)
  if (i === 5) return { match: null, owned: false, reason: 'Different length: 7:12 vs 4:23',
    nearMatch: { album: `${catalogTitle} (Extended Edition)`, artist: catalogArtist, durationSeconds: 432, path: '/music/fixture-3/6.flac', title: catalogTracks[5], trackNumber: 6 } }
  return { match: null, nearMatch: null, owned: false, reason: null }
}) }

// An original synced lyric (English, invented) for the first song of the first album.
const lrc = [
  [8, 'I left the window open to hear the linen'], [13, 'a spiral of thread that doesn\'t know where it goes'],
  [18, 'I count the steps the evening takes down the hall'], [23, 'and every echo comes back a little closer'],
  [29, 'Silk threshold, stay a minute more'], [34, 'the clay clock hasn\'t struck the hour'],
  [39, 'if I get lost inside your drawings'], [44, 'throw me a line, I\'ll find my way'],
  [50, 'Turn, turn, linen spiral'], [55, 'weave the morning out of what is left'],
  [60, 'turn, turn, the road is only'], [65, 'a loose thread someone picked up'],
  [71, 'The curtains keep a dust of prisms'], [76, 'the courtyard draws its circles of salt'],
  [81, 'and though no evening is the same'], [86, 'I come back to the window and begin'],
].map(([t, line]) => `[${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}.00]${line}`).join('\n')
fixture['/api/browse/album/deezer/900001'] = browseAlbum
fixture['/api/library/ownership'] = ownership
// Explorar's home: invented catalog rows (new releases, artists, genres), all procedural art.
const exploreAlbums = ['Fermat Spiral', 'Brachistochrone', 'Noether Charge', 'Riemann Sphere', 'Fourier Ghosts', 'Möbius Strip', 'Cantor Dust', 'Hilbert Curve', 'Euler Line', 'Chladni Figures']
const exploreArtists = ['Ember Orchestra', 'Quiet Lattice', 'Mono Tide', 'Field Notes Ensemble', 'Paper Comet', 'Lowlight Choir', 'Tangent Club', 'Static Garden']
const exploreCover = makeCover(exploreAlbums.map((t, i) => [t, exploreArtists[i % exploreArtists.length]]).concat([[catalogTitle, catalogArtist]]))
// Deezer's own genre pictures (catalog art, fine to show), fetched here and inlined; a colour tile if offline.
const deezerGenres = [[132, 'Pop', 'db7a604d9e7634a67d45cfc86b48370a'], [116, 'Rap/Hip Hop', '5c27115d3b797954afff59199dad98d1'], [122, 'Reggaeton', '44dfebf3cf943dd82759d9bd9063767a'], [152, 'Rock', 'b36ca681666d617edd0dcb5ab389a6ac'], [113, 'Dance', 'bd5fdfa1a23e02e2697818e09e008e69'], [165, 'R&B', '68a43aec844708e693cb99f47814153b'], [85, 'Alternative', 'fd252ab727d9a3b0b3c29014873f8f57'], [106, 'Electro', '15df4502c1c58137dae5bdd1cc6f0251'], [466, 'Folk', 'f9e070848998df8870ba65cd0d22b2b3'], [144, 'Reggae', '7b901a98628cf879e1465f1dfd697e00'], [129, 'Jazz', '91468ecc5dfdd19c42a43d2cbdf27059'], [84, 'Country', '6eca3188f724f04843a15e3e575751a5']]
const genreTiles = ['#2f6fe0', '#4f9a8b', '#d8413a', '#e9b949', '#5b4fc4', '#b5603a', '#141414', '#5f7a3c', '#c06aa0', '#2a1d4a', '#3e9e7e', '#f08a5d']
const exploreGenres = await Promise.all(deezerGenres.map(async ([id, name, hash], i) => {
  try {
    const res = await fetch(`https://cdn-images.dzcdn.net/images/misc/${hash}/250x250-000000-80-0-0.jpg`)
    if (!res.ok) throw new Error(res.status)
    return [id, name, `data:image/jpeg;base64,${Buffer.from(await res.arrayBuffer()).toString('base64')}`]
  } catch { return [id, name, null] }
}))
// Deezer's featured playlists by their real names; the covers are generic gradients, not Deezer's art.
const featuredPlaylists = ['Top Mexico', 'Reggaeton Classics', 'Éxitos con madre', "Pop México '00s", 'Fuego Latino', "Pop México '80s", 'Calm Piano', 'Novedades de la semana']
const gradient = (a, b, k) => dataSvg(`<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><rect width="256" height="256" fill="url(#g)"/><circle cx="${60 + k * 23 % 140}" cy="${190 - k * 31 % 120}" r="${46 + k * 7 % 40}" fill="#fff" opacity=".18"/></svg>`)
const playlistColours = [['#ff7a59', '#ffb347'], ['#2b2d42', '#ef233c'], ['#06d6a0', '#118ab2'], ['#f72585', '#7209b7'], ['#fb5607', '#ffbe0b'], ['#3a86ff', '#8338ec'], ['#cdb4db', '#a2d2ff'], ['#2a9d8f', '#e9c46a']]
const tile = (bg, text) => dataSvg(`<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="${bg}"/><text x="128" y="140" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-weight="700" font-size="30" fill="#fff">${text}</text></svg>`)
fixture['/api/dashboard'] = { provider: 'deezer', providerName: 'Deezer', cachedAt: '2026-10-27T09:00:00Z', stale: false, rows: [
  { id: 'new-releases', kind: 'album', provider: 'deezer', items: exploreAlbums.map((title, i) => ({ id: String(910001 + i), title: i === 9 ? catalogTitle : title, subtitle: i === 9 ? catalogArtist : exploreArtists[i % exploreArtists.length], imageUrl: i === 9 ? catalogCover : dataSvg(exploreCover(i)) })) },
  { id: 'top-artists', kind: 'artist', provider: 'deezer', items: exploreArtists.map((name, i) => ({ id: String(920001 + i), title: name, imageUrl: dataSvg(exploreCover((i * 3 + 1) % 10)) })) },
  { id: 'genres', kind: 'genre', provider: 'deezer', items: exploreGenres.map(([id, name, img], i) => ({ id: String(id), title: name, imageUrl: img ?? tile(genreTiles[i], '') })) },
  { id: 'top-playlists', kind: 'playlist', provider: 'deezer', items: featuredPlaylists.map((title, i) => ({ id: String(940001 + i), title, subtitle: 'Deezer', imageUrl: gradient(...playlistColours[i], i) })) },
] }
fixture['/api/lyrics/fixture-1/1.flac'] = {
  revision: 'r1', relPath: 'fixture-1/1.flac', kind: 'synced', source: 'lrclib', providerRef: null, fetchedAt: 1793000000,
  edited: false, sidecar: '1.lrc', title: names[0][2], artist: names[0][1], lineConfidence: null, lowLines: null, result: null, text: lrc,
}

// A Spotify data export with two invented playlists; the first one is resolved
// into 38 confident matches, 6 to review and 2 rejected.
const words = ['Amber', 'Velvet', 'Harbor', 'Paper', 'Neon', 'Quiet', 'Copper', 'Silver', 'Midnight', 'Glass', 'Cinder', 'Lantern']
const nouns = ['Streets', 'Signal', 'Tide', 'Avenue', 'Echo', 'Window', 'Static', 'Orchard', 'Comet', 'Satellite', 'River', 'Parade']
const bands = ['The Low Lanterns', 'Mira Vale', 'Coastline Club', 'Juniper & Oak', 'Static Gardens', 'Ada Roux', 'Northbound Kids', 'Halfmoon Choir']
const driveTracks = Array.from({ length: 46 }, (_, i) => ({
  title: `${words[i % 12]} ${nouns[(i * 5 + 3) % 12]}`, artist: bands[i % 8], album: `${nouns[(i * 7) % 12]} Sessions`,
  spotifyUri: `spotify:track:readme${String(i).padStart(4, '0')}`, addedAt: '2026-09-01T20:00:00Z',
}))
const kitchenTracks = Array.from({ length: 21 }, (_, i) => ({
  title: `${nouns[(i + 4) % 12]} of ${words[(i * 3) % 12]}`, artist: bands[(i + 3) % 8], album: `${words[(i + 6) % 12]} Hours`,
  spotifyUri: `spotify:track:readmek${String(i).padStart(3, '0')}`, addedAt: '2026-09-02T10:00:00Z',
}))
const spotifyExport = {
  playlistCount: 2, trackCount: 67, warnings: [], sourceFiles: ['Playlist1.json'], unreadMembers: [], unrecognizedCount: 0,
  playlists: [
    { name: 'Late Night Drive', description: '', modifiedAt: '2026-09-30', trackCount: 46, tracks: driveTracks },
    { name: 'Sunday Kitchen', description: '', modifiedAt: '2026-09-28', trackCount: 21, tracks: kitchenTracks },
  ],
}
const resolved = driveTracks.map((t, i) => {
  const wanted = { title: t.title, artist: t.artist, album: t.album }
  const base = { title: t.title, artist: t.artist, album: t.album, durationSeconds: 190 + i * 3, provider: 'deezer', providerId: String(600000 + i), isrc: `XX${String(i).padStart(10, '0')}`, recordingMbid: null }
  if (i % 6 === 3) return null // 8 rows: 6 to review, 2 rejected
  return { wanted, confidence: 'strong', explanation: 'distance 0.02, identified by ISRC', match: { ...base, distance: 0.02, reasons: [] } }
})
const reviewCases = [
  m => ({ match: { ...m, title: `${m.title} (Live)`, distance: 0.31, reasons: ['title differs (0.24)'] }, explanation: 'distance 0.31 needs confirmation' }),
  m => ({ match: { ...m, album: 'Greatest Hits', isrc: null, distance: 0.12, reasons: ['no duration to compare'] }, explanation: 'good text match but no ISRC or MBID to pin it to' }),
  m => ({ match: { ...m, durationSeconds: m.durationSeconds + 41, distance: 0.28, reasons: ['duration differs by 41s'] }, explanation: 'distance 0.28 needs confirmation' }),
  m => ({ match: { ...m, title: `${m.title} - 2019 Remaster`, distance: 0.22, reasons: ['title differs (0.18)'] }, explanation: 'too close to call: runner-up is only 0.03 behind' }),
  m => ({ match: { ...m, artist: `${m.artist} feat. Ada Roux`, distance: 0.26, reasons: ['artist differs (0.21)'] }, explanation: 'distance 0.26 needs confirmation' }),
  m => ({ match: { ...m, album: 'Sessions EP', isrc: null, distance: 0.14, reasons: ['no duration to compare'] }, explanation: 'good text match but no ISRC or MBID to pin it to' }),
]
let review = 0
const rows = resolved.map((row, i) => {
  if (row) return row
  const t = driveTracks[i]
  const wanted = { title: t.title, artist: t.artist, album: t.album }
  const m = { title: t.title, artist: t.artist, album: t.album, durationSeconds: 190 + i * 3, provider: 'deezer', providerId: String(600000 + i), isrc: `XX${String(i).padStart(10, '0')}`, recordingMbid: null }
  if (review < 6) return { wanted, confidence: 'review', ...reviewCases[review++](m) }
  return review++ === 6
    ? { wanted, confidence: 'rejected', explanation: 'no candidates returned', match: null }
    : { wanted, confidence: 'rejected', explanation: 'best candidate was vetoed: vetoed: one side is a live/remix/edit/instrumental version',
        match: { ...m, title: `${m.title} (Instrumental)`, distance: 0.61, reasons: ['vetoed: one side is a live/remix/edit/instrumental version'] } }
})
const bucket = c => rows.filter(r => r.confidence === c)
assert.deepEqual([bucket('strong').length, bucket('review').length, bucket('rejected').length], [38, 6, 2])
const resolveId = 'readme-resolve-1'
// Nothing missing from the library and no acquisition in flight.
fixture['/api/me/library/missing'] = { relPaths: [] }
fixture['/api/acquisition/requests'] = { requests: [] }
// Background work and library health: an idle queue and a healthy library.
fixture['/api/compute/summary'] = { paused: false, waiting: 0, kinds: [], computers: [] }
fixture['/api/sources/known'] = { sources: [] }
const healthStat = (value, store) => ({ value, state: 'ready', reason: null, source: { store, asOf: '2026-10-27T11:00:00Z' } })
fixture['/api/library/health'] = { checkedAt: '2026-10-27T11:00:00Z', checks: [], stats: {
  songs: healthStat(1284, 'library'), albums: healthStat(112, 'library'), addedThisWeek: healthStat(14, 'library'),
  lastScanAt: healthStat('2026-10-27T11:00:00Z', 'scan'), lastBackupAt: healthStat('2026-10-27T03:00:00Z', 'backups') } }
fixture['/api/library/scan'] = { scanning: false, pending: false, watching: true, lastScanAt: '2026-10-27T11:00:00Z', durationSeconds: 4.2, error: null }
fixture['/api/me/home'] = { albums: fixture['/api/listar-albums-con-metadata'], library: fixture['/api/me/library'], playlists: fixture['/api/playlists'] }
fixture['/api/playlists/spotify-export/parse'] = spotifyExport
fixture['/api/playlists/spotify-export/resolve'] = { success: true, status: 'started', progress_id: resolveId, playlistName: 'Late Night Drive', total: 46 }
fixture[`/api/playlists/spotify-export/resolve/${resolveId}`] = {
  progressId: resolveId, playlistName: 'Late Night Drive', status: 'done', total: 46, resolved: 46, error: null,
  counts: { strong: 38, review: 6, rejected: 2 }, results: { strong: bucket('strong'), review: bucket('review'), rejected: bucket('rejected') },
}
const resolveDone = { total: 46, completed: 46, done: driveTracks.map(t => `${t.artist} - ${t.title}`), active: {}, status: 'done', terminal: true, succeeded: 46, failed: 0 }

// Four minutes of silence: enough for the player to report a real duration.
// 16-bit, because the player's engine decodes 16-, 24- and 32-bit WAV only.
function silentWav(seconds = 240, rate = 8000) {
  const n = seconds * rate
  const b = Buffer.alloc(44 + n * 2)
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16)
  b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28)
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40)
  return b
}
// The app plays through one Web Audio engine (no <audio> element); the shots read it here.
const exposeEngine = page => page.evaluate(async () => { window.__shotEngine = (await import('/src/player/engine/PlaybackEngine.ts')).playbackEngine })
const silence = silentWav()

// A procedural beat for the visualizer, which needs a signal to draw: a kick on
// every beat at 120 bpm, a hat on the off-beats and an A-minor pad. Made here,
// so no recording is involved.
function beatWav(seconds = 240, rate = 22050) {
  const n = seconds * rate
  const b = Buffer.alloc(44 + n * 2)
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16)
  b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28)
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40)
  let seed = 7
  const noise = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x3fffffff) - 1
  for (let i = 0; i < n; i++) {
    const t = i / rate, beat = t % 0.5, off = (t + 0.25) % 0.5
    const kick = Math.sin(2 * Math.PI * (50 + 90 * Math.exp(-beat * 30)) * beat) * Math.exp(-beat * 9)
    const hat = noise() * Math.exp(-off * 60) * 0.25
    const pad = [220, 261.63, 329.63].reduce((sum, f) => sum + Math.sin(2 * Math.PI * f * t), 0) * 0.08 * (0.6 + 0.4 * Math.sin(2 * Math.PI * 0.25 * t))
    b.writeInt16LE(Math.round(Math.max(-1, Math.min(1, kick * 0.8 + hat + pad)) * 30000), 44 + i * 2)
  }
  return b
}
const beat = beatWav()
let mediaAudio = silence

// A clean clone has no renderer plugins (renderer/src/plugins/* is gitignored and
// linked per machine). Render the host as published, whatever is linked here.
const noLocalPlugins = {
  name: 'readme-shots-no-local-plugins', enforce: 'pre',
  transform(code, id) {
    if (!id.replace(/\\/g, '/').endsWith('/renderer/src/plugins/index.ts')) return null
    const next = code.replace(/import\.meta\.glob(<[^(]*>)?\([^)]*\)/, '({})')
    assert.notEqual(next, code, 'plugin registry glob not found')
    return next
  },
}

// The desktop shell's bridge, answered at the IPC boundary. `connected` is a
// signed-in desktop talking to a nest on this machine's loopback; otherwise it
// is a first run where nobody has picked a nest yet.
function shellBridge({ connected, handshake }) {
  const origin = 'http://localhost:8000'
  const connection = connected
    ? { state: 'connected', since: 0, attempt: 1, lastError: null, checks: [] }
    : { state: 'unchosen', since: 0, attempt: 0, lastError: null, checks: [] }
  const status = connected
    ? { name: handshake.name ?? null, connection, mode: 'external', baseUrl: origin, port: 8000, pid: null, instanceId: handshake.instanceId, identified: true, reachable: true,
        adopted: false, ownedByUs: false, problem: null, starting: false, lanUrl: null }
    : { name: null, connection, mode: 'unchosen', baseUrl: null, port: null, pid: null, instanceId: null, identified: false, reachable: false,
        adopted: false, ownedByUs: false, problem: null, starting: false, lanUrl: null }
  const answers = {
    'server:get-status': status, 'app:get-backend-origin': { origin }, 'app:get-device-name': { name: 'Studio' },
    'app:get-version': { version: handshake.version }, 'server:discover': { nests: [] },
    'server:probe': { ok: true, url: origin, handshake },
    'auth:get': connected ? { userId: 'demo', label: 'José Arcadio', role: 'owner', hasToken: true } : null,
    'lyrics:engine-status': { supported: false },
    // No saved offline copy: undefined sends every read to the (fixture) server; null would mean «no copy, stay offline».
    // No custom HTTP headers for this nest.
    'headers:get': [],
    'offline:snapshot': undefined, 'offline:outbox': [],
    'offline:status': { pins: 0, files: 0, bytes: 0, tracks: [] },
    'offline:pools': { pins: [], offline: { bytes: 0, files: 0, location: '' }, cache: { bytes: 0, files: 0, location: '' }, cacheBudget: 0 },
  }
  window.krobi = { invoke: async channel => (channel in answers ? answers[channel] : null), on: () => () => {} }
}

await mkdir(out, { recursive: true })
const server = await createServer({ configFile: `${root}renderer/vite.config.js`, plugins: [noLocalPlugins], server: { host: '127.0.0.1', port: 5188, strictPort: false, hmr: false, watch: null } })
let browser
const errors = []
const consoleErrors = []
const unexpected = new Set()
try {
  await server.listen()
  const origin = server.resolvedUrls.local[0]
  browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] })

  async function openPage({ scale = 1, connected = true } = {}) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: scale, locale: 'en-US', colorScheme: 'light', reducedMotion: 'reduce', serviceWorkers: 'block' })
    // Intercept every HTTP request before it can reach a real backend or provider.
    await context.route('**/*', async route => {
      const url = new URL(route.request().url())
      const headers = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' }
      if (url.pathname.startsWith('/api/')) {
        if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers })
        // Stems: the first album's songs are split; each stem is the same silence, so the mix decodes.
        if (url.pathname === '/api/stems') return route.fulfill({ json: { splits: albums[0].tracks.map(t => ({ album: 'fixture-1', file: t.path.split('/').pop(), title: t.title, artist: t.artist, albumTitle: albums[0].album, createdAt: '2026-10-25T12:00:00Z', stale: false })) }, headers })
        if (url.pathname === '/api/stems/jobs') return route.fulfill({ json: { jobs: [], agent: { online: true, lastSeen: null, name: 'Helper' }, mode: 'agent' }, headers })
        if (/^\/api\/stems\/.+\/(drums|bass|other|vocals)$/.test(url.pathname)) return route.fulfill({ contentType: 'audio/wav', body: silence, headers })
        if (/^\/api\/stems\/[^/]+\/[^/]+$/.test(url.pathname)) {
          const base = url.pathname
          return route.fulfill({ json: { createdAt: '2026-10-25T12:00:00Z', track: { duration: 180 }, stems: Object.fromEntries(['drums', 'bass', 'other', 'vocals'].map(s => [s, `${base}/${s}`])) }, headers })
        }
        const match = url.pathname.match(/^\/api\/media\/fixture-(\d+)\/cover.jpg$/)
        if (match) return route.fulfill({ contentType: 'image/svg+xml', body: cover(Number(match[1]) - 1), headers })
        if (/^\/api\/media\/fixture-\d+\/\d+\.flac$/.test(url.pathname)) {
          // Honour Range like the real media route, or the browser cannot seek.
          const range = /bytes=(\d+)-(\d*)/.exec(route.request().headers().range || '')
          const audio = mediaAudio
          if (!range) return route.fulfill({ contentType: 'audio/wav', body: audio, headers: { ...headers, 'accept-ranges': 'bytes' } })
          const start = Number(range[1])
          const end = range[2] ? Math.min(Number(range[2]), audio.length - 1) : audio.length - 1
          return route.fulfill({ status: 206, contentType: 'audio/wav', body: audio.subarray(start, end + 1),
            headers: { ...headers, 'accept-ranges': 'bytes', 'content-range': `bytes ${start}-${end}/${audio.length}`, 'access-control-expose-headers': 'content-range, accept-ranges' } })
        }
        // No measured ReplayGain for the fixture songs: the player plays them at unity gain.
        if (/^\/api\/analysis\/fixture-\d+\/[^/]+\/replaygain$/.test(url.pathname)) return route.fulfill({ json: null, headers })
        if (url.pathname === `/api/download-progress-stream/${resolveId}`)
          return route.fulfill({ contentType: 'text/event-stream', body: `data: ${JSON.stringify(resolveDone)}\n\n`, headers })
        if (Object.hasOwn(fixture, url.pathname)) return route.fulfill({ json: fixture[url.pathname], headers })
        // Older-server compatibility: this fixture intentionally has no capacity API.
        if (url.pathname === '/api/server/config') return route.fulfill({ status: 404, json: { detail: 'Not Found' }, headers })
        unexpected.add(url.pathname)
        return route.fulfill({ status: 404, json: { detail: 'Missing screenshot fixture' }, headers })
      }
      if (url.origin === new URL(origin).origin) return route.continue()
      unexpected.add(url.origin + url.pathname)
      return route.abort('blockedbyclient')
    })
    const page = await context.newPage()
    page.setDefaultTimeout(15000)
    page.on('pageerror', error => errors.push(error.message))
    page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()) })
    await page.clock.setFixedTime(new Date('2026-10-27T12:00:00Z'))
    await page.addInitScript(() => {
      // Theme and mode survive a reload through sessionStorage; everything else starts clean.
      const theme = sessionStorage.getItem('shot.theme') || 'paper'
      const mode = sessionStorage.getItem('shot.mode') || 'light'
      localStorage.clear()
      localStorage.setItem('krobi.language', 'en')
      localStorage.setItem('theme', theme)
      localStorage.setItem('krobi.mode', mode)
      localStorage.setItem('krobi.bottomBarDrawerOpen', '0')
      localStorage.setItem('krobi.web.credential', JSON.stringify({ token: 'fixture-only', userId: 'demo', label: 'José Arcadio', role: 'owner' }))
    })
    await page.addInitScript(shellBridge, { connected, handshake: fixture['/api/status'] })
    return page
  }

  // page.clock pins the page's time, and Playwright's in-page waits measure with it,
  // so a missing element would wait forever. Every step gets a deadline kept in Node.
  const within = (label, promise, ms = 20000) => Promise.race([promise, new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`timed out: ${label}`)), ms))])
  const shot = async (page, name, mode = 'light', { keepMouse = false } = {}) => {
    if (!keepMouse) await page.mouse.move(0, 0)
    // Fonts and images first; an image that never settles (lazy, off-screen) must not hold the shot.
    await Promise.race([page.evaluate(async () => {
      await document.fonts.ready
      await Promise.all([...document.images].map(img => img.decode().catch(() => {})))
    }), new Promise(resolve => setTimeout(resolve, 5000))])
    const html = page.locator('html')
    if (await html.getAttribute('data-mode') !== null) assert.equal(await html.getAttribute('data-mode'), mode)
    assert.doesNotMatch(await page.locator('body').innerText(), /192\.168\.|\/Users\/|Conexiones|Connections/i)
    // A field shows its value, or its placeholder when empty; innerText has neither.
    const fields = await page.evaluate(() => [...document.querySelectorAll('input, textarea')].map(el => el.value || el.placeholder).join(' '))
    // 192.168.1.20 is the app's own example address in the first-run placeholders, not a real one.
    assert.doesNotMatch(fields.replaceAll('192.168.1.20', ''), /192\.168\.|\/Users\//i)
    const macs = `${await page.locator('body').innerText()} ${fields}`.match(/\bMac\b/g)
    if (macs) console.log(`NOTE ${name}: «Mac» appears ${macs.length}×`)
    await page.screenshot({ path: `${out}/${name}.png`, animations: 'disabled' })
    const scale = await page.evaluate(() => window.devicePixelRatio)
    console.log(`PASS docs/images/${name}.png — ${1440 * scale}×${900 * scale}, ${mode}, fixture data`)
  }
  const home = async page => {
    await within("page.getByRole('heading', { name: 'Recently ", page.getByRole('heading', { name: 'Recently added', exact: true }).waitFor()).catch(async error => {
      // Show what the app drew instead, so a new gate or screen is obvious.
      const where = `${tmpdir()}/readme-shots-failure.png`
      await page.screenshot({ path: where }).catch(() => {})
      console.error(`home did not load; the page is at ${where}`)
      const detail = await page.locator('details').first().textContent().catch(() => '')
      console.error("unexpected:", [...unexpected].join(" "))
      console.error([...errors, ...consoleErrors.slice(0, 3), detail].filter(Boolean).join('\n').slice(0, 2000))
      throw error
    })
    await within('page.getByText(names[0][2], { exact: tru', page.getByText(names[0][2], { exact: true }).waitFor())
    await within("page.getByText('Morning Sketches', { exa", page.getByText('Morning Sketches', { exact: true }).last().waitFor())
  }
  // Each home shot opens the library panel on a different view: 0 Tempo, 1 Key, 2 Mood, 3 Eras, 4 Genres, 5 Listening (Mood needs energy data the fixtures lack).
  const panel = async (page, card) => {
    // The dots stack as a carousel and overlap at this width, so a pointer click lands on the current one.
    await within(`panel view ${card}`, page.locator('.z-story-dots button').nth(card).evaluate(b => b.click()))
    await page.waitForTimeout(300)
  }

  const page = await openPage()
  await page.goto(origin)
  await within('home', home(page))
  await panel(page, 1)
  await shot(page, 'screenshot-home')

  // The same module the app's album links call; no component replacements.
  await page.evaluate(async album => (await import('/src/browse/navigationStore.ts')).openLibraryAlbum(album), albums[0])
  await within("page.getByRole('heading', { name: names[", page.getByRole('heading', { name: names[0][0], exact: true }).waitFor())
  await within("page.locator('.retro-song-table__row').n", page.locator('.retro-song-table__row').nth(6).waitFor())
  await shot(page, 'screenshot-album')

  // Explorar: a catalog album with what the library already holds marked.
  await page.evaluate(async ([id, title]) => (await import('/src/browse/navigationStore.ts')).push({ kind: 'album', provider: 'deezer', id, title }), [catalogId, catalogTitle])
  await within("page.getByRole('heading', { name: catalo", page.getByRole('heading', { name: catalogTitle, exact: true }).waitFor())
  await within("page.locator('.browse-row--owned').nth(3", page.locator('.browse-row--owned').nth(3).waitFor())
  await page.waitForTimeout(400)
  await shot(page, 'screenshot-explorar')
  await page.evaluate(async () => (await import('/src/browse/navigationStore.ts')).reset())

  // Explorar's home: the catalog rows, with what you already own marked on the album cards.
  await within('explore nav', page.getByRole('button', { name: 'Explore', exact: true }).click())
  await within('explore rows', page.getByText('Fermat Spiral', { exact: true }).first().waitFor({ timeout: 45000 }), 45000)
  await within('explore genres', page.getByText('Reggaeton', { exact: true }).first().waitFor())
  await within('explore playlists', page.getByText('Calm Piano', { exact: true }).first().waitFor())
  await page.waitForTimeout(600)
  await shot(page, 'screenshot-explore-home')

  await within("page.getByRole('button', { name: 'Home',", page.getByRole('button', { name: 'Home', exact: true }).click())
  await within("page.getByRole('button', { name: 'Settin", page.getByRole('button', { name: 'Settings', exact: true }).click())
  const dialog = page.locator('.settings.krobi-settings')
  await within("dialog.getByRole('heading', { name: 'Ove", dialog.getByRole('heading', { name: 'Overview', exact: true }).waitFor())
  await within("dialog.getByText('70 songs', { exact: tr", dialog.getByText('70 songs', { exact: true }).waitFor())
  await within("dialog.getByText('Nothing to do', { exac", dialog.getByText('Nothing to do', { exact: true }).waitFor())
  assert.equal(await dialog.locator('.settings-skel').count(), 0)
  await shot(page, 'screenshot-settings')

  // Every shot wears paper light; the README's dark images use the night mode.
  await page.evaluate(() => { sessionStorage.setItem('shot.theme', 'paper'); sessionStorage.setItem('shot.mode', 'night') })
  await page.goto(origin)
  await within('home', home(page))
  assert.equal(await page.locator('html').getAttribute('data-mode'), 'night')
  await panel(page, 4)
  await shot(page, 'home-dark', 'night')
  await page.evaluate(async album => (await import('/src/browse/navigationStore.ts')).openLibraryAlbum(album), albums[0])
  await within('night album', page.getByRole('heading', { name: names[0][0], exact: true }).waitFor())
  await within('night rows', page.locator('.retro-song-table__row').nth(6).waitFor())
  await shot(page, 'album-dark', 'night')
  await page.context().close()

  // The hero: the home screen at 2×.
  const hero = await openPage({ scale: 2 })
  await hero.goto(origin)
  await within('home', home(hero))
  await panel(hero, 3)
  await shot(hero, 'screenshot-home@2x')
  await hero.context().close()

  // First run: the desktop shell has not been told where the nest is.
  const first = await openPage({ connected: false })
  await first.goto(origin)
  // No welcome screen since the first-run rework: the wizard opens on «Choose your nest».
  await within('nest step', first.getByText('Choose your nest', { exact: true }).first().waitFor({ timeout: 30000 }), 30000)
  await within('this mac row', first.getByText('Make the nest here', { exact: true }).first().waitFor({ timeout: 15000 }), 15000)
  const address = first.locator('#kob-address')
  if (await address.count()) await within('address', address.fill('nest.local:8000'))
  await first.waitForTimeout(300)
  await shot(first, 'screenshot-onboarding')
  await first.context().close()


  // Settings → Remote access: Tailscale picked, checked against this nest.
  const nest = await openPage()
  await nest.goto(origin)
  await within('home', home(nest))
  await within('open settings', nest.getByRole('button', { name: 'Settings', exact: true }).click())
  const settings = nest.locator('.settings.krobi-settings')
  await within('remote nav', settings.locator('.settings-nav__item', { hasText: 'Remote access' }).click())
  await within('detected', settings.getByText('sample-nest.tailnet-example.ts.net').first().waitFor())
  const check = settings.getByRole('button', { name: 'Check', exact: true })
  if (await check.count()) await within('check', check.first().click())
  await within('connected', settings.getByText('Connected').first().waitFor())
  await nest.waitForTimeout(400)
  await shot(nest, 'screenshot-remote-access')
  // Settings pages alone, at 2x: no sidebar, no player bar, clipped to what the page draws.
  async function settingsCloseUp(file, nav, ready, aspect = null) {
    const pg = await openPage({ scale: 2 })
    await pg.goto(origin)
    await within('home', home(pg))
    await within('open settings', pg.getByRole('button', { name: 'Settings', exact: true }).click())
    const aj = pg.locator('.settings.krobi-settings')
    if (nav) await within(`${file} nav`, aj.locator('.settings-nav__item', { hasText: nav }).first().click())
    await ready(aj)
    assert.equal(await aj.locator('.settings-skel').count(), 0)
    await pg.waitForTimeout(400)
    const clip = await aj.locator('.settings-main').evaluate(main => {
      const boxes = [...main.querySelectorAll(':scope > * > *')].map(el => el.getBoundingClientRect()).filter(r => r.width && r.height)
      const x = Math.min(...boxes.map(r => r.left)), y = Math.min(...boxes.map(r => r.top))
      const r = Math.max(...boxes.map(r => r.right))
      // Stop at the bottom of the settings scroller (above the player bar) when the page is taller than the window.
      const bar = (main.closest('.settings') ?? document.documentElement).getBoundingClientRect().bottom || innerHeight
      const b = Math.min(Math.max(...boxes.map(r => r.bottom)) + 30, bar - 40)
      return { x: x - 24, y: y - 6, width: r - x + 48, height: b - y }
    })
    // In the Screens grid it sits beside 1440×900 shots: crop to their shape from the top.
    if (aspect) clip.height = Math.min(clip.height, clip.width / aspect)
    await pg.screenshot({ path: `${out}/${file}.png`, clip })
    console.log(`PASS docs/images/${file}.png — ${nav || 'Overview'} alone, 2x`)
    await pg.context().close()
  }
  await settingsCloseUp('screenshot-remote-access-panel', 'Remote access', async aj => {
    await within('detected', aj.getByText('sample-nest.tailnet-example.ts.net').first().waitFor())
    const recheck = aj.getByRole('button', { name: 'Check', exact: true })
    if (await recheck.count()) await within('check', recheck.first().click())
    await within('connected', aj.getByText('Connected').first().waitFor())
  })
  await settingsCloseUp('screenshot-settings-panel', null, async aj => {
    await within('overview', aj.getByRole('heading', { name: 'Overview', exact: true }).waitFor())
    await within('songs', aj.getByText('70 songs', { exact: true }).waitFor())
  }, 1440 / 900)
  await settingsCloseUp('screenshot-accounts-panel', 'Accounts', async aj => {
    await within('aureliano', aj.getByText('Aureliano', { exact: true }).first().waitFor())
    await within('open aureliano', aj.getByText('Aureliano', { exact: true }).first().click())
    await within('aureliano devices', aj.getByText(/Aureliano’s iPhone/).first().waitFor())
  })

  // Settings → Library → Spotify data file, at the review step after resolve.
  await within('library nav', settings.locator('.settings-nav__item', { hasText: /^Library$/ }).click())
  await within('spotify', settings.getByRole('button', { name: /Spotify data file/ }).click())
  await within('upload', nest.locator('input[type="file"]').first().setInputFiles({ name: 'my_spotify_data.zip', mimeType: 'application/zip', buffer: Buffer.from('PK\x05\x06' + '\0'.repeat(18), 'binary') }))
  await within('picker', nest.getByText('Late Night Drive', { exact: true }).first().click())
  await within('find', nest.getByRole('button', { name: 'Find matches', exact: true }).click())
  await within('review', nest.getByText(driveTracks[3].title).first().waitFor())
  await nest.waitForTimeout(500)
  await shot(nest, 'screenshot-spotify-import')
  await nest.context().close()

  // Stems: the playing song split into four, a mix dialled in on the faders.
  // Once at 1x for the whole window, once at 2x for a close-up of the panel.
  async function stemsMix(scale) {
    const mixer = await openPage({ scale })
    await mixer.goto(origin)
    await within('home', home(mixer))
    await mixer.evaluate(async album => (await import('/src/browse/navigationStore.ts')).openLibraryAlbum(album), albums[0])
    await within('album', mixer.getByRole('heading', { name: names[0][0], exact: true }).waitFor())
    await within('play', mixer.getByRole('button', { name: `Play ${names[0][2]}`, exact: true }).click({ force: true }))
    await exposeEngine(mixer)
    await within('playing', mixer.waitForFunction(() => { const a = window.__shotEngine; return a && a.duration > 100 && !a.paused }, null, { polling: 250 }))
    await within('stems button', mixer.getByRole('button', { name: 'Stems', exact: true }).click())
    const stemsPage = mixer.locator('.stems-page')
    await within('ready', stemsPage.getByText('Split into stems', { exact: true }).waitFor())
    await mixer.evaluate(async () => {
      const { stemPlayer } = await import('/src/stems/StemPlayer.ts')
      stemPlayer.setLevel('bass', 100 * 10 ** (2 / 20))
      stemPlayer.setLevel('other', 100 * 10 ** (-3.5 / 20))
      stemPlayer.setLevel('vocals', 100 * 10 ** (-12 / 20))
    })
    await mixer.waitForTimeout(1500)
    return mixer
  }
  const mixer = await stemsMix(1)
  await shot(mixer, 'screenshot-stems')
  await mixer.context().close()
  const closeUp = await stemsMix(2)
  await closeUp.locator('.stems-drawer').screenshot({ path: `${out}/screenshot-stems-panel.png` })
  console.log('PASS docs/images/screenshot-stems-panel.png — the stems panel at 2x')
  await closeUp.context().close()

  // Last, so the other shots never wait on audio: synced lyrics over the first
  // song, a minute in, opened with the app's own «L» shortcut.
  const listen = await openPage()
  await listen.goto(origin)
  await within('home', home(listen))
  await listen.evaluate(async album => (await import('/src/browse/navigationStore.ts')).openLibraryAlbum(album), albums[0])
  await within('album', listen.getByRole('heading', { name: names[0][0], exact: true }).waitFor())
  await within('play', listen.getByRole('button', { name: `Play ${names[0][2]}`, exact: true }).click({ force: true }))
  await exposeEngine(listen)
  await within('playing', listen.waitForFunction(() => { const a = window.__shotEngine; return a && a.duration > 100 && !a.paused }, null, { polling: 250 }))
  await listen.mouse.click(720, 30)
  await listen.keyboard.press('l')
  await within('lyrics open', listen.getByText('Turn, turn, linen spiral').first().waitFor())
  await listen.evaluate(() => { window.__shotEngine.currentTime = 51 })
  await within('seeked', listen.waitForFunction(() => window.__shotEngine.currentTime > 51, null, { polling: 250 }))
  await listen.waitForTimeout(1500)
  await shot(listen, 'screenshot-lyrics')
  await listen.context().close()

  // The full-screen visualizer over the procedural beat, opened with «D».
  mediaAudio = beat
  const viz = await openPage()
  await viz.goto(origin)
  await within('home', home(viz))
  await viz.evaluate(async album => (await import('/src/browse/navigationStore.ts')).openLibraryAlbum(album), albums[0])
  await within('album', viz.getByRole('heading', { name: names[0][0], exact: true }).waitFor())
  await within('play', viz.getByRole('button', { name: `Play ${names[0][2]}`, exact: true }).click({ force: true }))
  await exposeEngine(viz)
  await within('playing', viz.waitForFunction(() => { const a = window.__shotEngine; return a && a.duration > 100 && !a.paused }, null, { polling: 250 }))
  await viz.mouse.click(720, 30)
  // Motion off, so the rings hold the default tilt instead of turning edge-on mid-shot.
  await viz.evaluate(() => localStorage.setItem('krobi.vizMotion', '0'))
  await viz.keyboard.press('d')
  await within('viz open', viz.locator('canvas').first().waitFor())
  // The rings tilt toward the pointer: rest it at the centre for a face-on view.
  await viz.mouse.move(720, 450)
  // Long enough for the rings to fill and the transport to fold into its disc.
  await viz.waitForTimeout(6000)
  await shot(viz, 'screenshot-visualizer', 'light', { keepMouse: true })
  await viz.context().close()
  mediaAudio = silence

  assert.deepEqual(errors, [])
  assert.deepEqual([...unexpected], [])
  console.log('PASS real app, procedural covers, neutral account; no page errors or unexpected HTTP requests')
} finally {
  await browser?.close()
  await server.close()
}
