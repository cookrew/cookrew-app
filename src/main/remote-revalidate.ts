/**
 * ANOTHER MACHINE'S ANSWERS, ASKED FOR AGAIN ONLY IF THEY CHANGED (bytes 0.6.2).
 *
 * This desktop reads every other online machine of the account on a clock: its
 * fleet every 5 s at the Devices stop (use-zoom-fleet.ts), its cards every
 * 3 s while the zoom view is inside it (use-remote-machine.ts). Each of those
 * machines tags its answer (http-compress.ts, watch-routes.ts) and answers 304
 * to a reader that names the tag it holds, but nothing here ever named one:
 * measured 2026-11-11, Solis-Core reading the owner's Mac took 525 KB a
 * minute of the Mac's relay uplink for a fleet that had not changed.
 *
 * So a GET sends `If-None-Match` with the tag of the last answer held for that
 * machine and route, and a 304 hands back that answer as it was. This is a
 * Node client, never preflighted, so the header is the right place for it
 * (a browser page puts the tag in the address instead: http-compress.ts ·
 * validatorOf). A machine before 0.6.2 that answers 200 regardless is read as
 * before.
 *
 * Bounded (an LRU of `max` answers) and forgotten per machine when its key is
 * refused: what a machine said under a key it no longer takes is not reused.
 */

export interface Revalidated<T> {
  /** What came back, or null when nothing did (no key, no line). */
  readonly response: Response | null
  /** The answer: the held one on a 304, else what `read` made of the response. */
  readonly value: T | null
  /** True when the machine said 304 and the held answer was handed back. */
  readonly reused: boolean
}

export interface RemoteRevalidation {
  get<T>(
    machineId: string,
    route: string,
    send: (headers: Record<string, string>) => Promise<Response | null>,
    read: (response: Response) => Promise<T | null>
  ): Promise<Revalidated<T>>
  forget(machineId: string): void
  size(): number
}

/** Answers held across every machine; a fleet and a crew each, a picture or two, for a few machines. */
export const REVALIDATE_MAX = 128

export function createRemoteRevalidation(max = REVALIDATE_MAX): RemoteRevalidation {
  const held = new Map<string, { readonly tag: string; readonly value: unknown }>()
  const keyOf = (machineId: string, route: string): string => `${machineId}\n${route}`
  return {
    async get(machineId, route, send, read) {
      const key = keyOf(machineId, route)
      const mine = held.get(key)
      const response = await send(mine ? { 'if-none-match': mine.tag } : {})
      if (response === null) return { response: null, value: null, reused: false }
      if (response.status === 304) {
        await response.body?.cancel().catch(() => undefined)
        if (!mine) return { response, value: null, reused: false }
        // Most recently used goes last: the oldest is what the bound lets go of.
        held.delete(key)
        held.set(key, mine)
        return { response, value: mine.value as never, reused: true }
      }
      const value = await read(response)
      const tag = response.headers.get('etag')
      held.delete(key)
      if (response.status === 200 && tag && value !== null) {
        held.set(key, { tag, value })
        while (held.size > max) {
          const oldest = held.keys().next().value
          if (oldest === undefined) break
          held.delete(oldest)
        }
      }
      return { response, value, reused: false }
    },
    forget(machineId) {
      for (const key of [...held.keys()]) if (key.startsWith(`${machineId}\n`)) held.delete(key)
    },
    size: () => held.size
  }
}
