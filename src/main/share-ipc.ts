import os from 'node:os'
import path from 'node:path'
import type { ShareIssueAnswer, ShareListAnswer, ShareResolveAnswer, ShareRevokeAnswer } from '../shared/share-devices'
import type { LiveValues } from '../shared/launch-settings'
import { defaultDiscoveryEnv, type DiscoveryEnv } from './route/discovery'
import { magpieBinary, magpieRunner, ShareKeys, shareWhere } from './route/share-keys'
import { fileIntentStore, INTENT_FILE } from './route/share-intents'
import { remoteSwitchedOn } from './magpie-remote/switches'

/**
 * The owner-only channels behind "Share with my devices". Registered through
 * index.ts's ownerOnly wrapper: a page the app merely renders must not be able
 * to mint a key on the owner's gateway. No companion or relay route carries any
 * of this, so the key never leaves the owner's window.
 *
 * A key is made only while both Magpie switches read on, asked at the press and
 * again before the key is handed over (share-keys.ts · permitted). Revoking,
 * resolving and clearing a left-behind key work whatever the switches say:
 * cutting a device off must never wait on a switch.
 */

export const SHARE_CHANNELS = ['route:share-list', 'route:share-issue', 'route:share-revoke', 'route:share-resolve', 'route:share-clear', 'route:share-done'] as const

export interface ShareIpcDeps {
  env?: DiscoveryEnv
  keys?: ShareKeys | null
  /** Optional factory for testing the production lazy initialization. */
  makeKeys?: () => ShareKeys | null
  interfaces?: () => ReturnType<typeof os.networkInterfaces>
  /** Read on each issue; unavailable or disabled must never mint a key. */
  enabled?: () => LiveValues | null
  /** A key was revoked here (magpie-remote/bound-keys.ts forgets it). */
  onRevoked?: (id: string) => void
}

const NO_MAGPIE = 'Magpie is not installed on this computer.'
const SWITCHED_OFF = 'Turn on Magpie and Magpie remote in Launch settings to make a key.'
const why = (error: unknown): string => (error instanceof Error ? error.message : 'Magpie did not answer.')

export function shareHandlers(deps: ShareIpcDeps = {}): {
  list: () => Promise<ShareListAnswer>
  issue: (input: unknown) => Promise<ShareIssueAnswer>
  revoke: (id: unknown) => Promise<ShareRevokeAnswer>
  resolve: (name: unknown) => Promise<ShareResolveAnswer>
  clear: (name: unknown) => Promise<ShareRevokeAnswer>
  done: (id: unknown) => { ok: true }
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
    held = bin === null ? null : new ShareKeys({ run: magpieRunner(bin), intents: fileIntentStore(path.join(os.homedir(), '.cookrew', INTENT_FILE)) })
    return held
  }
  /** Both switches, read now; anything unreadable is off. */
  const permitted = (): boolean => remoteSwitchedOn(() => deps.enabled?.() ?? null)
  const guarded = async <T>(work: (k: ShareKeys) => Promise<T>): Promise<T | { ok: false; why: string }> => {
    const k = keys()
    if (k === null) return { ok: false, why: NO_MAGPIE }
    try {
      return await work(k)
    } catch (error) {
      return { ok: false, why: why(error) }
    }
  }
  return {
    list: () => guarded(async (k) => ({ ok: true as const, ...(await k.list()), where: shareWhere(env, interfaces()) })),
    issue: (input) => {
      if (!permitted()) return Promise.resolve({ ok: false, why: SWITCHED_OFF })
      const form = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>
      return guarded((k) => k.issue({ device: form.device, dailyUsd: form.dailyUsd }, permitted))
    },
    revoke: (id) =>
      guarded(async (k) => {
        const answer = await k.revoke(id)
        if (answer.ok && typeof id === 'string') deps.onRevoked?.(id)
        return answer
      }),
    resolve: (name) => guarded((k) => k.resolve(name)),
    clear: (name) => guarded((k) => k.clear(name)),
    done: (id) => {
      keys()?.done(id)
      return { ok: true }
    }
  }
}

export function registerShareIpc(register: (channel: string, handler: (...args: unknown[]) => unknown) => void, deps: ShareIpcDeps = {}): void {
  const handlers = shareHandlers(deps)
  const [list, issue, revoke, resolve, clear, done] = SHARE_CHANNELS
  register(list, () => handlers.list())
  register(issue, (input) => handlers.issue(input))
  register(revoke, (id) => handlers.revoke(id))
  register(resolve, (name) => handlers.resolve(name))
  register(clear, (name) => handlers.clear(name))
  register(done, (id) => handlers.done(id))
}
