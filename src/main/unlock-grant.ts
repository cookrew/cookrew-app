import { randomUUID } from 'node:crypto'
import type { ViewerWho } from '../shared/remote-access'
import { FixedWindowLimiter } from '../shared/fixed-window-limiter'
import {
  commitmentOf,
  grantDigest,
  grantNonce,
  isGrantKey,
  isGrantNonce,
  mintGrantKey,
  sealGrantCode,
  wordsOfGrant,
  type GrantAsked,
  type GrantDone,
  type GrantPending,
  type GrantRefusal,
  type GrantStatus
} from '../shared/unlock-grant'

/**
 * THE MAC'S SIDE OF SETTING UP UNLOCK FROM A NEW DEVICE (shared/unlock-grant.ts).
 *
 * A device that asks gets one exchange at a time. Once it has revealed its key,
 * the Mac puts the words in front of the owner (`confirm`: a dialog, then Touch
 * ID) and lists them for any device inside the sealed session to approve. The
 * first answer settles it and closes the other. Nothing is sealed before a yes.
 *
 * The asker is told only how it stands, and only about its own exchange.
 */

export const GRANT_REVEAL_MS = 120_000
export const GRANT_WAIT_MS = 600_000
/** An answer waits this long to be picked up. */
export const GRANT_KEPT_MS = 120_000
const ASKS_PER_MINUTE = 4
const LIVE_MAX = 8
const COMMIT = /^[A-Za-z0-9_-]{43}$/

export interface ConfirmAsk {
  readonly name: string
  readonly words: readonly string[]
  /** Aborted once the exchange is settled elsewhere or runs out: the prompt goes. */
  readonly signal: AbortSignal
}

export interface UnlockGrantDeps {
  /** Why this machine cannot be set up for unlock; null when it can. */
  refusal(): string | null
  /** The connect code, as a pairing link carries it. */
  code(): string
  /** The Mac's unlock key, public half: the device pins it. */
  unlockKey(): string
  /** True only for a person at the Mac who said yes. */
  confirm(ask: ConfirmAsk): Promise<boolean>
  record(outcome: string, who: ViewerWho): void
  /** The list of exchanges waiting for a yes changed. */
  changed?(): void
  now?: () => number
  newId?: () => string
}

type Answer<T> = T | GrantRefusal

export interface UnlockGrantDoor {
  ask(who: ViewerWho, body: unknown): Promise<Answer<GrantAsked>>
  reveal(who: ViewerWho, body: unknown): Promise<Answer<GrantDone>>
  status(who: ViewerWho, id: unknown): Promise<Answer<GrantStatus>>
  /** For a device inside the sealed session: what waits, except its own. */
  pending(approver: ViewerWho): readonly GrantPending[]
  decide(approver: ViewerWho, body: unknown): Answer<GrantDone>
  waiting(): number
}

interface Exchange {
  readonly id: string
  readonly who: ViewerWho
  readonly commit: string
  readonly macKey: string
  readonly macPrivate: CryptoKey
  readonly macNonce: string
  readonly unlockKey: string
  readonly askedAt: number
  until: number
  state: 'asked' | 'waiting' | 'allowed' | 'denied' | 'expired'
  phoneKey: string
  phoneNonce: string
  words: readonly string[]
  sealed: Promise<string> | null
  by: string | null
  readonly prompt: AbortController
}

const no = (error: string): GrantRefusal => ({ ok: false, error })
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

const UNKNOWN = 'That set-up is not known here any more. Start again.'

