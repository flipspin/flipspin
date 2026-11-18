import React, { createContext, useContext, useRef, useState, useCallback, useMemo } from 'react';
import { getAudioGraph, setGraphVolume, peekAudioGraph } from '../stems/audioGraph';
export interface AnalyserData<T extends Uint8Array | Float32Array = Uint8Array | Float32Array> {
  dataArray: T;
  bufferLength: number;
  sampleRate: number;
}
export interface AudioAnalyzerContextValue {
  connectAudio: (...args: unknown[]) => void;
  setOutputVolume: typeof setGraphVolume;
  getAnalyserData: {
    (dataType: "timeDomainFloat"): AnalyserData<Float32Array<ArrayBuffer>> | null;
    (dataType?: "timeDomain" | "frequency"): AnalyserData<Uint8Array<ArrayBuffer>> | null;
    (dataType: string): AnalyserData | null;
  };
  getAnalyser: () => AnalyserNode | null;
  isConnected: boolean;
  hasError: boolean;
  resumeAudioContext: () => void;
  resume: () => void;
}

const AudioAnalyzerContext = createContext<AudioAnalyzerContextValue | null>(null);
export function AudioAnalyzerProvider({ children }: { children: React.ReactNode }) {
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const timeArrayRef = useRef<Uint8Array<ArrayBuffer> | null>(null);
  const freqArrayRef = useRef<Uint8Array<ArrayBuffer> | null>(null);
  const floatArrayRef = useRef<Float32Array<ArrayBuffer> | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [connectionError, setConnectionError] = useState(false);
  // Compatibility name: observes the engine's existing graph; creates no source.
  const connectAudio = useCallback(() => {
    const graph = peekAudioGraph();
    if (!graph) return;
    audioContextRef.current = graph.context;
    analyserRef.current = graph.analyser;
    setIsConnected(true);
  }, []);
  const setOutputVolume = setGraphVolume;
  const resumeAudioContext = useCallback(() => {
    const graph = peekAudioGraph();
    if (graph) void graph.context.resume().catch(() => setConnectionError(true));
  }, []);
  const getAnalyserData = useCallback((dataType = "timeDomain"): AnalyserData | null => {
    if (!analyserRef.current) return null;
    // Exact samples (−1…1) for views that draw the wave itself; bytes quantise it to 256 steps.
    if (dataType === 'timeDomainFloat') {
      const length = analyserRef.current.frequencyBinCount;
      if (!floatArrayRef.current || floatArrayRef.current.length !== length) floatArrayRef.current = new Float32Array(length);
      analyserRef.current.getFloatTimeDomainData(floatArrayRef.current);
      if (floatArrayRef.current.every(value => value === 0)) return null;
      return { dataArray: floatArrayRef.current, bufferLength: length, sampleRate: audioContextRef.current?.sampleRate || 44100 };
    }

    const bufferLength = analyserRef.current.frequencyBinCount;
    // Reuse typed arrays to avoid allocations each frame
    if (dataType === 'timeDomain') {
      if (!timeArrayRef.current || timeArrayRef.current.length !== bufferLength) {
        timeArrayRef.current = new Uint8Array(bufferLength);
      }
    } else {
      if (!freqArrayRef.current || freqArrayRef.current.length !== bufferLength) {
        freqArrayRef.current = new Uint8Array(bufferLength);
      }
    }
    const dataArray = (dataType === 'timeDomain' ? timeArrayRef.current : freqArrayRef.current)!;

    try {
      if (dataType === 'timeDomain') {
        analyserRef.current.getByteTimeDomainData(dataArray);
      } else {
        analyserRef.current.getByteFrequencyData(dataArray);
      }


      const hasNonZeroData = dataType === 'timeDomain' 
        ? !dataArray.every(val => val === 128)
        : !dataArray.every(val => val === 0);

      if (!hasNonZeroData) {
        // Getting zeros could mean CORS issues
        return null;
      }

      // sampleRate lets frequency-domain views map bins → real Hz (axis labels,
      // log scaling, peak frequencies). Falls back to a common rate if unknown.
      const sampleRate = audioContextRef.current?.sampleRate || 44100;
      return { dataArray, bufferLength, sampleRate };
    } catch (e) {
      console.error('Error getting analyzer data:', e);
      return null;
    }
  }, []);

  const getAnalyser = useCallback(() => {
    try {
      const graph = getAudioGraph();
      audioContextRef.current = graph.context;
      analyserRef.current = graph.analyser;
      return graph.analyser;
    } catch { setConnectionError(true); return null; }
  }, []);
  const value = useMemo(() => ({ connectAudio, setOutputVolume,
    // Each branch returns the array type selected by the requested data type.
    getAnalyserData: getAnalyserData as AudioAnalyzerContextValue["getAnalyserData"], getAnalyser, isConnected,
    hasError: connectionError, resumeAudioContext, resume: resumeAudioContext }), [connectAudio, setOutputVolume, getAnalyserData, getAnalyser, isConnected, connectionError, resumeAudioContext]);
  return <AudioAnalyzerContext.Provider value={value}>{children}</AudioAnalyzerContext.Provider>;
}
// eslint-disable-next-line react-refresh/only-export-components
export const useAudioAnalyzer = () => useContext(AudioAnalyzerContext);
