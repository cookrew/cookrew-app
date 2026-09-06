// A REMEMBERED ADDRESS BELONGS TO THE NETWORK IT WAS LEARNED ON.
//
// RFC 8305 is unusually direct about this: historical address data "MUST NOT
// be used across different network interfaces" and "SHOULD be flushed whenever
// a device changes the network". Our hint was keyed by desktop alone, so
// 192.168.1.24 learned on home Wi-Fi was offered first on the train, on a
// coffee shop's network, and — the case that actually costs something — on a
// DIFFERENT house whose router hands out the same private range and whose
// 192.168.1.24 is somebody else's machine.
//
// It is only ever a hint: the address is still made to prove it is the Mac
// before anything is sent to it, so the worst a stale hint can do is waste one
// probe. That is the reason this can be a cheap fingerprint rather than a real
// network identity — and the reason it must still be dropped, because one
// wasted probe on every race adds up on a battery.

import { describe, expect, it } from 'vitest'
import {
  PATH_MEMORY_BLIND_TTL_MS,
  PATH_MEMORY_TTL_MS,
  createPathMemory,
  watchNetwork,
  type PathMemoryDeps
} from '../src/renderer/src/path-memory'

const DEVICE = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const LAN = 'https://192-168-1-24.d.cookrew.dev:8643'

/** A phone whose storage, clock and radio the test drives directly. */
const phone = (
  over: Partial<PathMemoryDeps> & { readonly hints?: string | null } = {}
): { deps: PathMemoryDeps; store: Map<string, string>; at: (ms: number) => void; onto: (net: string | null) => void } => {
  const store = new Map<string, string>()
  let clock = 1_000
  let network: string | null = over.hints === undefined ? 'wifi/4g' : over.hints
  const deps: PathMemoryDeps = {
    read: (key) => store.get(key) ?? null,
    write: (key, value) => void store.set(key, value),
    remove: (key) => void store.delete(key),
    now: () => clock,
    network: () => network,
    ...over
  }
  return {
    deps,
    store,
    at: (ms) => void (clock = ms),
    onto: (net) => void (network = net)
  }
}

describe('the hint, on the network it was learned on', () => {
  it('gives back what it was told, so the badge fills in without a race', () => {
    const { deps } = phone()
    const memory = createPathMemory(deps)
    memory.remember(DEVICE, LAN)
    expect(memory.remembered(DEVICE)).toBe(LAN)
  })

  it('knows nothing about a desktop it has never seen', () => {
    expect(createPathMemory(phone().deps).remembered(DEVICE)).toBe(null)
  })

  it('survives a storage that refuses to answer — private-mode Safari throws', () => {
    const memory = createPathMemory({
      ...phone().deps,
      read: () => {
        throw new Error('SecurityError')
      },
      write: () => {
        throw new Error('SecurityError')
      }
    })
    expect(() => memory.remember(DEVICE, LAN)).not.toThrow()
    expect(memory.remembered(DEVICE)).toBe(null)
  })

  it('reads a value it did not write as nothing, rather than as an address', () => {
    // The old format was a bare URL under the same key. Trusting it would be
    // trusting a hint with no network on it at all.
    const { deps, store } = phone()
    store.set(`cr_path:${DEVICE}`, LAN)
    expect(createPathMemory(deps).remembered(DEVICE)).toBe(null)
    store.set(`cr_path:${DEVICE}`, '{not json')
    expect(createPathMemory(deps).remembered(DEVICE)).toBe(null)
  })
})

