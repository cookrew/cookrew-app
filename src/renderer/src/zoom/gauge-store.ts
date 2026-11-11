/**
 * THE GAUGES AS THE PAGE HOLDS THEM. One loop per machine, while a leaf at the
 * devices stop watches it (MachineGauges.tsx) and the window is in sight.
 *
 * ONE QUESTION OUT PER MACHINE, ALWAYS. The next is set only when the last has
 * answered, so a Mac that takes a minute to reply, as a swapping one does, is
 * asked once a minute instead of having questions stack behind it. That outlives
 * the loop: crossing the stop back and forth must not spend a relay slot each way.
 *
 * ONLY THE LEAF HEARS. Listeners are per machine, and nothing in the zoom view
 * subscribes, so a sample re-renders four small cells and no more (the rule of
 * cookrew-render-perf-2026-11 and cookrew-perf-slate-lane).
 *
 * WHAT `get` SAYS: undefined, nothing has answered yet; null, no reading; else
 * the reading. One lost answer keeps the last numbers, since a phone on a bad
 * link should not flicker, but GAUGE_STALE_MS after the last answer they go,
 * on a clock of their own: a question still out is exactly what a stalled Mac
 * looks like, and calm numbers then are the worst thing this panel could show.
 */
import { registerScopeState } from '../machine-scope'
import { parseMachineGauges, type MachineGauges } from '../../../shared/machine-gauges'
import { cookrew } from '../api'
import { documentSight, type Sight } from './use-zoom-fleet'
import { barStop, BAR_STOPS } from './zoom-path'
import type { ZoomState } from './zoom-store'

export const GAUGE_POLL_MS = 4_000
/** Each question to another desktop crosses the relay twice: it is asked less often. */
export const GAUGE_REMOTE_POLL_MS = 10_000
export const GAUGE_STALE_MS = 15_000
/** A machine that keeps saying nothing (a wall TV's refused token, a Mac gone) is asked less and less, down to this. */
export const GAUGE_BACKOFF_MAX_MS = 30_000

export type GaugeReading = MachineGauges | null | undefined
export type GaugeSight = Sight
export type GaugeAsk = (machineId: string, local: boolean) => Promise<MachineGauges | null>

export interface GaugeStoreOptions {
  ask: GaugeAsk
  sight?: Sight | null
}

export interface GaugeStore {
  /** Hold this machine's loop; returns the release. */
  watch: (machineId: string, local: boolean) => () => void
  subscribe: (machineId: string, listener: () => void) => () => void
  get: (machineId: string) => GaugeReading
  /**
   * The machine in scope is another one now. A loop that asked "this machine"
   * would go on asking, and file the next machine's numbers under the last
   * one's id: those loops end here and their readings go. A loop for a machine
   * by its own id is unaffected.
   */
  turn: () => void
}

interface Loop {
  holds: number
  local: boolean
  /** In sight and held: answers count and the clock runs. */
  live: boolean
  timer: ReturnType<typeof setTimeout> | null
  /** When its numbers stop being claimed. */
  stale: ReturnType<typeof setTimeout> | null
  /** Answers in a row that were none. */
  misses: number
}

/** Whether the devices stop is what the zoom is at, or on its way to. */
export function atDevicesStop(zoom: Pick<ZoomState, 'dir' | 'v' | 'full'>): boolean {
  return zoom.full === null && barStop(zoom.dir, zoom.v) === BAR_STOPS[zoom.dir][0]
}

