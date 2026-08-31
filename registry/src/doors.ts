import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/**
 * A DOOR — a team someone is SERVING, as this registry knows it.
 *
 * R30 turned the marketplace from "sell a copy" into "serve a session": the
 * team stays at its author's app, a caller signs in there, pays there, and
 * gets a live session there. The registry narrows to discovery, identity and
 * payment rails — so what it lists is no longer an artifact you download but
 * an ADDRESS you can reach, plus enough of a face to decide before you go.
 *
 * WHY A SECOND OBJECT RATHER THAN A FIELD ON A PRESET. A manifest is immutable
 * content, addressed by its own hash, and its whole value is that it cannot
 * change under you. A door is the opposite: it comes and goes, moves between
 * networks, changes price, and is worth listing only while it is up. Storing
 * one as a mutable field of the other would make the immutable thing mutable,
 * which is the one property a content address exists to promise.
 *
 * WHAT THIS DOES NOT DO. It does not take money and it does not proxy calls.
 * The 401/402/403 ladder, the session mint and the sandbox all live at the
 * author's app, where the agents are; a registry that also gated would be a
 * second place to be refused, with a different answer.
 */

/**
 * HOW a door is reachable — the pluggable seam, named.
 *
 * The transport is recorded rather than inferred because it is the answer to
 * the only question an owner should ever be asked about serving: WHO CAN OPEN
 * THIS LINK. A door on a laptop's own network and a door behind a relay are
 * both "serving", and telling a person they are the same is how someone shares
 * a link that cannot possibly work for the person they sent it to.
 *
 *   lan      this network only — the address is a private one
 *   tailnet  the owner's tailnet; the caller must be on it
 *   public   the owner made it reachable themselves (their name, their cert)
 *   relay    reached through cookrew.dev, which carries the bytes
 *
 * `relay` is the one the product will hand out by default; the rest exist so
 * the ones we do not build first are not a special case when they arrive.
 */
export type DoorTransport = 'lan' | 'tailnet' | 'public' | 'relay'

/** Who a door's link actually works for. Ordered widest-last. */
export const DOOR_REACH: Record<DoorTransport, string> = {
  lan: 'People on the same network as you',
  tailnet: 'People on your tailnet',
  public: 'Anyone with the link',
  relay: 'Anyone with the link'
}

/** How a caller reaches a door, and what it costs to knock. */
export interface DoorRecord {
  /** The owner's registry handle, without the @. */
  handle: string
  /** URL-safe name of the team under that handle. */
  name: string
  /** The team's display name, as its author saved it. */
  title: string
  /** The orch a caller talks to — the door's own name. */
  door: string
  /** How many agents stand behind it. */
  agents: number
  /**
   * WHERE IT ACTUALLY IS, verbatim from the author's app: origin + slug.
   *
   * Recorded, never rewritten. A registry that edited an address would be
   * able to point a caller's payment at a door of its choosing.
   */
  address: string
  /** Which of the four ways this address became reachable. */
  transport: DoorTransport
  access: 'account' | 'paid'
  priceUsd?: string
  /** Stable rail identifiers only; no quote or config detail is stored. */
  rails: readonly ('x402' | 'stripe')[]
  /** Epoch ms of the last registration. A door nobody refreshes goes stale. */
  seenAt: number
}

/** What a registration may set. The registry owns `seenAt`, never the caller. */
export type DoorInput = Omit<DoorRecord, 'seenAt'>

export type DoorRefusal =
  | 'bad-handle'
  | 'bad-name'
  | 'bad-address'
  | 'bad-face'
  | 'not-yours'

const HANDLE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/
const NAME = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/

/**
 * A door's address, validated the way the caller's own parser validates it:
 * http(s), no credentials, no query, no hash, exactly one slug deep. The two
 * must agree, or the registry can hand out an address the app then refuses.
 */
export function validDoorAddress(value: string): boolean {
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol)) return false
    if (url.username || url.password || url.search || url.hash) return false
    const segments = url.pathname.split('/').filter(Boolean)
    return segments.length === 1 && NAME.test(segments[0])
  } catch {
    return false
  }
}

/**
 * Is this host one only the owner's own network can route to?
 *
 * Loopback, RFC1918, link-local and .local. Not a security boundary — the
 * registry stores addresses it is given — but a claim check: it is what stops
 * a door from being listed as reachable by anyone while pointing at 192.168.
 */
