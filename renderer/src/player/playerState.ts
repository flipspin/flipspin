export type PlayerState = 'idle' | 'loading' | 'playing' | 'buffering' | 'paused' | 'retrying' | 'failed' | 'ended'
export type FailureCause = 'network' | 'auth' | 'decode' | 'notSupported' | 'missing'

export const moves: Readonly<Record<PlayerState, readonly PlayerState[]>> = {
  idle: ['loading'],
  loading: ['playing', 'paused', 'retrying', 'failed'],
  playing: ['paused', 'buffering', 'retrying', 'ended', 'loading'],
  buffering: ['playing', 'retrying', 'paused'],
  paused: ['playing', 'loading'],
  retrying: ['loading', 'failed'],
  failed: ['loading', 'paused'],
  ended: ['loading', 'idle'],
}

/** Pure transition table. The driver logs rejected moves without changing state. */
export function playerReducer(state: PlayerState, next: PlayerState): PlayerState {
  return moves[state].includes(next) ? next : state
}

export function playingWithIntent(state: PlayerState, intent: boolean): boolean {
  return state === 'playing' || state === 'buffering' || state === 'retrying' || (state === 'loading' && intent)
}
