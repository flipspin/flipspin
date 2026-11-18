import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StemPlayer, DECODED_BUDGET } from './StemPlayer';
import { originalMix, STEMS, loadMix } from './mix';
import type { Manifest } from './stemApi';
import type { StemSource } from '../player/engine/PlaybackPort';
import { deferred, fakeBuffer, FakeContext, flush } from './fakeAudio';
const a = { album: 'a', file: 'one.mp3' }, b = { album: 'b', file: 'two.mp3' };
const manifest = (duration = 180): Manifest => ({ track: { duration }, stems: Object.fromEntries(STEMS.map(stem => [stem, `/api/stems/a/f/${stem}`])) as Manifest['stems'] });
const players: StemPlayer[] = [];
function setup() {
  const ctx = new FakeContext();
  class Host extends EventTarget {
    currentTime = 42; paused = false;
    setStemSource = vi.fn((_source: StemSource | null, _reason?: string) => {});
    setStemLevels = vi.fn();
  }
  const host = new Host();
  const deps = { graph: () => ctx.graph(), host, probe: vi.fn(async () => new ArrayBuffer(1)),
    manifest: vi.fn(async () => manifest()), fetch: vi.fn(async (_manifest: Manifest, _signal: AbortSignal) => STEMS.map(() => new ArrayBuffer(4))) };
  const player = new StemPlayer(deps, originalMix()); players.push(player);
  player.setCarryMix(true); player.setTrack(a);
  const start = async () => { await player.activate(); player.setPreset('karaoke'); await flush(); };
  return { player, deps, ctx, host, start };
}
beforeEach(() => localStorage.clear());
afterEach(() => { players.splice(0).forEach(player => player.detach()); vi.restoreAllMocks(); });
describe('stems are a budgeted source of the single engine', () => {
  it('switches original/stems at the engine position, preserving pause and mix/faders', async () => {
    const { player, host, start, ctx } = setup(); await start();
    expect(player.getSnapshot().state).toBe('stems');
    expect(host.currentTime).toBe(42); expect(host.paused).toBe(false);
    expect(ctx.sources).toHaveLength(0);
    const source = host.setStemSource.mock.calls.find(call => call[0])![0]!;
    expect(source.levels).toEqual([1, 1, 1, 0]);
    player.setLevel('bass', 35); player.toggleMute('other'); player.toggleSolo('bass');
    expect(host.setStemLevels).toHaveBeenLastCalledWith([0, .35, 0, 0]);
    const saves = vi.spyOn(localStorage, 'setItem');
    player.previewLevel('bass', 45); expect(saves).not.toHaveBeenCalled();
    host.currentTime = 66; host.paused = true; player.reset();
    expect(host.setStemSource).toHaveBeenLastCalledWith(null, 'original');
    expect(host.currentTime).toBe(66); expect(host.paused).toBe(true);
    expect(player.getSnapshot().mix).toEqual(originalMix());
  });
  it('original loads no stems; mix carries only while karaoke is open', async () => {
    const { player, deps, start } = setup(); await player.activate();
    expect(deps.manifest).not.toHaveBeenCalled(); await start();
    const mix = player.getSnapshot().mix; player.setTrack(b); await flush();
    expect(player.getSnapshot()).toMatchObject({ state: 'stems', mix });
    player.setCarryMix(false); player.setTrack(a); await flush();
    expect(player.getSnapshot().state).toBe('original'); expect(loadMix()).toEqual(originalMix());
  });
  it('a decode/fetch failure releases the source at the same position and keeps the mix retryable', async () => {
    const { player, deps, host, start } = setup(); await start();
    deps.fetch.mockRejectedValueOnce(new Error('stem: HTTP 404'));
    player.retry(); await flush();
    expect(player.getSnapshot()).toMatchObject({ state: 'error', reason: 'stem: HTTP 404' });
    expect(host.currentTime).toBe(42); expect(player.getSnapshot().mix.levels.vocals).toBe(0);
    player.retry(); await flush(); expect(player.active).toBe(true);
  });
  it('drains non-abortable sibling decodes before decoding a newer song', async () => {
    const { player, ctx, deps } = setup(); await player.activate();
    const pending = deferred<AudioBuffer>(); ctx.decodeAudioData.mockReturnValue(pending.promise);
    player.setPreset('karaoke'); await flush();
    const signal = deps.fetch.mock.calls[0][1]; player.setTrack(b); await flush();
    expect(signal.aborted).toBe(true); expect(ctx.decodeAudioData).toHaveBeenCalledTimes(5);
    ctx.decodeAudioData.mockResolvedValue(fakeBuffer()); pending.resolve(fakeBuffer()); await flush();
    expect(ctx.decodeAudioData).toHaveBeenCalledTimes(9); expect(player.active).toBe(true);
  });
  it('caps combined current/lookahead decoded bytes at 600 MB and cancels queue changes', async () => {
    const { player, ctx, deps, host, start } = setup(); await start();
    player.setNext(b); await flush(); const signal = deps.fetch.mock.calls[1][1];
    host.currentTime = 155; player.tick(); await flush();
    expect(ctx.decodeAudioData).toHaveBeenCalledTimes(9);
    player.setNext(null); expect(signal.aborted).toBe(true);
    expect(180 * ctx.sampleRate * 2 * 4 * 4 * 2).toBeLessThan(DECODED_BUDGET);
    ctx.sampleRate = 96000; player.setNext(b); await flush(); player.tick(); await flush();
    expect(ctx.decodeAudioData).toHaveBeenCalledTimes(9);
  });
  it('codec and long-song limits retain original playback; lookahead errors cannot interrupt it', async () => {
    const { player, deps, host, start } = setup(); await start();
    deps.fetch.mockRejectedValueOnce(new Error('next missing')); player.setNext(b); await flush();
    host.currentTime = 155; player.tick(); await flush(); expect(player.active).toBe(true);
    player.setTrack({ ...b, duration: 481 }); await flush();
    expect(player.getSnapshot()).toMatchObject({ state: 'unsupported', reason: 'too-long' });
    expect(host.currentTime).toBe(155);
  });
  it('restarts a repeated queue entry on the same source host with the carried mix', async () => {
    const { player, host, start } = setup(); await start();
    const mix = player.getSnapshot().mix;
    player.setTrack(a, true); host.currentTime = 0; await flush();
    expect(player.getSnapshot()).toMatchObject({ state: 'stems', mix });
    expect(host.currentTime).toBe(0);
    expect(host.setStemSource.mock.calls.filter(call => call[0] !== null)).toHaveLength(2);
  });
  it('refresh ignores a skipped song and rechecks newly ready/deleted stems', async () => {
    const { player, deps, start } = setup(); deps.manifest.mockResolvedValueOnce(null); await start();
    expect(player.getSnapshot().reason).toBe('not-ready');
    player.refresh(a); await flush(); expect(player.active).toBe(true);
    const count = deps.manifest.mock.calls.length; player.refresh(b); player.refresh(a); await flush();
    expect(deps.manifest).toHaveBeenCalledTimes(count);
    deps.manifest.mockResolvedValueOnce(null); player.refresh(a, true); await flush();
    expect(player.getSnapshot()).toMatchObject({ state: 'original', reason: 'not-ready' });
  });
});
