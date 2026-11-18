import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import i18n from '../i18n';
import { DataProvider, queryKeys } from '../data';
import { installFakeBackend, type FakeBackend, type ResponseSpec } from '../data/test-support';
import LyricsVoiceToggle from './LyricsVoiceToggle';
import { stemPlayer } from './StemPlayer';
import type { StemEngine } from './stemEngine';

let engine: StemEngine;
const onOpenAddons = vi.fn();
const track = { album: 'Album', file: 'Song.mp3', duration: 190 };
const path = '/api/stems/Album/Song.mp3';
const manifest = { track: { duration: 190 }, stems: { drums: `${path}/drums`, bass: `${path}/bass`, other: `${path}/other`, vocals: `${path}/vocals` } };
const pending = (status: string, extra = {}) => ({ status, phase: 'separating', progress: 42, agent: { online: true }, ...extra });
let response: ResponseSpec;
let requestResponse: ResponseSpec;
let backend: FakeBackend;
let client: QueryClient;
const requests = () => backend.countFor('/api/stems/request');
function Wrapper({ children }: { children: React.ReactNode }) { return <DataProvider queryClient={client}>{children}</DataProvider>; }
const show = () => render(<LyricsVoiceToggle engine={engine} onOpenAddons={onOpenAddons} track={track} />, { wrapper: Wrapper });
const refresh = async () => { await act(() => client.invalidateQueries({ queryKey: queryKeys.stems.all })); };
const karaoke = () => screen.getByRole('radio', { name: 'Karaoke' });
const open = async (name = 'Karaoke') => {
  await waitFor(() => expect(backend.countFor(path)).toBeGreaterThan(0));
  await userEvent.click(screen.getByRole('radio', { name }));
  return screen.findByRole('dialog', { name: "This song isn't split yet" });
};
beforeEach(async () => {
  await i18n.changeLanguage('en');
  engine = { available: true, machine: 'Studio', backend: 'MLX', estimate: 20 };
  onOpenAddons.mockReset();
  response = { status: 404 };
  requestResponse = { status: 200, json: { status: 'queued' } };
  backend = installFakeBackend({ respond: r => {
    if (r.pathname === '/api/stems') return { status: 200, json: { splits: [] } };
    if (r.pathname === '/api/stems/request') return requestResponse;
    if (r.pathname === path && r.method === 'DELETE') { response = { status: 404 }; return { status: 200, json: { success: true, removed: true } }; }
    if (r.pathname === path) return response;
    if (r.pathname === '/api/stems/Other/Other.mp3') return { status: 200, json: manifest };
  } });
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
});
afterEach(async () => {
  client.clear(); backend.restore(); vi.restoreAllMocks(); stemPlayer.reset(); await Promise.resolve(); stemPlayer.detach();
  await i18n.changeLanguage('es');
});

it('always shows the three options with Original checked for an unsplit song, even with a previous mix', async () => {
  act(() => stemPlayer.setPreset('vocals20'));
  show();
  expect(screen.getByRole('radiogroup', { name: 'Vocals' })).toBeVisible();
  expect(screen.getAllByRole('radio').map(r => r.textContent)).toEqual(['Original', 'Karaoke', 'Voice 20 %']);
  expect(screen.getByRole('radio', { name: 'Original' })).toBeChecked();
  expect(screen.queryByText('Not split')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Karaoke' })).toBeNull();
  await waitFor(() => expect(backend.countFor(path)).toBeGreaterThan(0));
  expect(requests()).toBe(0);
});

it.each(['Karaoke', 'Voice 20 %'])('asks before splitting for %s, then applies that exact preset when ready', async name => {
  show(); await open(name);
  expect(screen.getByText('Studio · MLX · ≈ 20 s')).toBeVisible();
  expect(screen.getByRole('radio', { name: 'Original' })).toBeChecked();
  expect(stemPlayer.getSnapshot().mix.levels.vocals).toBe(100);
  expect(requests()).toBe(0);
  response = { status: 202, json: pending('running') };
  await userEvent.click(screen.getByRole('button', { name: name === 'Karaoke' ? 'Split and play karaoke' : 'Split and play with voice 20 %' }));
  await waitFor(() => expect(requests()).toBe(1));
  await screen.findByText('Splitting · 42 %');
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.getByRole('progressbar', { name: 'Splitting' })).toHaveAttribute('aria-valuenow', '42');
  expect(screen.getByRole('radio', { name: 'Original' })).toBeChecked();
  response = { status: 200, json: manifest }; await refresh();
  await waitFor(() => expect(screen.getByRole('radio', { name })).toBeChecked());
  expect(stemPlayer.getSnapshot().mix.levels.vocals).toBe(name === 'Karaoke' ? 0 : 20);
});

it('cancels from the progress option and never auto-applies the cancelled intent', async () => {
  show(); await open(); response = { status: 202, json: pending('running') };
  await userEvent.click(screen.getByRole('button', { name: 'Split and play karaoke' }));
  await screen.findByText('Splitting · 42 %');
  await userEvent.click(screen.getByRole('button', { name: 'Cancel split' }));
  await waitFor(() => expect(screen.queryByRole('progressbar')).toBeNull());
  expect(backend.requests.filter(r => r.method === 'DELETE')).toHaveLength(1);
  response = { status: 200, json: manifest }; await refresh();
  expect(screen.getByRole('radio', { name: 'Original' })).toBeChecked();
});

