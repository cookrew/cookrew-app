// THE RELAY BUDGET. cookrew.dev carries at most 16 requests in flight per
// desktop, and every open stream holds one for as long as it is open; past
// that the relay answers 503 too_many_exchanges. The shell's share per
// machine is 6: its one levels stream, plus at most one warm embed document
// with everything that document holds open. The rest stays free for the
// owner's other devices on the same desktop (a phone, a second tab).
import { levelOf, type StrataMachine, type StrataPath } from '../../shared/strata'

export const RELAY_EXCHANGES_PER_DESKTOP = 16
export const SHELL_EXCHANGES_PER_MACHINE = 6
export const LEVELS_STREAM_EXCHANGES = 1
/** What one embed document may hold open at rest: its whole share minus the levels stream. */
export const EMBED_EXCHANGES = SHELL_EXCHANGES_PER_MACHINE - LEVELS_STREAM_EXCHANGES

export const WARM_EMBEDS = { phone: 2, desktop: 3 } as const

/** Hover this long over a machine or an agent before its document starts. */
export const HOVER_INTENT_MS = 150

export const maxWarmEmbeds = (phone: boolean): number => (phone ? WARM_EMBEDS.phone : WARM_EMBEDS.desktop)

/**
 * The machine a dive from here will almost certainly land on, or null. Inside
 * a machine (its workspaces, one workspace's agents) every dive lands on that
 * machine. On level 0 only a fleet with exactly one machine online has one —
 * counted from the registry, not from links, so the first of several
 * machines to go live during boot is not mistaken for the only one.
 */
export const obviousTarget = (path: StrataPath, machines: readonly StrataMachine[]): string | null => {
  const level = levelOf(path)
  if (level !== 'machines') return path.machine ?? null
  const online = machines.filter((m) => m.online)
  return online.length === 1 && online[0].link === 'live' ? online[0].id : null
}

export interface HoverIntent {
  enter(machineId: string): void
  leave(): void
  dispose(): void
}

/** Prewarm on a hover that lingers, never on a pointer just passing over. */
export const createHoverIntent = (
  prewarm: (machineId: string) => void,
  timers: { setTimer(run: () => void, ms: number): unknown; clearTimer(handle: unknown): void },
  delayMs = HOVER_INTENT_MS
): HoverIntent => {
  let pending: unknown = null
  const cancel = () => {
    if (pending !== null) timers.clearTimer(pending)
    pending = null
  }
  return {
    enter(machineId) {
      cancel()
      pending = timers.setTimer(() => {
        pending = null
        prewarm(machineId)
      }, delayMs)
    },
    leave: cancel,
    dispose: cancel
  }
}

/** One machine's share, from what a document was measured to hold (deliverable 6). */
export const machineExchanges = (embedHolds: number, embedWarm: boolean): number =>
  LEVELS_STREAM_EXCHANGES + (embedWarm ? embedHolds : 0)
