import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PlaylistHero from './PlaylistHero';
import { describeOwner } from '@lib/playlistAccess';

vi.mock("../acquisition/removeActions", () => ({ useRemoveActions: () => [], withRemoveActions: (items) => items }));

const fixture = vi.hoisted(() => ({
  identity: { status: 'ready', me: { id: 'ana', label: 'Ana', username: 'login', isOwner: true } },
  collection: vi.fn(),
}));
vi.mock('@state/identityStore', () => ({ useIdentity: () => fixture.identity }));
vi.mock('../acquisition/CollectionActions', () => ({ default: (props) => { fixture.collection(props); return <div data-testid="collection-actions" />; } }));
const playlist = { id: 'list', name: 'Konbini_Wars', owner: 'ana', source_url: 'https://open.spotify.com/playlist/list' };
const tracks = [{ title: 'One', path: 'Album/one.mp3', duration: 60 }, { title: 'Two', path: 'Album/two.mp3', metadata: { duration: 120 } }];
const callbacks = () => ({ onPlay: vi.fn(), onToggleShuffle: vi.fn(), onStartRename: vi.fn(), onRefresh: vi.fn(), onDelete: vi.fn(), setRenameValue: vi.fn(), onSubmitRename: vi.fn(), onCancelRename: vi.fn() });

beforeEach(() => {
  fixture.identity = { status: 'ready', me: { id: 'ana', label: 'Ana', username: 'login', isOwner: true } };
  fixture.collection.mockClear();
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ users: [{ id: 'luz', label: 'Luz', username: 'other-login' }] })));
});
afterEach(() => vi.unstubAllGlobals());

describe('playlist account label', () => {
  it('uses identity for our account and the users list for another account', () => {
    expect(describeOwner('ana', fixture.identity.me)).toEqual({ mine: true, label: 'Ana' });
    expect(describeOwner('luz', fixture.identity.me, [{ id: 'luz', label: 'Luz', username: 'login' }])).toEqual({ mine: false, label: 'Luz' });
    expect(describeOwner('missing', fixture.identity.me)).toEqual({ mine: false, label: null });
    expect(describeOwner(null, fixture.identity.me)).toBeNull();
  });
  it('puts the account and unchanged contract facts above the name, without a kicker or search', () => {
    const { container } = render(<PlaylistHero playlist={playlist} tracks={tracks} {...callbacks()} search={<input placeholder="Search sentinel" />} />);
    const facts = container.querySelector('.playlist-band__facts');
    expect(facts).toHaveTextContent('Ana · 2 canciones · 3:00');
    expect(facts.compareDocumentPosition(screen.getByRole('heading', { name: playlist.name })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText('Ana')).toHaveAttribute('title', 'La creaste tú');
    expect(screen.queryByText('Playlist')).toBeNull();
    expect(screen.queryByText('Tuya')).toBeNull();
    expect(screen.queryByPlaceholderText('Search sentinel')).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
    expect(fixture.collection).toHaveBeenCalledWith(expect.objectContaining({ variant: 'icons', kind: 'playlist', tracks }));
  });
  it('resolves another account from users, with its label in the tooltip', async () => {
    render(<PlaylistHero playlist={{ ...playlist, owner: 'luz' }} tracks={tracks} {...callbacks()} />);
    expect(await screen.findByText('Luz')).toHaveAttribute('title', 'La creó Luz');
    expect(screen.queryByText('De otra cuenta')).toBeNull();
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining('/api/users'), expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });
  it('does not reuse another identity’s users list after switching accounts', async () => {
    const props = { playlist: { ...playlist, owner: 'luz' }, tracks, ...callbacks() };
    const { rerender } = render(<PlaylistHero {...props} />);
    await screen.findByText('Luz');
    fixture.identity = { status: 'ready', me: { id: 'member', label: 'Member', username: 'member-login', isOwner: false } };
    rerender(<PlaylistHero {...props} />);
    expect(screen.queryByText('Luz')).toBeNull();
    expect(screen.getByText('Sin acceso')).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('ends the loading state if the account lookup fails', async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error('offline'));
    render(<PlaylistHero playlist={{ ...playlist, owner: 'luz' }} tracks={tracks} {...callbacks()} />);
    await waitFor(() => expect(screen.getByText('No disponible')).toBeInTheDocument());
  });
});

describe('playlist hero verbs', () => {
  it('keeps play/shuffle and the same menu beside the title; rename also works on double click', async () => {
    const actions = callbacks();
    const external = vi.fn();
    vi.stubGlobal('desktopAPI', { openExternal: external });
    window.desktopAPI = { openExternal: external } as unknown as typeof window.desktopAPI;
    const { container } = render(<PlaylistHero playlist={playlist} tracks={tracks} {...actions} shuffleOn />);
    const play = screen.getByRole('button', { name: 'Reproducir' });
    expect(play).toHaveAttribute('title', 'Reproducir');
    expect(play.textContent).toBe('');
    fireEvent.click(play); expect(actions.onPlay).toHaveBeenCalledOnce();
    const shuffle = screen.getByRole('button', { name: 'Aleatorio' });
    expect(shuffle).toHaveAttribute('aria-pressed', 'true');
    expect(shuffle).toHaveAttribute('title', 'Desactivar aleatorio');
    fireEvent.click(shuffle); expect(actions.onToggleShuffle).toHaveBeenCalledOnce();
    fireEvent.doubleClick(screen.getByRole('heading')); expect(actions.onStartRename).toHaveBeenCalledOnce();
    const more = screen.getByRole('button', { name: 'Más opciones' });
    expect(container.querySelector('.playlist-band__title-row')).toContainElement(more);
    expect(container.querySelector('.playlist-actions')).not.toContainElement(more);
    expect(screen.queryByRole('button', { name: 'Renombrar playlist' })).toBeNull();
    fireEvent.click(more);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Renombrar playlist' }));
    expect(actions.onStartRename).toHaveBeenCalledTimes(2);
    fireEvent.click(more);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Abrir en Spotify' }));
    expect(external).toHaveBeenCalledWith(playlist.source_url);
    fireEvent.click(more);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Actualizar desde el link' }));
    expect(actions.onRefresh).toHaveBeenCalledOnce();
    fireEvent.click(more);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Eliminar playlist' }));
    expect(actions.onDelete).toHaveBeenCalledOnce();
  });
  it('keeps empty-list play disabled and rename submit/cancel behavior', () => {
    const submit = vi.fn(), cancel = vi.fn(), change = vi.fn();
    render(<PlaylistHero playlist={playlist} {...callbacks()} renaming renameValue="New" setRenameValue={change} onSubmitRename={submit} onCancelRename={cancel} />);
    expect(screen.getByRole('button', { name: 'Reproducir' })).toBeDisabled();
    const input = screen.getByRole('textbox', { name: 'Renombrar playlist' });
    fireEvent.change(input, { target: { value: 'Changed' } }); expect(change).toHaveBeenCalledWith('Changed');
    fireEvent.keyDown(input, { key: 'Enter' }); expect(submit).toHaveBeenCalledOnce();
    fireEvent.keyDown(input, { key: 'Escape' }); expect(cancel).toHaveBeenCalledOnce();
  });
});
