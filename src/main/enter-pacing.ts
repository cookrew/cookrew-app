import { submitDelayMs } from './ask'

/**
 * An Enter arriving inside a burst of words is taken for part of a paste, and
 * they stay in the agent's line unsubmitted. A client's words and its Enter are
 * two /raw requests, one round trip apart, which on a LAN is no gap at all
 * (Menu QA F10, measured: 300 characters stuck 4 times in 6, with 150 ms between
 * 0 in 5). So a bare Enter waits as long as a submit's own Enter does.
 *
 * /raw only: a phone's queue holds one request in flight per terminal, so the
 * wait cannot let later keys overtake this one.
 */

interface Burst {
  readonly length: number
  readonly at: number
}

export interface EnterPacingDeps {
  now: () => number
  sleep: (ms: number) => Promise<void>
}

const realTime: EnterPacingDeps = {
  now: Date.now,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms))
}

export function createEnterPacing(deps: EnterPacingDeps = realTime): (terminalId: string, data: string) => Promise<void> {
  const bursts = new Map<string, Burst>()
  const settledAt = (burst: Burst): number => burst.at + submitDelayMs(burst.length)

  return async (terminalId, data) => {
    const burst = bursts.get(terminalId)
    const now = deps.now()
    if (/[\r\n]/.test(data)) {
      bursts.delete(terminalId)
      const wait = burst && /^[\r\n]+$/.test(data) ? settledAt(burst) - now : 0
      if (wait > 0) await deps.sleep(wait)
      return
    }
    const going = burst !== undefined && settledAt(burst) > now
    bursts.set(terminalId, { length: (going ? burst.length : 0) + data.length, at: now })
  }
}
