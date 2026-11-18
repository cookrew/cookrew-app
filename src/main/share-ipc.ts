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
  /** Optional factory for testing the production lazy initialization. */
  makeKeys?: () => ShareKeys | null
  interfaces?: () => ReturnType<typeof os.networkInterfaces>
  /** Read on each issue; unavailable or disabled must never mint a key. */
  enabled?: () => { magpie: boolean; magpieRemote: boolean } | null
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
  let held: ShareKeys | null = deps.keys ?? null
  const keys = (): ShareKeys | null => {
    if (deps.keys !== undefined) return deps.keys
    if (held !== null) return held
    if (deps.makeKeys) {
      held = deps.makeKeys()
      return held
    }
    const bin = magpieBinary(env)
    held = bin === null ? null : new ShareKeys({ run: magpieRunner(bin) })
    return held
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
    issue: async (_input) => {
      // Fail closed until crash-safe ownership and pending-key recovery are implemented.
      return { ok: false, why: 'Creating device keys is temporarily unavailable; manage existing keys in Magpie.' }
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
