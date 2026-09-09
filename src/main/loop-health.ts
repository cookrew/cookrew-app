/**
 * The main thread's own pulse, read-only.
 *
 * Every number the perf program has for "main-thread stalls" so far is taken
 * from OUTSIDE the process — an HTTP probe, an event's duration — and each of
 * those mixes two things that want different fixes: a loaded machine (the
 * timer thread is descheduled, nothing in this process can help) and this
 * process holding its own loop (a synchronous fork, a big serialise, a walk
 * that grew with residency). This module reads the loop from the inside so
 * the two can be told apart:
 *
 *   delay  — perf_hooks.monitorEventLoopDelay: how late timers fire. Rises
 *            with BOTH the machine and the app.
 *   elu    — performance.eventLoopUtilization: the fraction of the window the
 *            loop was busy. Rises ONLY with the app's own work.
 *   loops  — per named periodic loop (the drain, the board probe), the tick
 *            durations observed through observe()/timed(). A max in the
 *            seconds names the loop that held the thread.
 *
 * One-minute windows, a ring of the last fifteen, so a stall that happened
 * five minutes ago is still on the next read. Nothing here is Electron-bound:
 * it is plain Node, which is what makes it testable.
 */
import { monitorEventLoopDelay, performance, type EventLoopUtilization } from 'node:perf_hooks'
import { latencyStats } from '../shared/stats'
import type { SousBreakerState } from './sous-breaker'
import type { ProbeStats } from './board-index'

/** Window length; the read route reports the last COMPLETE window first. */
export const LOOP_WINDOW_MS = 60_000
/** Completed windows kept — fifteen minutes of history on a read. */
export const LOOP_WINDOWS_KEPT = 15
/** Histogram sampling resolution; 20 ms keeps the sampler itself invisible. */
const RESOLUTION_MS = 20
/** Tick durations kept per loop; the drain at 5 s is 180 per window. */
const TICKS_KEPT_PER_LOOP = 4000

export interface LoopWindow {
  /** Window start, epoch ms. */
  at: number
  /** How much of the window had elapsed when it was summarised. */
  elapsedMs: number
  /** Histogram samples in the window. */
  samples: number
  /** Timer lateness, ms. */
  p50: number
  p95: number
  p98: number
  max: number
  /** Event-loop utilisation over the window, 0..1. */
  elu: number
}

export interface LoopTicks {
  count: number
  p50: number
  p95: number
  max: number
  /** The most recent tick, so a live stall is visible before the window closes. */
  lastMs: number
  lastAt: number
}

export interface LoopHealthSnapshot {
  now: number
  uptimeMs: number
  windowMs: number
  loop: {
    /** The last complete window, or null in the first minute. */
    lastMinute: LoopWindow | null
    /** The window still filling. */
    current: LoopWindow
    /** Completed windows, oldest first, at most LOOP_WINDOWS_KEPT. */
    windows: LoopWindow[]
  }
  /** Per named periodic loop, over the same horizon as the windows. */
  loops: Record<string, LoopTicks>
  /** Whatever the caller wants read next to the loop — resident counts here. */
  residency: Record<string, number>
  /** The Sous circuit breaker (sous-breaker.ts), or null when not wired. */
  sous?: SousBreakerState | null
  /** The board probe's cadence: subscribers, current rung, passes and listings per minute. */
  probe?: ProbeStats
}

export interface LoopHealthDeps {
  residency?: () => Record<string, number>
  sous?: () => SousBreakerState
  probe?: () => ProbeStats
  now?: () => number
  windowMs?: number
  keep?: number
}

/**
 * The periodic loops that report. A closed set on purpose: the name lands
 * verbatim as a key in an HTTP body, so it must never be a workspace or
 * terminal id.
 */
export type LoopName = 'boardProbe' | 'sessionDrain'

/** A read is memoised this long: the route must not perturb what it measures. */
export const SNAPSHOT_MEMO_MS = 1000

export interface LoopHealth {
  snapshot(): LoopHealthSnapshot
  /** Record one tick of a named loop. */
  observe(loop: LoopName, ms: number): void
  /** Run a synchronous tick and record how long it held the thread. */
  timed<T>(loop: LoopName, run: () => T): T
  stop(): void
}

