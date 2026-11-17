import { createHmac, randomBytes } from 'node:crypto'
import { encryptWebPush } from './web-push-crypto'

/**
 * PHONE PUSH, THE DESKTOP'S HALF (owner, 2026-11-16: a real background push;
 * plan docs/hitl-cross-workspace-2026-11-15 · v6.2 phase 4). The account's
 * phones subscribe on the console (cookrew.dev); the registry keeps the
 * subscriptions and the VAPID key. This desktop reads each subscription's
 * public keys (never its address), encrypts the notification for it (RFC 8291)
 * and hands the registry ciphertext to forward: the registry never reads
 * an agent's or a workspace's name.
 *
 * Every machine sends only its own agents' moments; the subscriptions are the
 * account's, so a phone hears every machine without anything aggregating.
 * Nothing here throws: a phone that cannot be told is no reason to fail a turn.
 */

/** What a phone's service worker reads (console sw.js). Names only, never a reply. */
export interface PushPayload {
  readonly v: 1
  readonly title: string
  readonly body: string
  readonly tag: string
  readonly machineId: string
  readonly workspaceId: string | null
  readonly agentId: string | null
}

export interface PushSubscriptionKeys {
  readonly id: string
  readonly p256dh: string
  readonly auth: string
}

export type Urgency = 'very-low' | 'low' | 'normal' | 'high'

export interface SendRequest {
  readonly subscription: string
  /** base64url of the aes128gcm body. */
  readonly body: string
  readonly ttl: number
  readonly urgency: Urgency
  readonly topic?: string
}

export interface PhonePushDeps {
  /** GET /v2/me/push/subscriptions; `off` when the registry has push turned off (404 push_off). */
  subscriptions: () => Promise<{ ok: true; list: readonly PushSubscriptionKeys[] } | { ok: false; off?: boolean }>
  /** POST /v2/me/push/send: 'gone' when the push service dropped the subscription (410). */
  send: (request: SendRequest) => Promise<'sent' | 'gone' | 'failed'>
  now: () => number
  /** The secret topics are keyed by; a fresh one per launch unless a test fixes it. */
  topicKey?: Buffer
}

/** How long a waiting or a reply is worth delivering to a phone that was off. */
export const PUSH_TTL_S = 3600
/** How long the subscriptions read are trusted before they are read again. */
const LIST_KEPT_MS = 10 * 60_000
/** A registry with push off is asked again this much later. */
const OFF_KEPT_MS = 30 * 60_000

/**
 * The push service's Topic for a tag: a newer push of the same topic replaces
 * an older one still queued for a phone that is off. ≤ 32 base64url chars.
 * Keyed by a secret only this desktop holds, so neither the registry nor the
 * push service can tie a topic to an agent (a plain hash of a known id could).
 * A new launch is a new key: a queued push from before it is merely not replaced.
 */
export const topicOf = (tag: string, key: Buffer): string => createHmac('sha256', key).update(tag).digest('base64url').slice(0, 32)

export function createPhonePush(deps: PhonePushDeps): { send: (payload: PushPayload, urgency: Urgency) => Promise<void> } {
  const topicKey = deps.topicKey ?? randomBytes(32)
  let list: readonly PushSubscriptionKeys[] | null = null
  let readAt = Number.NEGATIVE_INFINITY
  let offUntil = Number.NEGATIVE_INFINITY

  const current = async (): Promise<readonly PushSubscriptionKeys[]> => {
    const now = deps.now()
    if (now < offUntil) return []
    if (list !== null && now - readAt < LIST_KEPT_MS) return list
    const answer = await deps.subscriptions()
    if (!answer.ok) {
      if (answer.off) offUntil = now + OFF_KEPT_MS
      return []
    }
    list = answer.list
    readAt = now
    return list
  }

  const sealFor = (sub: PushSubscriptionKeys, words: Buffer): string | null => {
    try {
      return encryptWebPush(words, Buffer.from(sub.p256dh, 'base64url'), Buffer.from(sub.auth, 'base64url')).toString('base64url')
    } catch {
      // A subscription with broken keys: skip it, the others still hear.
      return null
    }
  }

  return {
    async send(payload, urgency) {
      try {
        const subs = await current()
        const words = Buffer.from(JSON.stringify(payload))
        const outcomes = await Promise.all(
          subs.map(async (sub) => {
            const body = sealFor(sub, words)
            if (body === null) return 'failed' as const
            return deps.send({ subscription: sub.id, body, ttl: PUSH_TTL_S, urgency, topic: topicOf(payload.tag, topicKey) })
          })
        )
        // A phone the push service has forgotten: read the list again next time.
        if (outcomes.includes('gone')) list = null
      } catch (error) {
        console.error('A phone push could not be sent:', error)
      }
    }
  }
}
