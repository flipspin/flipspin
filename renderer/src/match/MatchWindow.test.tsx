import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '../i18n';
import MatchWindow, { MatchHost } from './MatchWindow';
import { closeMatch, openMatch } from './matchStore';
import type { components } from '../api/generated/schema';

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), del: vi.fn(), owner: true, offline: false, notify: vi.fn() }));
vi.mock('../data', () => ({ apiGet: mocks.get, apiPost: mocks.post, apiDelete: mocks.del, useCurrentUser: () => ({ data: { isOwner: mocks.owner } }) }));
vi.mock('../offline/useOffline', () => ({ useOffline: () => mocks.offline }));
vi.mock('../ui/notifications', async importOriginal => ({
  ...await importOriginal<typeof import('../ui/notifications')>(), notify: mocks.notify,
}));
vi.mock('@lib/libraryEvents', () => ({ announceLibraryChanged: vi.fn() }));
const scope = { albumKey: 'Album', title: 'Album' };
const view: components['schemas']['MatchView'] = {
  jobId: 'job', state: 'succeeded', groups: { strong: [0], review: [], rejected: [] }, errors: [],
  candidates: [{ id: 'release', title: 'Album', subtitle: '1979 · 2 tracks', band: 'strong', reasons: ['Same track count', '2 ISRC hits'],
    files: [{ relPath: 'Album/one.mp3', rev: 'rev1', same: 8, fields: { year: { now: 2009, new: 1979 }, mbRecording: { now: null, new: 'recording' } } },
      { relPath: 'Album/two.mp3', rev: 'rev2', same: 9, fields: { title: { now: 'Old', new: 'New' } } }] }],
};
function mount() {
  const client = new QueryClient();
  return render(<QueryClientProvider client={client}><MatchWindow scope={scope} onClose={vi.fn()} /></QueryClientProvider>);
}
beforeEach(async () => {
  await i18n.changeLanguage('en');
  mocks.owner = true; mocks.offline = false;
  mocks.get.mockResolvedValue(structuredClone(view));
  mocks.del.mockResolvedValue({ ...view, state: 'cancelled' });
  mocks.post.mockImplementation(async (path: string) => {
    if (path === '/api/library/match') return { jobId: 'job', progressId: 'job' };
    if (path.endsWith('/plan')) return { planId: 'plan', planHash: 'hash', rows: [] };
    return { editId: 'plan', progressId: 'apply', state: 'partial', applied: 1, skipped: 1, failed: 0 };
  });
});
afterEach(async () => { cleanup(); closeMatch(); vi.clearAllMocks(); await i18n.changeLanguage('es'); });

