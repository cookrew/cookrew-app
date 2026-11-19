import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, readFileSync } from 'node:fs'
import { writeFileAtomic } from './atomic-file'

/**
 * WHICH REMEMBERED PASSWORDS THIS MAC STILL TAKES (Remember on the console).
 *
 * A page that remembers a password keeps a box sealed to this Mac's unlock key
 * (remote-unlock.ts · REMEMBER_INFO): the password and an id this Mac issued.
 * The page never holds the password again; this Mac never holds it at all. What
 * this file keeps, per id, is who it was issued to and under which connect code,
 * so the Mac can take it back on its own:
 *
 *   rotation     the pairing rotates: every id goes (clear).
 *   Forget       a device is forgotten in Devices: its ids go (forgetWho);
 *                the page's own Forget sends its id to be dropped (drop).
 *   wrong        a box whose password no longer opens this Mac: its id goes.
 *   another code an id is taken only under the code it was issued under, so a
 *                rotation whose clear failed still refuses it.
 *
 * A file that cannot be read takes no box: the page is told the password is
 * forgotten and asks for it again, which costs a retype and nothing else.
 */

/** Ids kept at most; past it the oldest goes, and its box is asked to type again. */
export const REMEMBERED_MAX = 64
/** Ids one viewer keeps at most (a page that lost its box leaves one behind): past it, only its own oldest goes. */
export const REMEMBERED_PER_WHO = 8

export interface RememberedUnlocks {
  /** A new id for this viewer under the code in force now. */
  issue(who: string): string
  /** Is this id still taken, from this viewer, under the code in force now? */
  live(id: string, who: string): boolean
  /** Drops one id, only for the viewer it was issued to. True when it was there. */
  drop(id: string, who: string): boolean
  forgetWho(who: string): void
  clear(): void
}

export interface RememberedDeps {
  /** The connect code's id in force now (connect-code.ts · currentId). */
  currentCode(): string
  now?(): number
  /** How the file is written (atomic-file.ts by default). */
  writeFile?(file: string, text: string): void
}

interface Held {
  readonly who: string
  readonly code: string
  readonly at: number
}

type HeldFile = Readonly<Record<string, Held>>

const ID = /^[A-Za-z0-9_-]{32,64}$/

const isHeld = (value: unknown): value is Held => {
  const row = value as Partial<Held> | null
  return typeof row === 'object' && row !== null && typeof row.who === 'string' && typeof row.code === 'string' && typeof row.at === 'number'
}

function readHeld(file: string): HeldFile {
  if (!existsSync(file)) return {}
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { ids?: unknown }
    const ids = typeof parsed.ids === 'object' && parsed.ids !== null ? (parsed.ids as Record<string, unknown>) : {}
    return Object.fromEntries(Object.entries(ids).filter((entry): entry is [string, Held] => ID.test(entry[0]) && isHeld(entry[1])))
  } catch {
    return {}
  }
}

export function createRememberedUnlocks(file: string, deps: RememberedDeps): RememberedUnlocks {
  const now = deps.now ?? Date.now
  const writeFile = deps.writeFile ?? ((target: string, text: string): void => {
    writeFileAtomic(target, text)
    chmodSync(target, 0o600)
  })
  let held = readHeld(file)
  // The file first: a write that fails leaves what is held as the file says, so a restart does not bring back
  // an id this run thought was gone (and the caller hears the failure).
  const write = (next: HeldFile): void => {
    writeFile(file, `${JSON.stringify({ ids: next }, null, 2)}\n`)
    held = next
  }
  const keep = (keepIt: (entry: [string, Held]) => boolean): void => {
    const kept = Object.entries(held).filter(keepIt)
    if (kept.length !== Object.keys(held).length) write(Object.fromEntries(kept))
  }
  const has = (id: string): boolean => Object.prototype.hasOwnProperty.call(held, id)
  return {
    issue(who) {
      const id = randomBytes(24).toString('base64url')
      const oldestFirst = Object.entries(held).sort((a, b) => a[1].at - b[1].at)
      const mine = oldestFirst.filter(([, row]) => row.who === who)
      const crowded = new Set(mine.slice(0, Math.max(0, mine.length - (REMEMBERED_PER_WHO - 1))).map(([known]) => known))
      const others = oldestFirst.filter(([known]) => !crowded.has(known))
      const room = others.slice(Math.max(0, others.length - (REMEMBERED_MAX - 1)))
      write({ ...Object.fromEntries(room), [id]: { who, code: deps.currentCode(), at: now() } })
      return id
    },
    live: (id, who) => has(id) && held[id].who === who && held[id].code === deps.currentCode(),
    drop(id, who) {
      if (!has(id) || held[id].who !== who) return false
      keep(([known]) => known !== id)
      return true
    },
    forgetWho: (who) => keep(([, row]) => row.who !== who),
    clear: () => {
      if (Object.keys(held).length > 0 || existsSync(file)) write({})
    }
  }
}
