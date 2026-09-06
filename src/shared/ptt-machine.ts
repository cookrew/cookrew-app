// Push-to-talk on the ⌘ key, as a machine with no DOM in it.
//
// Hold ⌘ alone for a beat and Sous listens; let go and it stops. The beat is
// what keeps ⌘C, ⌘V, ⌘W and every other chord working: a second key inside
// the hold cancels, and a ⌘ that comes back up before the beat was a chord
// that never got its letter. Blur is a key-up the window never saw.
//
// Pure so the timing can be tested with a clock instead of a browser: feed it
// events, read back what to do.

export const PTT_HOLD_MS = 350

export type PttState =
  | { phase: 'idle' }
  | { phase: 'armed'; since: number }
  | { phase: 'listening' }

export type PttEvent =
  | { type: 'keydown'; key: string; metaKey: boolean; repeat: boolean }
  | { type: 'keyup'; key: string }
  | { type: 'tick'; now: number }
  | { type: 'blur' }
  /** The listener ended on its own (final delivered, error, max-seconds). */
  | { type: 'ended' }

export type PttAction = 'start' | 'stop' | null

export const PTT_IDLE: PttState = { phase: 'idle' }

/** One step: the next state and what the world should do about it. */
export function pttStep(state: PttState, event: PttEvent, now: number): { state: PttState; action: PttAction } {
  switch (event.type) {
    case 'keydown':
      if (event.key === 'Meta') {
        // A held key auto-repeats keydown; only the first one arms.
        if (state.phase === 'idle' && !event.repeat) return { state: { phase: 'armed', since: now }, action: null }
        return { state, action: null }
      }
      // Any other key while armed makes this a chord, not a hold. While
      // listening, a chord ends the listen: ⌘C mid-sentence means copy.
      if (state.phase === 'armed') return { state: PTT_IDLE, action: null }
      if (state.phase === 'listening') return { state: PTT_IDLE, action: 'stop' }
      return { state, action: null }
    case 'keyup':
      if (event.key !== 'Meta') return { state, action: null }
      if (state.phase === 'listening') return { state: PTT_IDLE, action: 'stop' }
      return { state: PTT_IDLE, action: null }
    case 'tick':
      if (state.phase === 'armed' && event.now - state.since >= PTT_HOLD_MS) {
        return { state: { phase: 'listening' }, action: 'start' }
      }
      return { state, action: null }
    case 'blur':
      if (state.phase === 'listening') return { state: PTT_IDLE, action: 'stop' }
      return { state: PTT_IDLE, action: null }
    case 'ended':
      return { state: PTT_IDLE, action: null }
  }
}
