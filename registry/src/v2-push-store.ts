import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { PushSubscriptionInput } from './v2-push-check'
import type { V2Account } from './v2-accounts'
import { liveRows } from './v2-push-live'

/**
 * PHONE PUSH — WHICH BROWSERS AN ACCOUNT ASKED TO BE TOLD (HITL phase 4).
 *
 * One small file per account under `push-v2/`, written whole (a temp file,
 * then a rename) and readable by this process alone. One file per account
 * rather than one for everybody, because nothing ever reads two accounts at
 * once, and a delete is then one unlink with nothing of the name left behind.
 *
 * A TORN FILE IS NO SUBSCRIPTIONS, unlike the account and factor files that
 * refuse to boot: losing these costs a person one "Turn on notifications"
 * press, and a registry that would not start over them would cost everybody
 * every sign-in.
 *
 * EACH ROW NAMES ITS DEVICE AND ITS SIGN-IN (`dev`, `sid`): it lives as long as
 * they do (v2-push-live.ts), and `prune` takes off the rows that outlived them.
 *
 * The endpoint is a capability (whoever holds it can post to that browser), so
 * it stays here: the desktop's list carries the keys and never the endpoint,
 * and no line of the log names one.
 */

export const PUSH_DIR = 'push-v2'
export const PUSH_PER_ACCOUNT = 10
/** A username as the account store mints it; checked again here because it becomes a file name. */
const USERNAME = /^[a-z0-9-]{1,64}$/

export interface PushSubscriptionRecord extends PushSubscriptionInput {
  id: string
  createdAt: number
  /** The device that filed it. */
  dev: string
  /** The sign-in it was filed under: the session's sitting, carried across renewals. */
  sid: string
}

/** What a route files: the browser's subscription, and who filed it under which sign-in. */
export type PushFiling = PushSubscriptionInput & Pick<PushSubscriptionRecord, 'dev' | 'sid'>

const isText = (value: unknown): value is string => typeof value === 'string'

const isSubscription = (value: unknown): value is PushSubscriptionRecord => {
  if (typeof value !== 'object' || value === null) return false
  const held = value as Record<string, unknown>
  return [held.id, held.endpoint, held.p256dh, held.auth, held.label, held.dev, held.sid].every(isText) && typeof held.createdAt === 'number'
}

export class V2PushSubscriptions {
  private readonly dir: string
  private readonly now: () => number

  constructor(base: string, now: () => number = Date.now) {
    this.dir = path.join(base, PUSH_DIR)
    this.now = now
  }

  private fileOf(username: string): string {
    if (!USERNAME.test(username)) throw new Error('not a username')
    return path.join(this.dir, `${username}.json`)
  }

  /** In the order they were last written: the first is the one the cap lets go of next. */
  list(username: string): readonly PushSubscriptionRecord[] {
    const file = this.fileOf(username)
    if (!existsSync(file)) return []
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
      return Array.isArray(parsed) ? parsed.filter(isSubscription) : []
    } catch {
      return []
    }
  }

  find(username: string, id: string): PushSubscriptionRecord | null {
    return this.list(username).find((held) => held.id === id) ?? null
  }

  /** File a subscription. The same endpoint again is the same subscription, with what it says now. */
  put(username: string, input: PushFiling): PushSubscriptionRecord {
    const held = this.list(username)
    const earlier = held.find((s) => s.endpoint === input.endpoint)
    const record: PushSubscriptionRecord = {
      id: earlier?.id ?? randomBytes(16).toString('base64url'),
      endpoint: input.endpoint,
      p256dh: input.p256dh,
      auth: input.auth,
      label: input.label,
      createdAt: earlier?.createdAt ?? this.now(),
      dev: input.dev,
      sid: input.sid
    }
    const kept = [...held.filter((s) => s.endpoint !== input.endpoint), record]
    this.write(username, kept.slice(-PUSH_PER_ACCOUNT))
    return record
  }

  remove(username: string, id: string): boolean {
    const held = this.list(username)
    const kept = held.filter((s) => s.id !== id)
    if (kept.length === held.length) return false
    this.write(username, kept)
    return true
  }

  /** Take off every row whose device or sign-in has ended. Nothing is read when the account has no file. */
  prune(account: Pick<V2Account, 'username' | 'devices' | 'sessions'>): void {
    if (!USERNAME.test(account.username) || !existsSync(this.fileOf(account.username))) return
    const held = this.list(account.username)
    const kept = liveRows(held, account, this.now())
    if (kept.length !== held.length) this.write(account.username, kept)
  }

  /** The account is gone: its file goes with it. */
  forget(username: string): void {
    const file = this.fileOf(username)
    if (existsSync(file)) unlinkSync(file)
  }

  private write(username: string, records: readonly PushSubscriptionRecord[]): void {
    const file = this.fileOf(username)
    if (records.length === 0) return this.forget(username)
    mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    const temp = `${file}.${process.pid}.tmp`
    try {
      writeFileSync(temp, JSON.stringify(records), { mode: 0o600 })
      renameSync(temp, file)
    } catch (error) {
      try {
        if (existsSync(temp)) unlinkSync(temp)
      } catch {
        // A stranded temp file is not worth a throw; the rename is what matters.
      }
      throw error instanceof Error ? error : new Error(String(error))
    }
  }
}
