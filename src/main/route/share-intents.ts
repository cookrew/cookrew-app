import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs'
import path from 'node:path'

/**
 * KEYS BEING MADE, WRITTEN DOWN FIRST (key recovery v1, agreed with Relay).
 *
 * Before `magpie gateway-key add` runs, the name it will be given is written to
 * disk and synced: `device-<slug>--<32 hex>`, 128 random bits no person or other
 * program picks. If Cookrew dies, or Magpie answers badly, between the add and
 * the key being handed over, the next run finds the name here. Any key Magpie
 * lists under that name is ours beyond doubt, so all of them can be revoked by id.
 *
 * An intent is never cleared by itself: Magpie may still be making the key (an
 * add that outlived Cookrew). It warns until the owner clears it, which is only
 * allowed after one revoke pass left no key of that name and one process check
 * found no add of that name still running (share-keys.ts · resolve, clear).
 *
 * The file holds names and times, never a key.
 */

export const INTENT_NAME_RE = /^device-[a-z0-9][a-z0-9-]{0,31}--[0-9a-f]{32}$/
export const INTENT_FILE = 'share-intents.json'

export interface ShareIntent {
  readonly name: string
  readonly device: string
  readonly at: string
  /** The last revoke pass: when, and how many keys of the name were still listed after it. */
  readonly revoked?: { readonly at: string; readonly left: number }
  /** The last process check: when, and how many adds of the name were still running. */
  readonly checked?: { readonly at: string; readonly live: number }
}

export interface IntentStore {
  /** Throws when the record cannot be read: an unreadable record is not an empty one. */
  read(): readonly ShareIntent[]
  /** Durable before it returns; throws when it is not. */
  write(intents: readonly ShareIntent[]): void
}

const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0

function stamp(value: unknown, field: 'left' | 'live'): { at: string; left?: number; live?: number } | undefined | null {
  if (value === undefined) return undefined
  const v = value as Record<string, unknown> | null
  if (typeof v !== 'object' || v === null || typeof v.at !== 'string' || !isCount(v[field])) return null
  return { at: v.at, [field]: v[field] }
}

function parseIntent(raw: unknown): ShareIntent {
  const r = raw as Record<string, unknown> | null
  if (typeof r !== 'object' || r === null) throw new Error('A key record is not an object.')
  const { name, device, at } = r
  if (typeof name !== 'string' || !INTENT_NAME_RE.test(name)) throw new Error('A key record has no usable name.')
  if (typeof device !== 'string' || name.slice('device-'.length, name.lastIndexOf('--')) !== device) throw new Error('A key record names the wrong device.')
  if (typeof at !== 'string') throw new Error('A key record has no time.')
  const revoked = stamp(r.revoked, 'left')
  const checked = stamp(r.checked, 'live')
  if (revoked === null || checked === null) throw new Error('A key record has a broken check.')
  return {
    name,
    device,
    at,
    ...(revoked ? { revoked: { at: revoked.at, left: revoked.left as number } } : {}),
    ...(checked ? { checked: { at: checked.at, live: checked.live as number } } : {})
  }
}

export function parseIntents(text: string): ShareIntent[] {
  const parsed = JSON.parse(text) as { v?: unknown; intents?: unknown }
  if (parsed?.v !== 1 || !Array.isArray(parsed.intents)) throw new Error('The record of keys being made is not readable.')
  return parsed.intents.map(parseIntent)
}

/** Write, sync, rename, sync the folder: once this returns, a crash cannot lose the record. */
function writeDurably(file: string, content: string): void {
  const dir = path.dirname(file)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const tmp = `${file}.${process.pid}.tmp`
  const fd = openSync(tmp, 'w', 0o600)
  try {
    writeSync(fd, content)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(tmp, file)
  if (process.platform === 'win32') return
  const dirFd = openSync(dir, 'r')
  try {
    fsyncSync(dirFd)
  } finally {
    closeSync(dirFd)
  }
}

export function fileIntentStore(file: string): IntentStore {
  return {
    read: () => {
      let text: string
      try {
        text = readFileSync(file, 'utf8')
      } catch (error) {
        if ((error as { code?: unknown })?.code === 'ENOENT') return []
        throw error
      }
      return parseIntents(text)
    },
    write: (intents) => writeDurably(file, `${JSON.stringify({ v: 1, intents })}\n`)
  }
}

/** For tests: the same contract, in memory. */
export function memoryIntentStore(initial: readonly ShareIntent[] = []): IntentStore {
  let held: readonly ShareIntent[] = initial.map(parseIntent)
  return {
    read: () => held,
    write: (intents) => {
      held = intents.map(parseIntent)
    }
  }
}