export function createUnlockGrantDoor(deps: UnlockGrantDeps): UnlockGrantDoor {
  const now = deps.now ?? Date.now
  const newId = deps.newId ?? randomUUID
  const asks = new FixedWindowLimiter(ASKS_PER_MINUTE, 60_000, now)
  const live = new Map<string, Exchange>()
  let prompts: Promise<unknown> = Promise.resolve()

  const changed = (): void => deps.changed?.()

  const sweep = (): void => {
    const at = now()
    let moved = false
    for (const [id, one] of live) {
      if (one.until >= at) continue
      one.prompt.abort()
      if (one.state === 'waiting') moved = true
      if (one.state === 'asked' || one.state === 'waiting') {
        one.state = 'expired'
        one.until = at + GRANT_KEPT_MS
        continue
      }
      live.delete(id)
    }
    if (moved) changed()
  }

  const mine = (who: ViewerWho, id: unknown): Exchange | null => {
    const one = typeof id === 'string' ? live.get(id) : undefined
    return one && one.who.key === who.key ? one : null
  }

  const settle = (one: Exchange, allow: boolean, by: string): boolean => {
    if (one.state !== 'waiting') return false
    one.state = allow ? 'allowed' : 'denied'
    one.by = by
    one.until = now() + GRANT_KEPT_MS
    one.prompt.abort()
    if (allow) {
      one.sealed = (async () => sealGrantCode(one.macPrivate, one.phoneKey, await grantDigest(one), deps.code()))()
      // An answer that never opens is a set-up that failed: said by `status`.
      one.sealed.catch(() => undefined)
    }
    deps.record(allow ? `allowed to unlock by ${by}` : `refused set-up by ${by}`, one.who)
    changed()
    return true
  }

  const askAtTheMac = (one: Exchange): void => {
    prompts = prompts
      .then(async () => {
        if (one.state !== 'waiting') return
        const yes = await deps.confirm({ name: one.who.name, words: one.words, signal: one.prompt.signal })
        settle(one, yes, yes ? 'someone at the Mac' : 'the Mac')
      })
      // No way to ask here (no screen): it waits for a device that can already unlock.
      .catch(() => undefined)
  }

  return {
    async ask(who, body) {
      sweep()
      const refusal = deps.refusal()
      if (refusal !== null) return no(refusal)
      if (who.here) return no('This is the Mac: it can already unlock itself.')
      const commit = isRecord(body) ? body.commit : null
      if (typeof commit !== 'string' || !COMMIT.test(commit)) return no('That request could not be read.')
      if (!asks.take(who.key)) return no('Too many set-ups from this device. Try again in a minute.')
      // One exchange per device: a new one replaces the last.
      for (const [id, one] of live) {
        if (one.who.key !== who.key || (one.state !== 'asked' && one.state !== 'waiting')) continue
        one.prompt.abort()
        live.delete(id)
        changed()
      }
      if ([...live.values()].filter((one) => one.state === 'asked' || one.state === 'waiting').length >= LIVE_MAX) return no('Too many devices are setting up at once. Try again in a few minutes.')
      const key = await mintGrantKey()
      const one: Exchange = {
        id: newId(),
        who,
        commit,
        macKey: key.publicKey,
        macPrivate: key.privateKey,
        macNonce: grantNonce(),
        unlockKey: deps.unlockKey(),
        askedAt: now(),
        until: now() + GRANT_REVEAL_MS,
        state: 'asked',
        phoneKey: '',
        phoneNonce: '',
        words: [],
        sealed: null,
        by: null,
        prompt: new AbortController()
      }
      live.set(one.id, one)
      return { ok: true, id: one.id, macKey: one.macKey, macNonce: one.macNonce, unlockKey: one.unlockKey, until: one.until }
    },

    async reveal(who, body) {
      sweep()
      if (!isRecord(body)) return no('That request could not be read.')
      const one = mine(who, body.id)
      if (one === null || one.state !== 'asked') return no(UNKNOWN)
      const { key, nonce } = body
      // A reveal that does not open the commitment ends the exchange: it is not tried twice.
      if (!isGrantKey(key) || !isGrantNonce(nonce) || (await commitmentOf(key, nonce)) !== one.commit) {
        live.delete(one.id)
        deps.record('set-up refused: the device did not keep its word', who)
        return no('That did not match what this device sent first. Start again.')
      }
      if (one.state !== 'asked') return no(UNKNOWN)
      one.phoneKey = key
      one.phoneNonce = nonce
      one.words = wordsOfGrant(await grantDigest(one))
      one.state = 'waiting'
      one.until = now() + GRANT_WAIT_MS
      deps.record('asked to set up unlock', who)
      changed()
      askAtTheMac(one)
      return { ok: true }
    },

    async status(who, id) {
      sweep()
      const one = mine(who, id)
      if (one === null) return no(UNKNOWN)
      if (one.state === 'asked') return no(UNKNOWN)
      if (one.state !== 'allowed') return { ok: true, state: one.state, ...(one.by ? { by: one.by } : {}) }
      try {
        const sealed = await (one.sealed as Promise<string>)
        // Handed over once: the device has it, and nothing about it stays here.
        live.delete(one.id)
        return { ok: true, state: 'allowed', sealed, ...(one.by ? { by: one.by } : {}) }
      } catch {
        live.delete(one.id)
        return no('This Mac could not seal its code for this device. Start again.')
      }
    },

    pending(approver) {
      sweep()
      return [...live.values()]
        .filter((one) => one.state === 'waiting' && one.who.key !== approver.key)
        .map((one) => ({ id: one.id, name: one.who.name, words: one.words, askedAt: one.askedAt, until: one.until }))
    },

    decide(approver, body) {
      sweep()
      if (!isRecord(body) || typeof body.id !== 'string' || typeof body.allow !== 'boolean') return no('That request could not be read.')
      const one = live.get(body.id)
      if (one === undefined || one.state !== 'waiting') return no('That set-up is no longer waiting.')
      if (one.who.key === approver.key) return no('A device cannot approve itself.')
      settle(one, body.allow, approver.name)
      return { ok: true }
    },

    waiting() {
      sweep()
      return [...live.values()].filter((one) => one.state === 'waiting').length
    }
  }
}
