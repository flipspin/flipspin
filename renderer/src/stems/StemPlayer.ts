import { getAudioGraph, type AudioGraph } from './audioGraph';
import { playbackEngine } from '../player/engine/PlaybackEngine';
import type { StemSource } from '../player/engine/PlaybackPort';
import { effectiveGain, isOriginal, loadMix, originalMix, saveMix, STEMS, type Mix, type Stem } from './mix';
import { fetchStems, getManifest, probeBytes, trackKey, type Manifest, type StemTrack } from './stemApi';

export interface StemStatus {
  state: 'original' | 'loading' | 'stems' | 'unsupported' | 'error';
  reason?: string;
  mix: Mix;
}
interface SourceHost {
  readonly currentTime: number;
  readonly paused: boolean;
  setStemSource(source: StemSource | null, reason?: string): void;
  setStemLevels(levels: number[]): void;
  addEventListener(type: string, listener: EventListener): void;
  removeEventListener(type: string, listener: EventListener): void;
}
interface Dependencies {
  graph: () => AudioGraph;
  host: SourceHost;
  manifest: typeof getManifest;
  fetch: typeof fetchStems;
  probe: typeof probeBytes;
}
interface Prefetch {
  track: StemTrack; controller: AbortController;
  data: Promise<{ manifest: Manifest; bytes: ArrayBuffer[] } | null>;
  buffers?: AudioBuffer[]; decoding: boolean;
}
export const DECODED_BUDGET = 600_000_000;
const LOAD_TIMEOUT_MS = 20_000;
const defaults: Dependencies = { graph: getAudioGraph, host: playbackEngine, manifest: getManifest, fetch: fetchStems, probe: probeBytes };

