import { afterEach, describe, expect, it, vi } from 'vitest'

const priorDesktopApi = Object.getOwnPropertyDescriptor(window, 'desktopAPI')

afterEach(() => {
  if (priorDesktopApi) Object.defineProperty(window, 'desktopAPI', priorDesktopApi)
  else Reflect.deleteProperty(window, 'desktopAPI')
  vi.resetModules()
})

describe.each(['krobi-media://localhost', 'http://krobi-media.localhost'])(
  'stem audio through %s',
  (mediaProxyUrl) => {
    it.each(['drums', 'bass', 'vocals', 'other'])(
      'rewrites %s under the backend prefix and removes query credentials',
      async (stem) => {
        vi.resetModules()
        Object.defineProperty(window, 'desktopAPI', {
          configurable: true,
          value: {
            backendUrl: 'https://music.example/krobi',
            mediaProxyUrl,
            backendToken: 'current-token',
          },
        })
        const { withMediaAccess } = await import('@lib/api')
        const path = `/api/stems/An%20Album/Song%20%231.mp3/${stem}`
        const result = withMediaAccess(
          `https://music.example/krobi${path}?access_token=stale-token&quality=original`,
        )

        expect(result).toBe(`${mediaProxyUrl}${path}?quality=original`)
        expect(result).not.toContain('token')
        expect(withMediaAccess(result)).toBe(result)
      },
    )
  },
)

describe.each(['krobi-media://localhost', 'http://krobi-media.localhost'])(
  'album thumbnails through %s',
  (mediaProxyUrl) => {
    it('preserves the size and album revision through native media access', async () => {
      vi.resetModules()
      Object.defineProperty(window, 'desktopAPI', {
        configurable: true,
        value: { backendUrl: 'https://music.example/krobi', mediaProxyUrl, backendToken: 'secret' },
      })
      const { buildAlbumThumbUrl } = await import('@lib/api')
      expect(buildAlbumThumbUrl('Artist∕Album #1', 'mtime/size & new', 96)).toBe(
        `${mediaProxyUrl}/api/media/Artist%E2%88%95Album%20%231/cover.jpg?size=96&v=mtime%2Fsize+%26+new`,
      )
      expect(buildAlbumThumbUrl('Album', null)).toBe(`${mediaProxyUrl}/api/media/Album/cover.jpg?size=96&v=`)
      expect(buildAlbumThumbUrl(null, 'revision')).toBeNull()
    })
  },
)
