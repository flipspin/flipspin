import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import FixedBottomPlayerBar from '../player/FixedBottomPlayerBar';
const state = vi.hoisted(() => ({ covered: false }));
vi.mock('@state/AudioPlayerContext', () => ({ useAudioPlayer: () => ({ audioRef: { current: null }, selectedTrack: null, nowPlaying: { path: '/music/Album/song.mp3' } }) }));
vi.mock('../viz/RealTimeWaveform', () => ({ default: () => <div data-testid="wave" /> }));
vi.mock('../player/PlayerTransport', () => ({ default: ({ onToggleStems, stemsOpen }) => <button onClick={onToggleStems} aria-pressed={stemsOpen} data-testid="stems-button">Stems</button> }));
vi.mock('../lyrics/lyricsStore', () => ({ useLyricsOverlayRelPath: () => state.covered ? 'Album/song.mp3' : null }));
vi.mock('../viz/vizStore', () => ({ useVizOpen: () => false }));
vi.mock('./StemsPage', () => ({ default: ({ visible }) => <div data-testid="stems-page" data-visible={visible} /> }));
beforeEach(() => { localStorage.clear(); state.covered = false; });
describe('drawer pager and transport button', () => {
  it('keeps Waveform as the default and persists a keyboard-selected page', () => {
    const view = render(<FixedBottomPlayerBar />);
    expect(screen.getByTestId('wave')).toBeInTheDocument();
    expect(screen.getAllByRole('tab').map(tab => tab.getAttribute('aria-label'))).toEqual(['Onda', 'Stems', 'Jog']);
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Onda' }), { key: 'ArrowDown' });
    expect(screen.getByRole('tab', { name: 'Stems' })).toHaveAttribute('aria-selected', 'true');
    expect(localStorage.getItem('krobi.bottomBarDrawerPage')).toBe('Stems');
    view.unmount(); render(<FixedBottomPlayerBar />); expect(screen.getByTestId('stems-page')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Jog' })); expect(screen.getByText('Próximamente')).toBeInTheDocument();
  });
  it('opens Stems from any page, toggles closed only on Stems, and persists open state', () => {
    render(<FixedBottomPlayerBar />);
    fireEvent.click(screen.getByTestId('stems-button')); expect(screen.getByTestId('stems-page')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('stems-button')); expect(screen.queryByRole('tablist')).toBeNull(); expect(localStorage.getItem('krobi.bottomBarDrawerOpen')).toBe('0');
    fireEvent.click(screen.getByTestId('stems-button')); expect(screen.getByTestId('stems-page')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Onda' })); fireEvent.click(screen.getByTestId('stems-button')); expect(screen.getByTestId('stems-page')).toBeInTheDocument();
  });
  it('suspends the Stems page while lyrics cover it', () => {
    localStorage.setItem('krobi.bottomBarDrawerPage', 'Stems'); state.covered = true;
    render(<FixedBottomPlayerBar />); expect(screen.getByTestId('stems-page')).toHaveAttribute('data-visible', 'false');
  });
});

it.each([
  ['Onda', 'Onda', 'wave'], ['Stems', 'Stems', 'stems-page'], ['Jog', 'Jog', null],
])('reads the existing saved drawer value %s', (saved, label, testId) => {
  localStorage.setItem('krobi.bottomBarDrawerPage', saved);
  render(<FixedBottomPlayerBar />);
  expect(screen.getByRole('tab', { name: label })).toHaveAttribute('aria-selected', 'true');
  if (testId) expect(screen.getByTestId(testId)).toBeInTheDocument();
  expect(localStorage.getItem('krobi.bottomBarDrawerPage')).toBe(saved);
});
