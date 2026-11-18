import { vi } from 'vitest';
import type { AudioGraph } from './audioGraph';

export class FakeParam {
  private current = 1;
  // A write fails the test even if the writer sets the existing value.
  get value() { return this.current; }
  set value(_value: number) { throw new Error('Use setTargetAtTime'); }
  setTargetAtTime = vi.fn((value: number, _when: number, _constant: number) => { this.current = value; });
  cancelScheduledValues = vi.fn();
}
export class FakeNode {
  connections: unknown[] = [];
  connect = vi.fn((node: unknown) => { this.connections.push(node); });
  disconnect = vi.fn(() => { this.connections = []; });
}
export class FakeGain extends FakeNode { gain = new FakeParam(); }
export class FakeSource extends FakeNode {
  buffer: AudioBuffer | null = null;
  onended: (() => void) | null = null;
  start = vi.fn();
  stop = vi.fn();
}
export const fakeBuffer = (duration = 180) => ({ duration, sampleRate: 48000, numberOfChannels: 2, length: duration * 48000 }) as AudioBuffer;
export class FakeContext {
  currentTime = 10;
  sampleRate = 48000;
  outputLatency = 0.012;
  baseLatency = 0.005;
  state = 'running';
  destination = new FakeNode();
  sources: FakeSource[] = [];
  gains: FakeGain[] = [];
  resume = vi.fn(async () => { this.state = 'running'; });
  decodeAudioData = vi.fn(async (_bytes: ArrayBuffer) => fakeBuffer());
  createGain = () => { const node = new FakeGain(); this.gains.push(node); return node as unknown as GainNode; };
  createBufferSource = () => { const node = new FakeSource(); this.sources.push(node); return node as unknown as AudioBufferSourceNode; };
  createAnalyser = vi.fn(() => new FakeNode());
  createMediaElementSource = vi.fn(() => new FakeNode());
  graph(): AudioGraph {
    return { context: this as unknown as AudioContext, analyser: new FakeNode() as unknown as AnalyserNode, volume: this.createGain() };
  }
}
export function fakeElement(position = 42, duration = 180) {
  const element = document.createElement('audio');
  Object.defineProperty(element, 'duration', { value: duration, configurable: true });
  element.currentTime = position;
  vi.spyOn(element, 'play').mockResolvedValue();
  vi.spyOn(element, 'pause').mockImplementation(() => {});
  return element;
}
export const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
