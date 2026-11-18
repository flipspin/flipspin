import { expect, it, vi } from 'vitest'

it('composes levelling and volume after the shared analyser, independently of stem handover', async () => {
  vi.resetModules()
  const gains: { gain: { value: number; setValueAtTime: ReturnType<typeof vi.fn>; setTargetAtTime: ReturnType<typeof vi.fn> }; connect: ReturnType<typeof vi.fn> }[] = []
  const node = () => ({ connect: vi.fn(), gain: { value: 1, setValueAtTime: vi.fn(), setTargetAtTime: vi.fn(function (this: {value: number}, value: number) { this.value = value }) } })
  const analyser = node()
  const destination = node()
  class Context {
    currentTime = 5
    destination = destination
    createAnalyser = () => analyser
    createGain = () => { const gain = node(); gains.push(gain); return gain }
  }
  vi.stubGlobal('AudioContext', Context)
  try {
    const { setLevellingGain, setGraphVolume, getAudioGraph } = await import('./audioGraph')
    setLevellingGain(.5)
    setGraphVolume(.3)
    const graph = getAudioGraph()
    expect(graph.levelling?.gain.value).toBe(.5)
    expect(graph.volume.gain.value).toBe(.3)
    expect(analyser.connect).toHaveBeenCalledWith(graph.levelling)
    expect(gains[1].connect).toHaveBeenCalledWith(graph.volume)
    expect(gains[0].connect).toHaveBeenCalledWith(destination)
    setLevellingGain(.25)
    expect(graph.levelling?.gain.setTargetAtTime).toHaveBeenCalledWith(.25, 5, 0.001)
    expect(graph.volume.gain.value).toBe(.3)
  } finally { vi.unstubAllGlobals() }
})