export function isPrivateAddress(value: string): boolean {
  let host = ''
  try {
    host = new URL(value).hostname.toLowerCase()
  } catch {
    return true
  }
  if (host === 'localhost' || host.endsWith('.local')) return true
  if (/^127\./.test(host) || host === '::1' || host === '[::1]') return true
  if (/^10\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host)) return true
  const seventeen = /^172\.(\d{1,3})\./.exec(host)
  return seventeen !== null && Number(seventeen[1]) >= 16 && Number(seventeen[1]) <= 31
}

function validFace(input: DoorInput): boolean {
  if (!(input.transport in DOOR_REACH)) return false
  // A private address cannot be reached by "anyone", and a listing that said
  // so would be handing out a link that fails for everyone it was shared with.
  if (input.transport !== 'lan' && isPrivateAddress(input.address)) return false
  if (input.title.trim().length === 0 || input.title.length > 64) return false
  if (input.door.trim().length === 0 || input.door.length > 64) return false
  if (!Number.isInteger(input.agents) || input.agents < 0 || input.agents > 999) return false
  if (input.access !== 'account' && input.access !== 'paid') return false
  if (input.access === 'paid' && !/^\d+(\.\d{1,2})?$/.test(input.priceUsd ?? '')) return false
  return input.rails.every((rail) => rail === 'x402' || rail === 'stripe')
}

/** The canonical path a door is published at — one owner, one name. */
export function doorPath(handle: string, name: string): string {
  return `/@${handle}/${name}`
}

/**
 * The doors this registry knows.
 *
 * Durable because the answer must survive a restart: a link someone shared is
 * a promise, and a directory that forgot it overnight would break every link
 * ever handed out. Written whole and renamed, so a reader never sees a torn
 * file.
 */
export class DoorStore {
  private readonly file: string
  private doors = new Map<string, DoorRecord>()

  constructor(dataDir: string) {
    this.file = path.join(dataDir, 'doors.json')
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.file, 'utf8'))
      if (Array.isArray(parsed)) {
        for (const entry of parsed as DoorRecord[]) {
          this.doors.set(doorPath(entry.handle, entry.name), entry)
        }
      }
    } catch {
      // No file is the ordinary case for a fresh registry.
    }
  }

  /**
   * Register or refresh a door.
   *
   * `handle` is not taken from the body — it is whoever the identity layer
   * says is calling. That is the whole ownership rule: a name lives under one
   * handle, and only that handle can move it.
   */
  register(caller: string, input: DoorInput): { ok: true; door: DoorRecord } | { ok: false; reason: DoorRefusal } {
    if (!HANDLE.test(caller) || !HANDLE.test(input.handle)) return { ok: false, reason: 'bad-handle' }
    if (caller !== input.handle) return { ok: false, reason: 'not-yours' }
    if (!NAME.test(input.name)) return { ok: false, reason: 'bad-name' }
    if (!validDoorAddress(input.address)) return { ok: false, reason: 'bad-address' }
    if (!validFace(input)) return { ok: false, reason: 'bad-face' }
    const door: DoorRecord = { ...input, rails: [...input.rails], seenAt: Date.now() }
    this.doors.set(doorPath(door.handle, door.name), door)
    this.flush()
    return { ok: true, door }
  }

  /** Stop listing a door. Its address keeps working — this is a listing, not a lock. */
  withdraw(caller: string, name: string): boolean {
    const key = doorPath(caller, name)
    const existing = this.doors.get(key)
    if (!existing || existing.handle !== caller) return false
    this.doors.delete(key)
    this.flush()
    return true
  }

  get(handle: string, name: string): DoorRecord | null {
    return this.doors.get(doorPath(handle, name)) ?? null
  }

  /** The directory, newest refresh first. `q` matches title, handle or name. */
  list(q?: string): DoorRecord[] {
    const needle = (q ?? '').trim().toLowerCase()
    return [...this.doors.values()]
      .filter((door) =>
        needle.length === 0
          ? true
          : `${door.title} ${door.handle} ${door.name}`.toLowerCase().includes(needle)
      )
      // Newest refresh first, then by canonical path. The tiebreak is not
      // decoration: two doors registered in the same millisecond would
      // otherwise come back in whatever order the map happened to hold them,
      // so the directory would reshuffle between two reads that saw the same
      // data. A listing people share links from has to be stable.
      .sort(
        (a, b) =>
          b.seenAt - a.seenAt ||
          doorPath(a.handle, a.name).localeCompare(doorPath(b.handle, b.name))
      )
  }

  private flush(): void {
    mkdirSync(path.dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify([...this.doors.values()], null, 2), { mode: 0o600 })
    renameSync(tmp, this.file)
  }
}
