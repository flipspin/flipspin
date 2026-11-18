export type BpmFactor = 0.5 | 2

export function scaledBpm(bpm: unknown, factor: BpmFactor): number | null {
  if (typeof bpm !== 'number' || !Number.isFinite(bpm) || bpm <= 0) return null
  const result = bpm * factor
  return result >= 20 && result <= 300 ? result : null
}

