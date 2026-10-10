/**
 * THE MOMENT THIS MAC'S ADDRESSES MOVE.
 *
 * Nothing about where the companion answers is pinned at boot: the endpoint
 * list, the Host gate, the trusted names and the reach card all re-read the
 * interfaces on every call. What was never there is the EVENT. The publisher
 * re-read on a sixty-second clock and nothing else, so a laptop that closed
 * its lid on one Wi-Fi and opened it on another advertised the old network
 * for up to a minute, and told the phone nothing even then. The phone, on its
 * own minute clock, raced the stale names; the sheet said "your Mac is not on
 * this network" about a Mac on the same desk; a restart "fixed" it only
 * because a boot publishes at once.
 *
 * macOS has no network-change event a Node process can subscribe to without
 * a fork, so this is a cheap diff — `os.networkInterfaces()` is one syscall —
 * on a short clock, plus the two moments Electron CAN name: waking from sleep
 * and unlocking the screen. One callback, with what came and what went, and
 * only when the set actually differs. The first read seeds and is silent:
 * boot already published.
 */

export interface NetworkChange {
  readonly reason: string
  readonly added: readonly string[]
  readonly removed: readonly string[]
}

export interface NetworkWatchDeps {
  /** The addresses as the companion would advertise them right now. */
  readonly read: () => readonly string[]
  readonly onChange: (change: NetworkChange) => void
  readonly everyMs?: number
  readonly setInterval?: (fn: () => void, ms: number) => () => void
}

export interface NetworkWatch {
  /** Read now; true when the set differed and `onChange` was called. */
  readonly check: (reason: string) => boolean
  /** Poll on the clock. Returns the stop. */
  readonly start: () => () => void
}

/**
 * Short because it is nearly free, and because the whole point is the
 * seconds between a Wi-Fi joining and the phone being told.
 */
export const NETWORK_CHECK_MS = 10_000

const key = (addresses: readonly string[]): string => [...new Set(addresses)].sort().join(' ')

export const createNetworkWatch = (deps: NetworkWatchDeps): NetworkWatch => {
  let seen: readonly string[] | null = null

  const check = (reason: string): boolean => {
    let now: readonly string[]
    try {
      now = deps.read()
    } catch {
      // A read that failed is not a network that changed.
      return false
    }
    const before = seen
    seen = now
    if (before === null || key(before) === key(now)) return false
    const was = new Set(before)
    const is = new Set(now)
    deps.onChange({
      reason,
      added: [...is].filter((address) => !was.has(address)),
      removed: [...was].filter((address) => !is.has(address))
    })
    return true
  }

  const start = (): (() => void) => {
    const every =
      deps.setInterval ??
      ((fn, ms) => {
        const handle = setInterval(fn, ms)
        handle.unref()
        return () => clearInterval(handle)
      })
    return every(() => void check('poll'), deps.everyMs ?? NETWORK_CHECK_MS)
  }

  return { check, start }
}
