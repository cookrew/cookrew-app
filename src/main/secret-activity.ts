/**
 * WHAT A SECRET'S ACTIVITY SAYS, AND WHEN IT SPEAKS (owner 2026-11-05: no rule
 * per agent; "activity and a notification are enough").
 *
 * Any agent of the owner's may read a sealed secret. What it cannot do is read
 * one quietly: every read, ask, seal and delete is a row in Activity and a
 * toast, and an owner away from the window gets a system notification. Names
 * only; a value never reaches any of these.
 *
 * The read and the ask are audited at the CLI (secret-cli.ts), where the caller
 * is known. A seal and a delete are audited here, at the doors a person uses,
 * and not inside the store: the scrub reads every value every few seconds, and
 * that is not activity.
 */

import type { SecretsStore } from './secrets-store'

export type SecretActivityType = 'secret.read' | 'secret.requested' | 'secret.sealed' | 'secret.removed'

/** Who changed the store: the door the owner came through. */
export type SecretSource = 'This Mac' | 'Phone'

export interface SecretChange {
  readonly type: 'secret.sealed' | 'secret.removed'
  readonly name: string
  readonly source: SecretSource
}

/** The store as one door sees it: a write that took is told, and nothing else changes. */
export function withSecretActivity(store: SecretsStore, source: SecretSource, record: (change: SecretChange) => void): SecretsStore {
  return {
    ...store,
    put: (name, value, options) => {
      const row = store.put(name, value, options)
      record({ type: 'secret.sealed', name, source })
      return row
    },
    remove: (name) => {
      const removed = store.remove(name)
      if (removed) record({ type: 'secret.removed', name, source })
      return removed
    }
  }
}

const SAID: Record<SecretActivityType, string> = {
  'secret.read': 'read',
  'secret.requested': 'asked for',
  'secret.sealed': 'sealed',
  'secret.removed': 'deleted'
}

/** The system notification's sentence. */
export const secretNotice = (type: SecretActivityType, who: string, name: string): string => `${who} ${SAID[type]} the secret ${name}`

/**
 * An agent running a build reads its key on every step. Activity keeps each row;
 * the notification says it once, then waits this long for the same agent, the
 * same act and the same name.
 */
export const NOTICE_QUIET_MS = 5 * 60_000

export interface NoticeGate {
  (key: string): boolean
  size: () => number
}

/** True when this key may speak now. Keys past their quiet go, so it holds only the recent ones. */
export function noticeGate(now: () => number = Date.now): NoticeGate {
  const said = new Map<string, number>()
  const gate = (key: string): boolean => {
    const at = now()
    for (const [held, when] of said) if (at - when >= NOTICE_QUIET_MS) said.delete(held)
    if (said.has(key)) return false
    said.set(key, at)
    return true
  }
  return Object.assign(gate, { size: () => said.size })
}
