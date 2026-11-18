import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { LibraryProvider, useLibrary } from './LibraryContext'

const nest = vi.hoisted(() => ({ remote: false, localFolder: '/home/music/chosen', remoteFolder: '/srv/music', posts: [] as string[] }))
vi.mock('@lib/api', () => ({
  get IS_REMOTE_BACKEND() { return nest.remote },
  apiUrl: (path: string) => path,
  backendRequest: vi.fn(async (_path: string, options?: { body: string }) => {
    if (options?.body) {
      const { basedir } = JSON.parse(options.body)
      nest.posts.push(basedir)
      nest.localFolder = basedir
    }
    return { ok: true, body: JSON.stringify({ basedir: nest.remote ? nest.remoteFolder : nest.localFolder }) }
  }),
}))

function Folder() {
  const { baseDir, setBaseDir } = useLibrary()
  return <><output>{baseDir}</output><button onClick={() => setBaseDir('/client/picked')}>Choose</button></>
}
const mount = () => render(<LibraryProvider><Folder /></LibraryProvider>)

beforeEach(() => {
  nest.remote = false
  nest.localFolder = '/home/music/chosen'
  nest.posts = []
  localStorage.setItem('baseDir', '/stale/other-nest')
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    const { basedir } = JSON.parse(init.body)
    nest.posts.push(basedir)
    nest.localFolder = basedir
    return Response.json({ success: true })
  }))
})

afterEach(() => vi.unstubAllGlobals())

it('adopts each server folder across local → remote → local without posting cached paths', async () => {
  let view = mount()
  await screen.findByText(nest.localFolder)
  view.unmount()
  nest.remote = true
  view = mount()
  await screen.findByText(nest.remoteFolder)
  fireEvent.click(screen.getByRole('button', { name: 'Choose' }))
  await screen.findByText('/client/picked')
  expect(localStorage.getItem('baseDir')).toBe(nest.localFolder)
  expect(nest.posts).toEqual([])
  view.unmount()
  nest.remote = false
  // Even a poisoned legacy cache cannot replace the local nest's memory.
  localStorage.setItem('baseDir', nest.remoteFolder)
  view = mount()
  await screen.findByText(nest.localFolder)
  expect(nest.posts).toEqual([])
  view.unmount()
})

it('posts an explicit local folder choice once', async () => {
  mount()
  await screen.findByText(nest.localFolder)
  fireEvent.click(screen.getByRole('button', { name: 'Choose' }))
  await waitFor(() => expect(nest.posts).toEqual(['/client/picked']))
})