describe('MusicBrainz match review', () => {
  it('preselects Strong, shows reasons and Now → New, and never applies on opening', async () => {
    mount();
    expect(await screen.findByText('Strong match')).toHaveAttribute('title', 'Same track count · 2 ISRC hits');
    expect(screen.getByRole('button', { name: 'Apply 3 changes' })).toBeEnabled();
    expect(screen.getByRole('status')).toHaveTextContent('3 changes · 2 files');
    expect(screen.getByRole('columnheader', { name: 'Now' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'New' })).toBeInTheDocument();
    expect(screen.getByText('8 other fields')).toBeInTheDocument();
    expect(screen.getAllByRole('checkbox').every(input => (input as HTMLInputElement).checked)).toBe(true);
    expect(mocks.post).toHaveBeenCalledTimes(1);
  });
  it('sends only checked fields per file, applies the saved hash, and exposes Undo with skip counts', async () => {
    mount();
    const checkbox = await screen.findByRole('checkbox', { name: 'Apply Year · Album/one.mp3' });
    fireEvent.click(checkbox);
    fireEvent.click(screen.getByRole('button', { name: 'Apply 2 changes' }));
    await waitFor(() => expect(mocks.notify).toHaveBeenCalled());
    expect(mocks.post).toHaveBeenCalledWith('/api/library/match/{jobId}/plan', {
      params: { path: { jobId: 'job' } }, body: { rows: [
        { relPath: 'Album/one.mp3', candidate: 0, fields: ['mbRecording'] },
        { relPath: 'Album/two.mp3', candidate: 0, fields: ['title'] },
      ] },
    });
    expect(mocks.post).toHaveBeenCalledWith('/api/library/edits/{planId}/apply', { params: { path: { planId: 'plan' } }, body: { planHash: 'hash' } });
    const notification = mocks.notify.mock.calls[0][0];
    expect(notification.message).toBe('1 file updated · 1 skipped');
    expect(notification.action.label).toBe('Undo');
    await act(async () => notification.action.onSelect());
    expect(mocks.post).toHaveBeenCalledWith('/api/library/edits/{editId}/undo', { params: { path: { editId: 'plan' } } });
  });
  it('requires selection for Review and Weak and keeps the library unchanged on dismissal', async () => {
    mocks.get.mockResolvedValue({ ...view, candidates: view.candidates.map(c => ({ ...c, band: 'review' })) });
    mount();
    await screen.findByText('Review');
    expect(screen.getByRole('button', { name: 'Apply 0 changes' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: /Album.*1979/ }));
    expect(screen.getByRole('button', { name: 'Apply 3 changes' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Keep as is' }));
    expect(mocks.post).toHaveBeenCalledTimes(1);
  });
  it('restarts with free text and a MusicBrainz link', async () => {
    mount(); await screen.findByText('Strong match');
    fireEvent.click(screen.getByRole('button', { name: 'Search again' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Search again' }), { target: { value: 'Artist Album' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/api/library/match', { body: { albumKey: 'Album', query: 'Artist Album' } }));
    await screen.findByText('Strong match');
    fireEvent.click(screen.getByRole('button', { name: 'Paste a MusicBrainz link' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Paste a MusicBrainz link' }), { target: { value: 'https://musicbrainz.org/release/abc' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/api/library/match', { body: { albumKey: 'Album', link: 'https://musicbrainz.org/release/abc' } }));
  });
  it('cancels a running lookup and surfaces provider failures with fallback actions', async () => {
    mocks.get.mockResolvedValue({ ...view, state: 'running', candidates: [] });
    mount(); await waitFor(() => expect(mocks.get).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: 'Keep as is' }));
    expect(mocks.del).toHaveBeenCalledWith('/api/library/match/{jobId}', { params: { path: { jobId: 'job' } } });
    cleanup();
    mocks.get.mockResolvedValue({ ...view, state: 'failed', candidates: [], errors: [{ relPath: 'Album/one.mp3', reason: 'provider-busy' }] });
    mount();
    expect(await screen.findByRole('alert')).toHaveTextContent('MusicBrainz is busy');
    expect(screen.getByRole('button', { name: 'Search again' })).toBeEnabled();
  });
  it('offers no match window to members or offline readers', () => {
    const client = new QueryClient();
    mocks.owner = false;
    act(() => openMatch(scope));
    const rendered = render(<QueryClientProvider client={client}><MatchHost /></QueryClientProvider>);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    mocks.owner = true; mocks.offline = true;
    rendered.rerender(<QueryClientProvider client={client}><MatchHost /></QueryClientProvider>);
    expect(mocks.post).not.toHaveBeenCalled();
  });
  it('shows an interrupted write as an error and does not claim success', async () => {
    const original = mocks.post.getMockImplementation()!;
    mocks.post.mockImplementation((path: string, ...args: unknown[]) => path.endsWith('/apply')
      ? Promise.resolve({ editId: 'plan', state: 'interrupted', applied: 0, skipped: 0, failed: 0 })
      : original(path, ...args));
    mount();
    await screen.findByText('Strong match');
    fireEvent.click(screen.getByRole('button', { name: 'Apply 3 changes' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Apply interrupted');
    expect(mocks.notify).not.toHaveBeenCalled();
  });
  it('limits a shared album lookup to the requested song and preserves candidate indices', async () => {
    mocks.get.mockResolvedValue({ ...view, candidates: [
      { ...view.candidates[0], title: 'Unrelated', files: [{ ...view.candidates[0].files[0], relPath: 'Other/song.mp3' }] },
      { ...view.candidates[0], band: 'review' },
    ] });
    render(<QueryClientProvider client={new QueryClient()}><MatchWindow scope={{ relPaths: ['Album/one.mp3'] }} onClose={vi.fn()} /></QueryClientProvider>);
    await screen.findByText('Review');
    expect(screen.queryByText('Unrelated')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Album.*1979/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Apply 2 changes' }));
    await waitFor(() => expect(mocks.notify).toHaveBeenCalled());
    expect(mocks.post).toHaveBeenCalledWith('/api/library/match/{jobId}/plan', {
      params: { path: { jobId: 'job' } }, body: { rows: [{ relPath: 'Album/one.mp3', candidate: 1, fields: ['year', 'mbRecording'] }] },
    });
  });
});