export function createGaugeStore(options: GaugeStoreOptions): GaugeStore {
  const { ask, sight = null } = options
  const loops = new Map<string, Loop>()
  const readings = new Map<string, MachineGauges | null>()
  const listeners = new Map<string, Set<() => void>>()
  /** Machines with a question out, kept apart from the loops: a question outlives the loop that sent it. */
  const asking = new Set<string>()
  let unwatch: (() => void) | null = null

  const tell = (machineId: string): void => {
    for (const listener of listeners.get(machineId) ?? []) listener()
  }

  const stopClocks = (loop: Loop): void => {
    if (loop.timer !== null) clearTimeout(loop.timer)
    if (loop.stale !== null) clearTimeout(loop.stale)
    loop.timer = null
    loop.stale = null
  }

  const drop = (machineId: string): void => {
    if (readings.delete(machineId)) tell(machineId)
  }

  const commit = (machineId: string, loop: Loop, answer: MachineGauges | null): void => {
    if (answer) {
      loop.misses = 0
      if (loop.stale !== null) clearTimeout(loop.stale)
      loop.stale = setTimeout(() => {
        loop.stale = null
        readings.set(machineId, null)
        tell(machineId)
      }, GAUGE_STALE_MS)
      readings.set(machineId, answer)
      tell(machineId)
      return
    }
    loop.misses += 1
    // Numbers on the page stay until their own clock ends them.
    if (readings.has(machineId)) return
    readings.set(machineId, null)
    tell(machineId)
  }

  const nextDelay = (loop: Loop): number => {
    const base = loop.local ? GAUGE_POLL_MS : GAUGE_REMOTE_POLL_MS
    return Math.min(GAUGE_BACKOFF_MAX_MS, base * 2 ** Math.max(0, loop.misses - 1))
  }

  async function pump(machineId: string): Promise<void> {
    const sent = loops.get(machineId)
    if (!sent?.live || asking.has(machineId) || sent.timer !== null) return
    asking.add(machineId)
    const answer = await ask(machineId, sent.local).catch(() => null)
    asking.delete(machineId)
    // Whichever loop holds the machine now: the one that asked may be gone.
    const loop = loops.get(machineId)
    if (!loop?.live) return
    commit(machineId, loop, answer)
    loop.timer = setTimeout(() => {
      loop.timer = null
      void pump(machineId)
    }, nextDelay(loop))
  }

  const onSight = (): void => {
    const hidden = sight?.hidden() ?? false
    for (const [machineId, loop] of loops) {
      loop.live = !hidden
      if (hidden) {
        stopClocks(loop)
        drop(machineId)
      } else void pump(machineId)
    }
  }

  const forget = (machineId: string, loop: Loop): void => {
    loop.live = false
    stopClocks(loop)
    loops.delete(machineId)
    drop(machineId)
    if (loops.size === 0) {
      unwatch?.()
      unwatch = null
    }
  }

  return {
    watch: (machineId, local) => {
      const held = loops.get(machineId)
      const loop: Loop = held ?? { holds: 0, local, live: !(sight?.hidden() ?? false), timer: null, stale: null, misses: 0 }
      loop.holds += 1
      if (!held) {
        loops.set(machineId, loop)
        if (sight && !unwatch) unwatch = sight.watch(onSight)
        void pump(machineId)
      }
      let released = false
      return () => {
        if (released) return
        released = true
        loop.holds -= 1
        // Only the loop still holding this machine: one ended by `turn` must not take its successor with it.
        if (loop.holds === 0 && loops.get(machineId) === loop) forget(machineId, loop)
      }
    },
    turn: () => {
      for (const [machineId, loop] of [...loops]) {
        if (!loop.local) continue
        loop.live = false
        stopClocks(loop)
        loops.delete(machineId)
        drop(machineId)
      }
      if (loops.size === 0) {
        unwatch?.()
        unwatch = null
      }
    },
    subscribe: (machineId, listener) => {
      const set = listeners.get(machineId) ?? new Set<() => void>()
      set.add(listener)
      listeners.set(machineId, set)
      return () => {
        set.delete(listener)
        if (set.size === 0) listeners.delete(machineId)
      }
    },
    get: (machineId) => readings.get(machineId)
  }
}

const askCookrew: GaugeAsk = async (machineId, local) => {
  const api = cookrew()
  return parseMachineGauges(await (local ? api.machineGauges?.() : api.machineGaugesOf?.(machineId)))
}

let shared: GaugeStore | null = null

// It ends loops and tells the leaves that drew their numbers, so it goes with what stops.
registerScopeState('machine gauges', () => shared?.turn(), 'stop')

/** The page's one store. */
export const gaugeStore = (): GaugeStore => {
  shared ??= createGaugeStore({ ask: askCookrew, sight: documentSight })
  return shared
}
