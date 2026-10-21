// The fleet store's real surroundings: fetch, EventSource, the page's
// visibility and this origin's localStorage. Everything here is a thin
// adapter; the behavior lives in fleet-store.ts and is tested there.
import { createFleetCache, type StorageLike } from './fleet-cache'
import { FLEET_TIMINGS, type FleetConfig, type FleetDeps } from './fleet-store'
import { openFetchStream } from './sse-reader'

/** Same key the companion and cookrew.dev's /me use (src/renderer/src/pairing-scope.ts). */
export const tokenKey = (machineId: string) => `cr_token:${machineId.toLowerCase()}`

const localStore = (): StorageLike | null => {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

export const readToken = (machineId: string): string | null => {
  try {
    return localStore()?.getItem(tokenKey(machineId)) ?? null
  } catch {
    return null
  }
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]'])

/**
 * Both read the registry's routes (the preview's mock serves them too). A
 * loopback page is the strata preview (scripts/strata-preview.mjs), where a
 * missing token is not "unpaired" unless the mock's auth switch says so, unless
 * `?fleet=registry` asks for production rules against a local registry.
 */
export const defaultFleetConfig = (where: Pick<Location, 'hostname' | 'search'> = location): FleetConfig => {
  const preview = LOOPBACK.has(where.hostname) && new URLSearchParams(where.search).get('fleet') !== 'registry'
  return {
    listUrl: '/v2/me/desktops',
    presenceUrl: '/v2/me/presence',
    requireToken: !preview,
    seedCacheUrl: preview ? '/preview/cache.json' : null,
    ...FLEET_TIMINGS
  }
}

export const browserFleetDeps = (): FleetDeps => ({
  fetch: (url, init) => fetch(url, init),
  openStream: openFetchStream,
  token: readToken,
  cache: createFleetCache(localStore(), Date.now),
  now: Date.now,
  random: Math.random,
  setTimer: (run, ms) => setTimeout(run, ms),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  visibility: {
    hidden: () => document.visibilityState === 'hidden',
    onChange: (run) => {
      document.addEventListener('visibilitychange', run)
      return () => document.removeEventListener('visibilitychange', run)
    }
  },
  onWake: (run) => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === null || event.key.startsWith('cr_token:')) run()
    }
    addEventListener('online', run)
    addEventListener('storage', onStorage)
    return () => {
      removeEventListener('online', run)
      removeEventListener('storage', onStorage)
    }
  }
})
