import { fireEvent, render } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import type { ComponentType } from 'react';
import { DataProvider } from '../data';
import { installFakeBackend } from '../data/test-support';
import { OfflineLibraryProvider } from '../offline/OfflineLibrary';
import UntypedRow from './AlbumTrackRow';

const Row = UntypedRow as unknown as ComponentType<Record<string, unknown>>;
it('keeps an unplayable ghost with its missing label and path tooltip', () => {
  const backend = installFakeBackend({ respond: () => ({ status: 200, json: {} }) });
  try {
    const onPlay = vi.fn();
    const view = render(<DataProvider><OfflineLibraryProvider albums={[]}><ul><Row index={0}
      track={{ title: 'Missing Song', relPath: 'Album/song.mp3', path: '/music/Album/song.mp3', missingFromNest: true, missingSince: '2026-11-12' }} onPlay={onPlay} /></ul></OfflineLibraryProvider></DataProvider>);
    const ghost = view.container.querySelector('li')!;
    expect(ghost).toHaveClass('is-missing');
    expect(ghost).toHaveAttribute('aria-disabled', 'true');
    expect(ghost).toHaveAttribute('title', 'File not found since 2026-11-12 · Album/song.mp3');
    expect(view.getByText('missing')).toBeVisible();
    expect(view.getByRole('button', { name: /Reproducir Missing Song/ })).toBeDisabled();
    fireEvent.doubleClick(ghost);
    expect(onPlay).not.toHaveBeenCalled();
    view.unmount();
  } finally { backend.restore(); }
});
it('skips unchanged parent props and still refreshes selection, metadata and handlers', () => {
  const backend = installFakeBackend({ respond: () => ({ status: 200, json: {} }) });
  try {
    const highlight = vi.fn(text => text);
    const track = { relPath: 'Album/song.mp3', title: 'Song', album: 'Album', artist: 'Artist', duration: 200 };
    const props = { track, index: 0, searchQuery: 'Song', highlightMatches: highlight, onSelect: vi.fn(), onPlay: vi.fn() };
    const tree = (extra = {}) => <DataProvider><OfflineLibraryProvider albums={[]}><ul><Row {...props} {...extra} /></ul></OfflineLibraryProvider></DataProvider>;
    const view = render(tree());
    const initialCalls = highlight.mock.calls.length;
    view.rerender(tree());
    expect(highlight).toHaveBeenCalledTimes(initialCalls);
    view.rerender(tree({ selected: true }));
    expect(view.container.querySelector('li')).toHaveAttribute('aria-selected', 'true');
    view.rerender(tree({ track: { ...track, title: 'New title' } }));
    expect(view.getByText('New title')).toBeInTheDocument();
    const onSelect = vi.fn();
    view.rerender(tree({ onSelect }));
    view.container.querySelector('li')!.click();
    expect(onSelect).toHaveBeenCalledWith(track, expect.anything());
    view.unmount();
  } finally { backend.restore(); }
});

it('replaces the cover immediately when a recycled slot gets a new album or revision', () => {
  const backend = installFakeBackend({ respond: () => ({ status: 200, json: {} }) });
  try {
    const tree = (dir: string, version: string, index = 0) => <DataProvider><OfflineLibraryProvider albums={[]}><ul>
      <Row key={index % 256} index={index} track={{ path: `/m/${dir}/song.mp3`, title: 'Song' }}
        album={{ mediaKey: dir, album: dir, coverVersion: version }} showCovers isActive onPlay={vi.fn()} />
    </ul></OfflineLibraryProvider></DataProvider>;
    const view = render(tree('First', 'one'));
    const row = view.container.querySelector('li');
    const first = view.container.querySelector('img')!;
    expect(first).toHaveAttribute('src', expect.stringContaining('/First/cover.jpg?size=96&v=one'));
    expect(first).toHaveAttribute('loading', 'lazy');
    expect(first).toHaveAttribute('decoding', 'async');
    expect(view.container.querySelector('.song-row__sub')?.textContent).toBe('\u00a0');
    view.rerender(tree('Second', 'two', 256));
    expect(view.container.querySelector('li')).toBe(row);
    const second = view.container.querySelector('img')!;
    expect(second).not.toBe(first);
    expect(second).toHaveAttribute('src', expect.stringContaining('/Second/cover.jpg?size=96&v=two'));
    expect(view.container.innerHTML).not.toContain('/First/cover.jpg');
    fireEvent.error(second);
    expect(view.container.querySelector('img')).toBeNull();
    expect(view.container.querySelector('.song-row__cover')?.textContent).toBe('SE');
    view.rerender(tree('Second', 'three', 512));
    expect(view.container.querySelector('img')).toHaveAttribute('src', expect.stringContaining('&v=three'));
    view.unmount();
  } finally { backend.restore(); }
});
