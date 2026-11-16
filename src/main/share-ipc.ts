import os from 'node:os'
import type { ShareIssueAnswer, ShareListAnswer, ShareRevokeAnswer } from '../shared/share-devices'
import { defaultDiscoveryEnv, type DiscoveryEnv } from './route/discovery'
import { magpieBinary, magpieRunner, ShareKeys, shareWhere } from './route/share-keys'

/**
 * The three owner-only channels behind "Share with my devices". Registered
 * through index.ts's ownerOnly wrapper: a page the app merely renders must not
 * be able to mint a key on the owner's gateway. No companion or relay route
 * carries any of this, so the key never leaves the owner's window.
 */

export const SHARE_CHANNELS = ['route:share-list', 'route:share-issue', 'route:share-revoke'] as const

export interface ShareIpcDeps {
  env?: DiscoveryEnv
  keys?: ShareKeys | null
  interfaces?: () => ReturnType<typeof os.networkInterfaces>
}

const NO_MAGPIE = 'Magpie is not installed on this computer.'
const why = (error: unknown): string => (error instanceof Error ? error.message : 'Magpie did not answer.')

export function shareHandlers(deps: ShareIpcDeps = {}): {
  list: () => Promise<ShareListAnswer>
  issue: (input: unknown) => Promise<ShareIssueAnswer>
  revoke: (id: unknown) => Promise<ShareRevokeAnswer>
} {
  const env = deps.env ?? defaultDiscoveryEnv()
  const interfaces = deps.interfaces ?? (() => os.networkInterfaces())
  const keys = (): ShareKeys | null => {
    if (deps.keys !== undefined) return deps.keys
    const bin = magpieBinary(env)
    return bin === null ? null : new ShareKeys({ run: magpieRunner(bin) })
  }
  return {
    list: async () => {
      const k = keys()
      if (k === null) return { ok: false, why: NO_MAGPIE }
      try {
        return { ok: true, keys: await k.list(), where: shareWhere(env, interfaces()) }
      } catch (error) {
        return { ok: false, why: why(error) }
      }
    },
    issue: async (input) => {
      const k = keys()
      if (k === null) return { ok: false, why: NO_MAGPIE }
      const form = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>
      try {
        return await k.issue({ device: form.device, dailyUsd: form.dailyUsd })
      } catch (error) {
        return { ok: false, why: why(error) }
      }
    },
    revoke: async (id) => {
      const k = keys()
      if (k === null) return { ok: false, why: NO_MAGPIE }
      try {
        return await k.revoke(id)
      } catch (error) {
        return { ok: false, why: why(error) }
      }
    }
  }
}

export function registerShareIpc(register: (channel: string, handler: (...args: unknown[]) => unknown) => void, deps: ShareIpcDeps = {}): void {
  const handlers = shareHandlers(deps)
  const [list, issue, revoke] = SHARE_CHANNELS
  register(list, () => handlers.list())
  register(issue, (input) => handlers.issue(input))
  register(revoke, (id) => handlers.revoke(id))
}