/** Budgeted stem source and mix controls. The engine owns all transport/output. */
export class StemPlayer {
  private status: StemStatus;
  private listeners = new Set<() => void>();
  private track?: StemTrack;
  private next?: StemTrack;
  private graph?: AudioGraph;
  private buffers?: AudioBuffer[];
  private controller?: AbortController;
  private prefetch?: Prefetch;
  private generation = 0;
  private decodeTail: Promise<unknown> = Promise.resolve();
  private probeResult?: Promise<boolean>;
  private activated = false;
  private codecUnsupported = false;
  private carryMix = false;
  private listening = false;
  constructor(private deps: Dependencies = defaults, mix: Mix = loadMix()) { this.status = { state: 'original', mix }; }
  getSnapshot = (): StemStatus => this.status;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  get active() { return this.status.state === 'stems'; }
  setCarryMix = (on: boolean) => { this.carryMix = on; };
  private publish(state: StemStatus['state'], reason?: string) {
    this.status = { state, reason, mix: this.status.mix };
    this.listeners.forEach(listener => listener());
  }
  activate = async () => {
    this.activated = true;
    try {
      this.graph = this.deps.graph();
      this.probeResult ??= this.deps.probe().then(bytes => this.graph!.context.decodeAudioData(bytes)).then(() => true, () => false);
      if (!await this.probeResult) { this.codecUnsupported = true; this.publish('unsupported', 'codec'); return; }
      if (!this.listening) { this.listening = true; this.deps.host.addEventListener('timeupdate', this.tick); }
      this.setNext(this.next || null);
      if (this.track && !isOriginal(this.status.mix) && !this.active && this.status.state !== 'loading') void this.load();
    } catch (error) { this.fail(error); }
  };
  setTrack(track: StemTrack | null, restart = false) {
    if (!restart && (track ? this.track && trackKey(track) === trackKey(this.track) : !this.track)) return;
    this.cancelLoad();
    const changing = !!this.track;
    this.release('track-selection');
    if (changing && track && !this.carryMix) { this.status = { ...this.status, mix: originalMix() }; saveMix(this.status.mix); }
    this.track = track || undefined;
    this.publish(this.codecUnsupported ? 'unsupported' : 'original', this.codecUnsupported ? 'codec' : undefined);
    if (track && this.activated && !isOriginal(this.status.mix)) void this.load();
  }
  setLevel = (stem: Stem, level: number) => {
    if (Number.isFinite(level)) this.updateMix({ ...this.status.mix, levels: { ...this.status.mix.levels, [stem]: Math.max(0, Math.min(200, level)) } });
  };
  previewLevel = (stem: Stem, level: number) => {
    if (!Number.isFinite(level)) return;
    const mix = { ...this.status.mix, levels: { ...this.status.mix.levels, [stem]: Math.max(0, Math.min(200, level)) } };
    this.deps.host.setStemLevels(STEMS.map(stem => effectiveGain(mix, stem)));
  };
  toggleMute = (stem: Stem) => this.toggle('muted', stem);
  toggleSolo = (stem: Stem) => this.toggle('solo', stem);
  private toggle(key: 'muted' | 'solo', stem: Stem) {
    const set = new Set(this.status.mix[key]); if (!set.delete(stem)) set.add(stem);
    this.updateMix({ ...this.status.mix, [key]: set });
  }
  setPreset = (preset: 'original' | 'karaoke' | 'vocals20') => {
    const mix = originalMix();
    this.updateMix(preset === 'original' ? mix : { ...mix, levels: { ...mix.levels, vocals: preset === 'karaoke' ? 0 : 20 } });
  };
  reset = () => this.setPreset('original');
  refresh = (track?: StemTrack, reload = false) => {
    if (track && (!this.track || trackKey(track) !== trackKey(this.track))) return;
    if (!reload && (this.active || this.status.state === 'loading')) return;
    this.retry();
  };
  retry = () => { if (!isOriginal(this.status.mix)) { this.cancelLoad(); this.release(); void this.load(); } };
  private updateMix(mix: Mix) {
    this.status = { ...this.status, mix }; saveMix(mix);
    this.deps.host.setStemLevels(STEMS.map(stem => effectiveGain(mix, stem)));
    this.publish(this.status.state, this.status.reason);
    if (isOriginal(mix)) {
      this.cancelLoad(); this.cancelPrefetch(); this.release('original');
      this.publish(this.codecUnsupported ? 'unsupported' : 'original', this.codecUnsupported ? 'codec' : undefined);
    } else if (!this.active && this.status.state !== 'loading' && this.activated) void this.load();
  }
  private async load() {
    const track = this.track;
    if (!track || !this.activated || isOriginal(this.status.mix)) return;
    this.cancelLoad();
    const generation = this.generation, controller = this.controller = new AbortController();
    const valid = () => generation === this.generation && !controller.signal.aborted;
    const incoming = this.prefetch && trackKey(this.prefetch.track) === trackKey(track) ? this.prefetch : undefined;
    if (incoming) this.prefetch = undefined;
    let rejectLoad!: (error: Error) => void;
    const cancelled = new Promise<never>((_resolve, reject) => { rejectLoad = reject; });
    const timer = setTimeout(() => rejectLoad(new Error('Stems loading timed out')), LOAD_TIMEOUT_MS);
    const wait = <T>(task: Promise<T>) => Promise.race([task, cancelled]);
    const abort = () => { incoming?.controller.abort(); rejectLoad(new Error('Stems loading cancelled')); };
    controller.signal.addEventListener('abort', abort, { once: true });
    this.publish('loading');
    try {
      if (!await wait(this.probeResult!)) { if (valid()) this.publish('unsupported', 'codec'); return; }
      if ((track.duration || 0) > 480) { this.publish('unsupported', 'too-long'); return; }
      const prefetched = incoming ? await wait(incoming.data) : null;
      if (!valid()) return;
      const manifest = prefetched?.manifest || await wait(this.deps.manifest(track, controller.signal));
      if (!valid()) return;
      if (!manifest) { this.publish('original', 'not-ready'); return; }
      if (manifest.track.duration > 480) { this.publish('unsupported', 'too-long'); return; }
      const expected = this.songBytes(manifest);
      if (expected > DECODED_BUDGET) { this.publish('unsupported', 'too-long'); return; }
      const bytes = prefetched?.bytes || await wait(this.deps.fetch(manifest, controller.signal));
      if (!valid()) return;
      const buffers = incoming?.buffers || await wait(this.decode(bytes, valid));
      if (!valid() || !buffers) return;
      if (buffers.reduce((sum, buffer) => sum + buffer.length * buffer.numberOfChannels * 4, 0) > DECODED_BUDGET) throw new Error('Stem PCM budget');
      if (buffers.some(buffer => buffer.length !== buffers[0].length || buffer.sampleRate !== buffers[0].sampleRate)) throw new Error('Stem alignment mismatch');
      this.buffers = buffers;
      this.deps.host.setStemSource({
        duration: buffers[0].duration, sampleRate: buffers[0].sampleRate,
        levels: STEMS.map(stem => effectiveGain(this.status.mix, stem)),
        read: (start, frames) => buffers.flatMap(buffer => [0, 1].map(channel => buffer.getChannelData(Math.min(channel, buffer.numberOfChannels - 1)).slice(start, start + frames))),
      });
      this.publish('stems'); this.setNext(this.next || null);
    } catch (error) { if (valid()) { controller.abort(); this.fail(error); } }
    finally { clearTimeout(timer); controller.signal.removeEventListener('abort', abort); }
  }
  private songBytes(manifest: Manifest) { return manifest.track.duration * this.graph!.context.sampleRate * 2 * 4 * STEMS.length; }
  private decode(bytes: ArrayBuffer[], valid: () => boolean) {
    const task = this.decodeTail.then(async () => {
      if (!valid()) return;
      const results = await Promise.allSettled(bytes.map(data => this.graph!.context.decodeAudioData(data.slice(0))));
      if (!valid()) return;
      const failed = results.find(result => result.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
      return results.map(result => (result as PromiseFulfilledResult<AudioBuffer>).value);
    });
    this.decodeTail = task.then(() => {}, () => {}); return task;
  }
  private release(reason = 'stems-release') { this.deps.host.setStemSource(null, reason); this.buffers = undefined; }
  private fail(error: unknown) { this.release('stems-load-failed'); this.publish('error', error instanceof Error ? error.message : String(error)); }
  private cancelLoad() { this.generation++; this.controller?.abort(); this.controller = undefined; }
  private cancelPrefetch() { if (this.prefetch) this.prefetch.buffers = undefined; this.prefetch?.controller.abort(); this.prefetch = undefined; }
  setNext(track: StemTrack | null) {
    this.next = track || undefined;
    if (this.prefetch && track && trackKey(this.prefetch.track) === trackKey(track)) return;
    this.cancelPrefetch();
    if (!track || !this.activated || isOriginal(this.status.mix) || this.codecUnsupported || (track.duration || 0) > 480) return;
    const controller = new AbortController();
    const data = this.deps.manifest(track, controller.signal).then(async manifest => {
      if (!manifest || manifest.track.duration > 480 || controller.signal.aborted) return null;
      return { manifest, bytes: await this.deps.fetch(manifest, controller.signal) };
    });
    void data.catch(() => {}); // Lookahead failures cannot interrupt the current source.
    this.prefetch = { track, controller, data, decoding: false };
  }
  tick = () => {
    const prefetch = this.prefetch;
    const remaining = (this.buffers?.[0].duration || 0) - this.deps.host.currentTime;
    if (this.active && !this.deps.host.paused && prefetch && !prefetch.decoding && remaining > 0 && remaining <= 30) {
      prefetch.decoding = true; void this.prepareNext(prefetch);
    }
  };
  private async prepareNext(prefetch: Prefetch) {
    const valid = () => this.prefetch === prefetch && !prefetch.controller.signal.aborted;
    try {
      const data = await prefetch.data;
      if (!data || !valid()) return;
      const current = this.buffers?.reduce((sum, buffer) => sum + buffer.length * buffer.numberOfChannels * 4, 0) || 0;
      if (current + this.songBytes(data.manifest) > DECODED_BUDGET) return;
      const buffers = await this.decode(data.bytes, valid);
      if (valid() && buffers && current + buffers.reduce((sum, buffer) => sum + buffer.length * buffer.numberOfChannels * 4, 0) <= DECODED_BUDGET) prefetch.buffers = buffers;
    } catch { /* A promoted failure is handled by load; current playback survives. */ }
  }
  detach() {
    this.cancelLoad(); this.cancelPrefetch(); this.release();
    this.deps.host.removeEventListener('timeupdate', this.tick); this.listening = false;
    this.track = undefined; this.next = undefined; this.publish('original');
  }
}
export const stemPlayer = new StemPlayer();