interface Tick {
  at: number
  ms: number
}

const nsToMs = (ns: number): number => Math.round(ns / 1e4) / 100

export function createLoopHealth(deps: LoopHealthDeps = {}): LoopHealth {
  const now = deps.now ?? (() => Date.now())
  const windowMs = deps.windowMs ?? LOOP_WINDOW_MS
  const keep = deps.keep ?? LOOP_WINDOWS_KEPT
  const startedAt = now()
  const histogram = monitorEventLoopDelay({ resolution: RESOLUTION_MS })
  histogram.enable()

  let windows: LoopWindow[] = []
  let windowStart = startedAt
  let eluBase: EventLoopUtilization = performance.eventLoopUtilization()
  /**
   * Per loop, the recent ticks. Mutated in place on purpose: observe() runs
   * on every tick of every loop, and rebuilding the map plus copying a
   * 4000-entry array there would make the instrument a loop of its own.
   * Bounded by count here, by age on read.
   */
  const ticks = new Map<LoopName, Tick[]>()
  let memo: { at: number; snapshot: LoopHealthSnapshot } | null = null

  const summarise = (): LoopWindow => {
    const samples = histogram.count
    return {
      at: windowStart,
      elapsedMs: now() - windowStart,
      samples,
      p50: samples ? nsToMs(histogram.percentile(50)) : 0,
      p95: samples ? nsToMs(histogram.percentile(95)) : 0,
      p98: samples ? nsToMs(histogram.percentile(98)) : 0,
      max: samples ? nsToMs(histogram.max) : 0,
      elu: Math.round(performance.eventLoopUtilization(eluBase).utilization * 1000) / 1000
    }
  }

  const closeWindow = (): void => {
    windows = [...windows, summarise()].slice(-keep)
    histogram.reset()
    eluBase = performance.eventLoopUtilization()
    windowStart = now()
  }

  const horizon = (): number => now() - keep * windowMs

  const prune = (list: readonly Tick[], since: number): Tick[] =>
    list.filter((t) => t.at >= since).slice(-TICKS_KEPT_PER_LOOP)

  const timer = setInterval(closeWindow, windowMs)
  timer.unref?.()

  const observe = (loop: LoopName, ms: number): void => {
    const list = ticks.get(loop) ?? []
    list.push({ at: now(), ms })
    if (list.length > TICKS_KEPT_PER_LOOP) list.splice(0, list.length - TICKS_KEPT_PER_LOOP)
    ticks.set(loop, list)
  }

  return {
    observe,
    timed: (loop, run) => {
      const started = performance.now()
      try {
        return run()
      } finally {
        observe(loop, performance.now() - started)
      }
    },
    snapshot: () => {
      if (memo && now() - memo.at < SNAPSHOT_MEMO_MS) return memo.snapshot
      const since = horizon()
      const loops: Record<string, LoopTicks> = {}
      for (const [loop, list] of ticks) {
        const kept = prune(list, since)
        const stats = latencyStats(kept.map((t) => t.ms))
        if (!stats) continue
        const last = kept[kept.length - 1]
        loops[loop] = {
          count: stats.count,
          p50: Math.round(stats.p50 * 100) / 100,
          p95: Math.round(stats.p95 * 100) / 100,
          max: Math.round(stats.max * 100) / 100,
          lastMs: Math.round(last.ms * 100) / 100,
          lastAt: last.at
        }
      }
      const snapshot: LoopHealthSnapshot = {
        now: now(),
        uptimeMs: now() - startedAt,
        windowMs,
        loop: {
          lastMinute: windows[windows.length - 1] ?? null,
          current: summarise(),
          windows: [...windows]
        },
        loops,
        residency: deps.residency?.() ?? {},
        sous: deps.sous?.() ?? null,
        ...(deps.probe ? { probe: deps.probe() } : {})
      }
      memo = { at: now(), snapshot }
      return snapshot
    },
    stop: () => {
      clearInterval(timer)
      histogram.disable()
    }
  }
}