describe('a different network', () => {
  it('refuses a hint learned on another radio', () => {
    const { deps, onto } = phone()
    const memory = createPathMemory(deps)
    memory.remember(DEVICE, LAN)
    onto('cellular/3g')
    expect(memory.remembered(DEVICE)).toBe(null)
  })

  it('refuses a hint written before the phone came back online', () => {
    // The event is the platform telling us the interface moved. Even where the
    // drop below could not run — another tab, a storage error — the hint no
    // longer matches, because the generation is part of what was written.
    const { deps } = phone()
    const memory = createPathMemory(deps)
    memory.remember(DEVICE, LAN)
    memory.noteNetworkChange()
    expect(memory.remembered(DEVICE)).toBe(null)
  })

  it('drops what it holds outright on a network change, not just on read', () => {
    const { deps, store } = phone()
    const memory = createPathMemory(deps)
    memory.remember(DEVICE, LAN)
    memory.remember('another-desktop', LAN)
    memory.noteNetworkChange()
    expect([...store.keys()].filter((key) => key.startsWith('cr_path:'))).toEqual([])
  })

  it('remembers again on the new network, so the drop is not permanent', () => {
    const { deps } = phone()
    const memory = createPathMemory(deps)
    memory.noteNetworkChange()
    memory.remember(DEVICE, LAN)
    expect(memory.remembered(DEVICE)).toBe(LAN)
  })
})

describe('how long a hint lives', () => {
  it('is five minutes when the platform says something about the network', () => {
    const { deps, at } = phone()
    const memory = createPathMemory(deps)
    memory.remember(DEVICE, LAN)
    at(1_000 + PATH_MEMORY_TTL_MS - 1)
    expect(memory.remembered(DEVICE)).toBe(LAN)
    at(1_000 + PATH_MEMORY_TTL_MS)
    expect(memory.remembered(DEVICE)).toBe(null)
  })

  it('is two minutes when it says nothing at all — Safari, where a move is invisible', () => {
    const { deps, at } = phone({ hints: null })
    const memory = createPathMemory(deps)
    memory.remember(DEVICE, LAN)
    at(1_000 + PATH_MEMORY_BLIND_TTL_MS - 1)
    expect(memory.remembered(DEVICE)).toBe(LAN)
    at(1_000 + PATH_MEMORY_BLIND_TTL_MS)
    expect(memory.remembered(DEVICE)).toBe(null)
  })

  it('is shorter blind than sighted, which is the whole point of the two', () => {
    expect(PATH_MEMORY_BLIND_TTL_MS).toBeLessThan(PATH_MEMORY_TTL_MS)
    expect(PATH_MEMORY_TTL_MS).toBe(300_000)
    expect(PATH_MEMORY_BLIND_TTL_MS).toBe(120_000)
  })

  it('refuses a hint from the future, which is a clock that moved', () => {
    const { deps, at } = phone()
    const memory = createPathMemory(deps)
    memory.remember(DEVICE, LAN)
    at(0)
    expect(memory.remembered(DEVICE)).toBe(null)
  })
})

describe('the events that flush it', () => {
  const events = (): {
    fire: (name: string) => void
    dropped: () => number
    off: () => void
  } => {
    const handlers = new Map<string, () => void>()
    const { deps } = phone()
    const memory = createPathMemory(deps)
    let dropped = 0
    const watched = {
      ...memory,
      noteNetworkChange: (): void => {
        dropped += 1
        memory.noteNetworkChange()
      }
    }
    const off = watchNetwork(watched, (event, listener) => {
      handlers.set(event, listener)
      return () => handlers.delete(event)
    })
    return {
      fire: (name) => handlers.get(name)?.(),
      dropped: () => dropped,
      off
    }
  }

  it('drops on online, which is the platform saying the interface moved', () => {
    const watch = events()
    watch.fire('online')
    expect(watch.dropped()).toBe(1)
    watch.off()
  })

  it('drops on the first look after an offline stretch', () => {
    // A phone that loses the Wi-Fi in a pocket and is taken out somewhere else
    // never fires `online` if it came back on a different radio while hidden.
    const watch = events()
    watch.fire('offline')
    watch.fire('visibilitychange')
    expect(watch.dropped()).toBe(1)
    // And only once: the offline stretch is over.
    watch.fire('visibilitychange')
    expect(watch.dropped()).toBe(1)
    watch.off()
  })

  it('leaves the hint alone when the tab is merely looked at', () => {
    const watch = events()
    watch.fire('visibilitychange')
    watch.fire('visibilitychange')
    expect(watch.dropped()).toBe(0)
    watch.off()
  })

  it('stops listening when torn down', () => {
    const watch = events()
    watch.off()
    watch.fire('online')
    expect(watch.dropped()).toBe(0)
  })
})
