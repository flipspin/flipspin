/** One context and one levelling stage for the playback engine and visualiser. Creating this is a gesture-time operation. */
import { getVolume, setVolume, subscribeVolume } from '../player/volumeStore';

export interface AudioGraph {
  context: AudioContext;
  analyser: AnalyserNode;
  volume: GainNode;
  levelling?: GainNode;
}
let graph: AudioGraph | undefined;
let levellingValue = 1;

export function setLevellingGain(value: number): void {
  levellingValue = value;
  graph?.levelling?.gain.setTargetAtTime(value, graph.context.currentTime, 0.001);
}
export function setGraphVolume(value: number): void {
  setVolume(value);
}
subscribeVolume(() => {
  graph?.volume.gain.setTargetAtTime(getVolume(), graph.context.currentTime, 0.015);
});
export const peekAudioGraph = () => graph;
export function getAudioGraph(): AudioGraph {
  if (!graph) {
    const Constructor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const context = new Constructor({ sampleRate: 44100 });
    const analyser = context.createAnalyser();
    analyser.fftSize = 1024;
    const volume = context.createGain();
    const levelling = context.createGain();
    levelling.gain.setTargetAtTime(levellingValue, context.currentTime, 0.001);
    volume.gain.setTargetAtTime(getVolume(), context.currentTime, 0.001);
    analyser.connect(levelling);
    levelling.connect(volume);
    volume.connect(context.destination);
    graph = { context, analyser, volume, levelling };
  }
  return graph;
}
