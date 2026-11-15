import React from 'react';
import { act, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { FakeContext, FakeNode } from './fakeAudio';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
it('the engine and visualiser share one context, analyser and existing output volume', async () => {
  vi.resetModules();
  const constructor = vi.fn(function () { return new FakeContext(); });
  vi.stubGlobal('AudioContext', constructor);
  const { getAudioGraph, peekAudioGraph } = await import('./audioGraph');
  expect(peekAudioGraph()).toBeUndefined();
  const { AudioAnalyzerProvider, useAudioAnalyzer } = await import('@state/AudioAnalyzerContext');
  const { result } = renderHook(() => useAudioAnalyzer() as {
    connectAudio: () => void;
    setOutputVolume: (volume: number) => void;
    getAnalyser: () => AnalyserNode;
  }, { wrapper: ({ children }) => <AudioAnalyzerProvider>{children}</AudioAnalyzerProvider> });
  act(() => result.current.connectAudio()); // mount while paused does not create a context
  expect(constructor).not.toHaveBeenCalled();
  const graph = getAudioGraph(); // first gesture, as in App
  act(() => result.current.connectAudio());
  expect(constructor).toHaveBeenCalledOnce();
  expect((graph.analyser as unknown as FakeNode).connections).toEqual([graph.levelling]);
  expect((graph.volume as unknown as FakeNode).connections).toEqual([graph.context.destination]);
  act(() => result.current.setOutputVolume(0.3));
  expect(graph.volume.gain.setTargetAtTime).toHaveBeenLastCalledWith(0.3, 10, 0.015);
  expect(result.current.getAnalyser()).toBe(graph.analyser);
  expect(constructor).toHaveBeenCalledOnce();
});


it('retains the analyzer value on unrelated renders and callbacks across connection and error changes', async () => {
  vi.resetModules();
  const context = new FakeContext();
  vi.stubGlobal('AudioContext', vi.fn(function () { return context; }));
  const { getAudioGraph } = await import('./audioGraph');
  const { AudioAnalyzerProvider, useAudioAnalyzer } = await import('@state/AudioAnalyzerContext');
  const view = renderHook(() => useAudioAnalyzer()!, { wrapper: ({ children }) => <AudioAnalyzerProvider>{children}</AudioAnalyzerProvider> });
  const initial = view.result.current;
  view.rerender();
  expect(view.result.current).toBe(initial);
  getAudioGraph();
  act(() => view.result.current.connectAudio());
  expect(view.result.current.isConnected).toBe(true);
  for (const key of ['connectAudio', 'getAnalyser', 'getAnalyserData', 'resume', 'resumeAudioContext'] as const) {
    expect(view.result.current[key]).toBe(initial[key]);
  }
  vi.spyOn(context, 'resume').mockRejectedValueOnce(new Error('resume failed'));
  await act(async () => view.result.current.resume());
  expect(view.result.current.hasError).toBe(true);
  expect(view.result.current.getAnalyser).toBe(initial.getAnalyser);
  expect(view.result.current.getAnalyserData).toBe(initial.getAnalyserData);
});
