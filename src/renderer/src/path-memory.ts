import { PATH_MEMORY_PREFIX } from './path/switch'

/**
 * THE LAST WINNING PATH, KEYED BY THE NETWORK IT WAS WON ON.
 *
 * WHY A HINT IS ONLY EVER A HINT. The remembered address is put at the FRONT
 * of the race and nothing else: it is still asked for the device id, still
 * asked to echo a fresh nonce, and under the relay base still proved to the
 * registry before a single byte of the session goes near it. So the worst a
 * wrong hint can do is waste one probe. That is what makes a cheap fingerprint
 * enough here — this is not an identity, it is an ordering — and it is also
 * why the memory can be thrown away freely: losing it costs one race.
 *
 * WHY IT STILL HAS TO BE THROWN AWAY. RFC 8305 says historical address
 * information "MUST NOT be used across different network interfaces" and
 * "SHOULD be flushed whenever a device changes the network", and the reason is
 * ours exactly: 192.168.1.24 learned in this house is a different machine in
 * the next one, because every router hands out the same private range. One
 * wasted probe per race, on every race, off a phone battery, for an address
 * that cannot possibly answer.
 *
 * THREE THINGS KEY IT, each covering the others' blind spot:
 *
 *   WHAT THE PLATFORM SAYS. `navigator.connection.type` and `effectiveType`
 *   are cheap, and they change when a phone moves from Wi-Fi to cellular —
 *   which is the common case and the one that matters.
 *
 *   A GENERATION THAT SURVIVES A RELOAD. Bumped on every `online`, stored
 *   beside the hint, and compared on read. It is the belt to the flush's
 *   braces: the flush can fail — a storage that throws, a second tab, a page
 *   killed mid-event — and a generation that no longer matches cannot.
 *
 *   TIME. Five minutes where the platform gives a hint at all, two where it
 *   gives none. Safari exposes no connection object, so a phone that walks out
 *   of the house is invisible there and the only honest guard is a shorter
 *   life. Two minutes costs one extra race every two minutes on a companion
 *   that is genuinely parked; it saves a wasted probe on every race on one
 *   that is not.
 */

/** How long a hint lives where the platform describes the connection. */
export const PATH_MEMORY_TTL_MS = 300_000

/** How long it lives where the platform describes nothing. Safari, today. */
export const PATH_MEMORY_BLIND_TTL_MS = 120_000

/** Where the online generation is kept, beside the hints it invalidates. */
export const PATH_NETWORK_KEY = 'cr_net'

/** What is actually written under `cr_path:<deviceId>`. */
interface StoredHint {
  readonly url: string
  /** The fingerprint at the time of writing. */
  readonly net: string
  /** Whether the platform said anything, which decides how long this lives. */
  readonly seen: boolean
  readonly at: number
}

export interface PathMemoryDeps {
  readonly read: (key: string) => string | null
  readonly write: (key: string, value: string) => void
  readonly remove: (key: string) => void
  readonly now: () => number
  /**
   * A cheap description of the current connection, or null where the platform
   * offers none. Null is not a value to compare — it is the absence of one.
   */
  readonly network: () => string | null
  /** Every key in storage, for the flush. Absent means "flush what I ask for". */
  readonly keys?: () => readonly string[]
}

export interface PathMemory {
  readonly remembered: (deviceId: string) => string | null
  readonly remember: (deviceId: string, url: string) => void
  /** The network moved. Bump the generation and drop every hint we hold. */
  readonly noteNetworkChange: () => void
}

const keyFor = (deviceId: string): string => `${PATH_MEMORY_PREFIX}${deviceId}`

/**
 * The memory, over an injected storage.
 *
 * NOTHING IN HERE THROWS. Private-mode Safari raises on `localStorage`, a
 * quota can be full, and a hint is worth exactly one saved probe — so every
 * failure degrades to "no hint" and the race runs as it would have anyway.
 */
export const createPathMemory = (deps: PathMemoryDeps): PathMemory => {
  const read = (key: string): string | null => {
    try {
      return deps.read(key)
    } catch {
      return null
    }
  }
  const write = (key: string, value: string): void => {
    try {
      deps.write(key, value)
    } catch {
      // A hint that cannot be written is a race that runs in full. Fine.
    }
  }
  const remove = (key: string): void => {
    try {
      deps.remove(key)
    } catch {
      // Same: the generation below already makes it unusable.
    }
  }

  const generation = (): string => read(PATH_NETWORK_KEY) ?? '0'

  /** The whole key: what the platform says, plus which online era this is. */
  const fingerprint = (): { net: string; seen: boolean } => {
    let described: string | null = null
    try {
      described = deps.network()
    } catch {
      described = null
    }
    return { net: `${described ?? '?'}#${generation()}`, seen: described !== null }
  }

  const parse = (raw: string | null): StoredHint | null => {
    if (raw === null || !raw.startsWith('{')) return null
    try {
      const value = JSON.parse(raw) as Partial<StoredHint>
      if (typeof value.url !== 'string' || typeof value.net !== 'string') return null
      if (typeof value.at !== 'number') return null
      return { url: value.url, net: value.net, seen: value.seen === true, at: value.at }
    } catch {
      return null
    }
  }

  return {
    remembered: (deviceId) => {
      const hint = parse(read(keyFor(deviceId)))
      if (!hint) return null
      const here = fingerprint()
      if (hint.net !== here.net) return null
      const age = deps.now() - hint.at
      // A negative age is a clock that moved, which is exactly the situation a
      // phone is in after a suspend. Refuse it rather than trusting either end.
      if (age < 0) return null
      return age < (hint.seen ? PATH_MEMORY_TTL_MS : PATH_MEMORY_BLIND_TTL_MS) ? hint.url : null
    },
    remember: (deviceId, url) => {
      const here = fingerprint()
      const hint: StoredHint = { url, net: here.net, seen: here.seen, at: deps.now() }
      write(keyFor(deviceId), JSON.stringify(hint))
    },
    noteNetworkChange: () => {
      const next = Number(generation()) + 1
      write(PATH_NETWORK_KEY, String(Number.isFinite(next) ? next : 1))
      // Hygiene rather than correctness — the generation above has already
      // made every existing hint unmatchable — but a phone that changes
      // network all day should not carry a growing pile of dead addresses.
      const keys = (() => {
        try {
          return deps.keys?.() ?? []
        } catch {
          return []
        }
      })()
      for (const key of keys) if (key.startsWith(PATH_MEMORY_PREFIX)) remove(key)
    }
  }
}

/**
 * THE TWO MOMENTS A PHONE'S NETWORK ACTUALLY CHANGES, watched.
 *
 * `online` is the platform saying so, and is the easy half. The hard half is
 * the phone that loses Wi-Fi in a pocket and comes back on cellular while the
 * tab is hidden: `online` may fire against a hidden document, or the radio may
 * have swapped with no transition at all. So an offline stretch ARMS the flush
 * and the next look at the tab fires it — once, because the stretch is then
 * over.
 *
 * A visibility change on its own is not a network change and must not flush.
 * A companion is looked at dozens of times an hour and every flush is a race
 * the reader watches say PROBING.
 */
export const watchNetwork = (
  memory: PathMemory,
  on: (event: string, listener: () => void) => () => void
): (() => void) => {
  let wasOffline = false
  const offs: (() => void)[] = [
    on('online', () => {
      wasOffline = false
      memory.noteNetworkChange()
    }),
    on('offline', () => void (wasOffline = true)),
    on('visibilitychange', () => {
      if (!wasOffline) return
      wasOffline = false
      memory.noteNetworkChange()
    })
  ]
  return () => offs.forEach((off) => off())
}