it('keeps retry inside the chosen option with the failure reason in its title', async () => {
  show(); await open('Voice 20 %'); response = { status: 202, json: pending('failed', { error: 'helper disconnected' }) };
  await userEvent.click(screen.getByRole('button', { name: 'Split and play with voice 20 %' }));
  await screen.findByText('Try again');
  expect(screen.getByRole('radio', { name: 'Voice 20 %' })).toHaveAttribute('title', 'helper disconnected');
  await userEvent.click(screen.getByRole('radio', { name: 'Voice 20 %' }));
  expect(requests()).toBe(1);
  response = { status: 202, json: pending('running') };
  await userEvent.click(screen.getByRole('button', { name: 'Split and play with voice 20 %' }));
  await waitFor(() => expect(requests()).toBe(2));
});

it('shows Try again when the request itself fails', async () => {
  requestResponse = { status: 503, json: { detail: 'unavailable' } };
  show(); await open();
  await userEvent.click(screen.getByRole('button', { name: 'Split and play karaoke' }));
  await screen.findByText('Try again');
  expect(karaoke().getAttribute('title')).toBeTruthy();
  expect(screen.getByRole('radio', { name: 'Original' })).toBeChecked();
});

it('opens Engines with the approved pill and title when no Stems helper is available', async () => {
  engine = { available: false, estimate: null };
  show(); await open();
  const action = screen.getByRole('button', { name: 'Split and play karaoke Add-on' });
  expect(action).toHaveAttribute('title', 'Needs the Stems add-on · opens Settings → Engines');
  await userEvent.click(action);
  expect(onOpenAddons).toHaveBeenCalledOnce();
  expect(requests()).toBe(0);
});

it('shows the supplied machine, backend and estimate', async () => {
  engine = { available: true, machine: 'Separation', backend: 'MLX', estimate: 19 };
  show(); await open();
  expect(screen.getByText('Separation · MLX · ≈ 19 s')).toBeVisible();
});

it('offers splitting when the supplied engine is available', async () => {
  engine = { available: true, machine: 'Nest', estimate: null };
  show(); await open();
  expect(screen.getByRole('button', { name: 'Split and play karaoke' })).toBeEnabled();
  expect(screen.queryByText('Add-on')).toBeNull();
});

it('closes on Escape or an outside press without requesting a split', async () => {
  show(); await open();
  fireEvent.keyDown(document, { key: 'Escape' });
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(requests()).toBe(0);
  await open();
  fireEvent.pointerDown(document.body);
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(requests()).toBe(0);
});

it('keeps arrows/Home/End on the radios, and confirms with Enter on the panel button', async () => {
  show(); const original = screen.getByRole('radio', { name: 'Original' }); original.focus();
  await userEvent.keyboard('{ArrowRight}');
  expect(karaoke()).toHaveFocus();
  expect(original).toBeChecked();
  expect(requests()).toBe(0);
  await userEvent.keyboard('{End}');
  expect(screen.getByRole('radio', { name: 'Voice 20 %' })).toHaveFocus();
  await userEvent.keyboard('{Home}');
  expect(original).toHaveFocus();
  expect(screen.queryByRole('dialog')).toBeNull();
  await userEvent.keyboard('{ArrowLeft}{Tab}');
  expect(screen.getByRole('button', { name: 'Split and play with voice 20 %' })).toHaveFocus();
  response = { status: 202, json: pending('running') };
  await userEvent.keyboard('{Enter}');
  await waitFor(() => expect(requests()).toBe(1));
});

it('returns focus to the option on Escape from the panel button', async () => {
  show(); await open(); karaoke().focus();
  await userEvent.keyboard('{Tab}');
  expect(screen.getByRole('button', { name: 'Split and play karaoke' })).toHaveFocus();
  await userEvent.keyboard('{Escape}');
  expect(karaoke()).toHaveFocus();
  expect(requests()).toBe(0);
});

it('selects exact presets on ready songs and hides the thumb for a manual mix', async () => {
  response = { status: 200, json: manifest }; show();
  await waitFor(() => expect(karaoke()).not.toHaveAttribute('aria-haspopup'));
  for (const [name, level] of [['Original', 100], ['Karaoke', 0], ['Voice 20 %', 20]] as const) {
    await userEvent.click(screen.getByRole('radio', { name }));
    expect(screen.getByRole('radio', { name })).toBeChecked();
    expect(stemPlayer.getSnapshot().mix.levels.vocals).toBe(level);
  }
  act(() => stemPlayer.setLevel('bass', 45));
  expect(screen.getByRole('radiogroup')).toHaveClass('is-none');
  expect(screen.getAllByRole('radio').every(r => r.getAttribute('aria-checked') === 'false')).toBe(true);
  expect(requests()).toBe(0);
});

it('clears confirmation and confirmed intent on song changes, including returning to the old song', async () => {
  const view = show(); await open();
  view.rerender(<LyricsVoiceToggle engine={engine} onOpenAddons={onOpenAddons} track={{ album: 'Other', file: 'Other.mp3' }} />);
  expect(screen.queryByRole('dialog')).toBeNull();
  view.rerender(<LyricsVoiceToggle engine={engine} onOpenAddons={onOpenAddons} track={track} />); await open();
  response = { status: 202, json: pending('running') };
  await userEvent.click(screen.getByRole('button', { name: 'Split and play karaoke' }));
  await screen.findByText('Splitting · 42 %');
  view.rerender(<LyricsVoiceToggle engine={engine} onOpenAddons={onOpenAddons} track={{ album: 'Other', file: 'Other.mp3' }} />);
  response = { status: 200, json: manifest }; await refresh();
  view.rerender(<LyricsVoiceToggle engine={engine} onOpenAddons={onOpenAddons} track={track} />); await refresh();
  expect(stemPlayer.getSnapshot().mix.levels.vocals).toBe(100);
});
