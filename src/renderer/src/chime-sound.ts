import { useSyncExternalStore } from 'react'
import { activityStore, coalesceEvery } from './activity-thumb-store'
import type { KeyedStore } from './keyed-store'
import type { TerminalActivity } from '../../shared/turn'
import { chimeToPlay, EMPTY_CHIME_MEMORY, stepChimes, type ChimeKind, type ChimeMemory } from './status-chime'

/**
 * THE SOUND OF AN AGENT (status-chime.ts decides when). Two short tones drawn
 * with WebAudio, no files: done is a soft rising fifth, needs-you a double
 * knock on one note, so the ear tells them apart without looking. Quiet on
 * purpose, and one switch in the ⋯ menu turns both off (kept per device).
 *
 * The desktop app may play at once (Electron's autoplay needs no gesture);
 * a phone browser starts its audio suspended, so the first touch or key on
 * the page unlocks it. A sound that cannot play is simply not heard: nothing
 * here may throw into the app.
 */

interface Note {
  /** Hz. */
  readonly freq: number
  /** Seconds after the chime starts. */
  readonly at: number
  /** Seconds to fade out. */
  readonly decay: number
}

const TUNES: Record<ChimeKind, readonly Note[]> = {
  // G5 then D6: up, settled, finished.
  done: [
    { freq: 784, at: 0, decay: 0.5 },
    { freq: 1175, at: 0.11, decay: 0.75 }
  ],
  // A5 twice: a knock at the door.
  waiting: [
    { freq: 880, at: 0, decay: 0.16 },
    { freq: 880, at: 0.17, decay: 0.4 }
  ]
}

/** Peak gain of a note's fundamental; its octave partial rides at OVERTONE of it. */
const PEAK = 0.09
const OVERTONE = 0.22
const ATTACK_S = 0.012
/** Two chimes closer than this (any agents) collapse into the first. */
const MIN_GAP_MS = 1_500
/** Activity events arrive several a second while agents work; read them at most this often. */
const READ_EVERY_MS = 400
const STORAGE_KEY = 'cookrew.sounds'

// ---- the switch ------------------------------------------------------------

function readStoredOn(): boolean {
  try {
    return globalThis.localStorage?.getItem(STORAGE_KEY) !== 'off'
  } catch {
    return true
  }
}

let on = readStoredOn()
const switchListeners = new Set<() => void>()

export const soundsOn = (): boolean => on

export function setSoundsOn(next: boolean): void {
  if (next === on) return
  on = next
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, next ? 'on' : 'off')
  } catch {
    // Private mode or a full quota: the switch still holds for this session.
  }
  for (const listener of switchListeners) listener()
  // Turning it on plays what it will sound like.
  if (next) playChime('done')
}

const subscribeSwitch = (cb: () => void): (() => void) => {
  switchListeners.add(cb)
  return () => switchListeners.delete(cb)
}

export function useSoundsOn(): boolean {
  return useSyncExternalStore(subscribeSwitch, soundsOn, soundsOn)
}

// ---- the tones -------------------------------------------------------------

type AudioCtor = typeof AudioContext
let context: AudioContext | null = null

function audio(): AudioContext | null {
  if (context) return context
  const scope = globalThis as unknown as { AudioContext?: AudioCtor; webkitAudioContext?: AudioCtor }
  const Ctor = scope.AudioContext ?? scope.webkitAudioContext
  if (!Ctor) return null
  try {
    context = new Ctor()
  } catch {
    return null
  }
  return context
}

function tone(ac: AudioContext, freq: number, start: number, decay: number, peak: number): void {
  const osc = ac.createOscillator()
  const gain = ac.createGain()
  osc.type = 'sine'
  osc.frequency.value = freq
  gain.gain.setValueAtTime(0.0001, start)
  gain.gain.exponentialRampToValueAtTime(peak, start + ATTACK_S)
  gain.gain.exponentialRampToValueAtTime(0.0001, start + ATTACK_S + decay)
  osc.connect(gain)
  gain.connect(ac.destination)
  osc.start(start)
  osc.stop(start + ATTACK_S + decay + 0.02)
}

export function playChime(kind: ChimeKind): void {
  const ac = audio()
  if (!ac) return
  try {
    if (ac.state === 'suspended') void ac.resume().catch(() => undefined)
    const t0 = ac.currentTime + 0.01
    for (const note of TUNES[kind]) {
      tone(ac, note.freq, t0 + note.at, note.decay, PEAK)
      tone(ac, note.freq * 2, t0 + note.at, note.decay * 0.6, PEAK * OVERTONE)
    }
  } catch {
    // No sound is better than a broken page.
  }
}

/** A phone's audio starts suspended; the first gesture on the page wakes it. */
function unlockOnGesture(): () => void {
  const events = ['pointerdown', 'keydown', 'touchend'] as const
  const unlock = (): void => {
    const ac = audio()
    if (ac && ac.state === 'suspended') void ac.resume().catch(() => undefined)
    off()
  }
  const off = (): void => {
    for (const name of events) document.removeEventListener(name, unlock, true)
  }
  for (const name of events) document.addEventListener(name, unlock, true)
  return off
}

// ---- the watcher -----------------------------------------------------------

/**
 * Watches the activity store and rings on the transitions status-chime.ts
 * names. Once per app (App.tsx); returns the unsubscribe. The memory steps
 * even while the switch is off, so turning it on never rings for the past.
 */
export function installStatusChime(
  store: KeyedStore<TerminalActivity> = activityStore,
  play: (kind: ChimeKind) => void = playChime,
  now: () => number = Date.now
): () => void {
  let memory: ChimeMemory = EMPTY_CHIME_MEMORY
  let lastPlayed = Number.NEGATIVE_INFINITY
  const read = (): void => {
    const at = now()
    const step = stepChimes(memory, store.getSnapshot(), at)
    memory = step.memory
    const kind = chimeToPlay(step.chimes)
    if (kind === null || !on || at - lastPlayed < MIN_GAP_MS) return
    lastPlayed = at
    play(kind)
  }
  read()
  const offStore = coalesceEvery(READ_EVERY_MS, (cb) => store.subscribeGlobal(cb), read, now)
  const offUnlock = typeof document === 'undefined' ? () => undefined : unlockOnGesture()
  return () => {
    offStore()
    offUnlock()
  }
}
