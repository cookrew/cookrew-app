import { submitDelayMs } from './ask'

/**
 * An Enter arriving inside a burst of words is taken for part of a paste, and
 * they stay in the agent's line unsubmitted (Menu QA F10). A client's words and
 * its Enter are two writes with no gap between them: two /raw requests a round
 * trip apart on a LAN, two IPC messages in one tick on the desktop. Measured: 300
 * characters stuck 4 times in 6 over /raw and 2 in 6 over IPC, with 150 ms
 * between them 0 in 5. So a bare Enter waits as long as a submit's own Enter does.
 *
 * /raw awaits createEnterPacing: a phone's queue holds one request in flight per
 * terminal, so nothing can overtake. IPC has no such queue: createPacedInput keeps
 * the order itself, and keys that need no wait still go at once.
 */

/**
 * From this long, words written to an agent go as a bracketed paste. Raw blocks
 * of about 1 KB and up lose words, the attach client drops with them, and nothing
 * says so (measured on a real agent, read back from its transcript: 900 characters
 * whole 4 of 4, 1000 1 of 4, 1500 2 of 4; bracketed 15 of 15, up to 6000).
 */
const PASTE_FROM = 512
const PASTE_OPEN = '\x1b[200~'
const PASTE_CLOSE = '\x1b[201~'
/** Anything but words: an Enter or a sequence of its own is the writer's to mean. */
const NOT_WORDS_RE = /[\x00-\x08\x0b-\x1f\x7f]/

/**
 * A long block of words as a paste, in bytes (the limit it stays under is a
 * buffer's). The editing keys ahead of it stay keys, a phone's batch among them.
 * Agents only: a plain program would show the markers.
 */
export function blockAsPaste(data: string): string {
  const cut = Math.max(data.lastIndexOf('\x7f'), data.lastIndexOf('\x15'), data.lastIndexOf('\x05')) + 1
  const keys = data.slice(0, cut)
  const words = data.slice(cut)
  if (Buffer.byteLength(words) < PASTE_FROM || NOT_WORDS_RE.test(words) || /[\r\x1b]/.test(keys)) return data
  return `${keys}${PASTE_OPEN}${words}${PASTE_CLOSE}`
}

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

/**
 * Words written as a block, which is what a TUI takes for a paste. Not a person
 * typing: a key at a time, or an arrow, whose Enter must never lag in a shell.
 */
const isBlock = (data: string): boolean => data.length > 1 && !/^\x1b(?!\[200~)/.test(data)

/** How long this write must wait, its burst noted. */
function createEnterWait(now: () => number): (terminalId: string, data: string) => number {
  const bursts = new Map<string, Burst>()
  const settledAt = (burst: Burst): number => burst.at + submitDelayMs(burst.length)

  return (terminalId, data) => {
    const burst = bursts.get(terminalId)
    const at = now()
    if (/[\r\n]/.test(data)) {
      bursts.delete(terminalId)
      return burst && /^[\r\n]+$/.test(data) ? Math.max(0, settledAt(burst) - at) : 0
    }
    if (!isBlock(data)) return 0
    const going = burst !== undefined && settledAt(burst) > at
    bursts.set(terminalId, { length: (going ? burst.length : 0) + data.length, at })
    return 0
  }
}

export function createEnterPacing(deps: EnterPacingDeps = realTime): (terminalId: string, data: string) => Promise<void> {
  const waitFor = createEnterWait(deps.now)
  return async (terminalId, data) => {
    const wait = waitFor(terminalId, data)
    if (wait > 0) await deps.sleep(wait)
  }
}

/** Writes in order, per terminal, with an Enter behind words held back as above. */
export function createPacedInput(
  write: (terminalId: string, data: string) => void,
  deps: EnterPacingDeps = realTime
): (terminalId: string, data: string) => void {
  const waitFor = createEnterWait(deps.now)
  /** What arrived behind an Enter that is waiting. */
  const behind = new Map<string, string[]>()

  /** After a wait no caller is left to catch a throw, and the keys behind must still go. */
  const safely = (run: () => void): void => {
    try {
      run()
    } catch (error) {
      console.error('Input write failed:', error)
    }
  }

  const input = (terminalId: string, data: string): void => {
    const held = behind.get(terminalId)
    if (held) {
      held.push(data)
      return
    }
    const wait = waitFor(terminalId, data)
    if (wait === 0) {
      write(terminalId, data)
      return
    }
    behind.set(terminalId, [])
    void deps.sleep(wait).then(() => {
      const next = behind.get(terminalId) ?? []
      behind.delete(terminalId)
      safely(() => write(terminalId, data))
      // Through input: a later Enter may start a wait, and the rest queue behind it.
      for (const later of next) safely(() => input(terminalId, later))
    })
  }
  return input
}
