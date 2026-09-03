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
  /**
   * THE DOOR'S SEAL KEY — required for `relay`, absent otherwise.
   *
   * A caller pins this on import and every byte it sends is sealed to it, so
   * the relay carrying the conversation cannot read it. That makes this the
   * one field a registry must publish faithfully and can never usefully
   * change: substituting its own key produces a channel the real door cannot
   * read, and the call fails at the first frame instead of succeeding as a man
   * in the middle. Public by nature — it is the half meant to be handed out.
   */
  sealKey?: string
  /**
   * THE FACE — what the owner chose to say about the team, bounded.
   *
   * A sentence, a few tags, and the harness NAMES behind the door (never the
   * roster: names of products, not names of agents). All optional, all
   * recorded verbatim, all the market has to search and show. The registry
   * never writes any of them.
   */
  summary?: string
  tags?: readonly string[]
  harnesses?: readonly string[]
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
 * A RELAYED DOOR'S ADDRESS IS ITS NAME, and that is a privacy rule rather than
 * a formatting one.
 *
 * The owner's app is on a laptop behind a router. Recording where it actually
 * is would publish their home network's address in a public directory, to be
 * read by anyone who lists doors — for a machine nobody can dial anyway. So a
 * relayed door records the relay's own URL, and it must be exactly the one
 * this door's handle and name produce: nothing else about the owner is here to
 * leak.
 */
export function validRelayAddress(value: string, handle: string, name: string): boolean {
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol)) return false
    if (url.username || url.password || url.search || url.hash) return false
    return url.pathname === doorPath(handle, name)
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

function validFace(input: DoorInput, allowPrivate: boolean): boolean {
  // The body is a stranger's JSON cast to this shape: every field is checked
  // for TYPE before it is checked for value, or `.trim()` on a number throws.
  if (typeof input.title !== 'string' || typeof input.door !== 'string') return false
  if (typeof input.address !== 'string' || typeof input.transport !== 'string') return false
  if (!Array.isArray(input.rails)) return false
  if (input.priceUsd !== undefined && typeof input.priceUsd !== 'string') return false
  if (!(input.transport in DOOR_REACH)) return false
  // A relayed door without a seal key is a door a caller cannot pin, and an
  // unpinned relayed door is one the relay could impersonate. Refused rather
  // than listed as something callers would then have to trust blindly.
  if (input.transport === 'relay' && !isSealKey(input.sealKey)) return false
  // A private address cannot be reached by "anyone", and a listing that said
  // so would be handing out a link that fails for everyone it was shared with.
  if (!allowPrivate && input.transport !== 'lan' && isPrivateAddress(input.address)) return false
  if (input.title.trim().length === 0 || input.title.length > 64) return false
  if (input.door.trim().length === 0 || input.door.length > 64) return false
  if (!Number.isInteger(input.agents) || input.agents < 0 || input.agents > 999) return false
  if (input.access !== 'account' && input.access !== 'paid') return false
  if (input.access === 'paid' && !/^\d+(\.\d{1,2})?$/.test(input.priceUsd ?? '')) return false
  if (!validFaceWords(input)) return false
  return input.rails.every((rail) => rail === 'x402' || rail === 'stripe')
}

const TAG = /^[a-z0-9](?:[a-z0-9-]{0,22}[a-z0-9])?$/
const PLAIN = /^[^\p{Cc}]*$/u

/**
 * The optional words on a face. Absent is fine; present means bounded: one
 * summary of at most 160 characters with no control characters, at most five
 * tags in slug shape, at most eight harness names of at most 32 characters.
 */
function validFaceWords(input: DoorInput): boolean {
  if (input.summary !== undefined) {
    if (typeof input.summary !== 'string' || input.summary.length > 160 || !PLAIN.test(input.summary)) return false
  }
  if (input.tags !== undefined) {
    if (!Array.isArray(input.tags) || input.tags.length > 5) return false
    if (!input.tags.every((tag) => typeof tag === 'string' && TAG.test(tag))) return false
  }
  if (input.harnesses !== undefined) {
    if (!Array.isArray(input.harnesses) || input.harnesses.length > 8) return false
    if (
      !input.harnesses.every(
        (h) => typeof h === 'string' && h.trim().length > 0 && h.length <= 32 && PLAIN.test(h)
      )
    )
      return false
  }
  return true
}

/**
 * A published X25519 key, as base64url SPKI. Shape only — the registry cannot
 * and should not judge whether it is the RIGHT key; that is the caller's pin.
 */
function isSealKey(value: unknown): boolean {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{40,120}$/.test(value)
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
  private readonly allowPrivate: boolean
  private doors = new Map<string, DoorRecord>()

  /**
   * `allowPrivate` lists doors whose address only this machine can reach.
   *
   * It exists because a development registry runs on localhost, and a relay on
   * localhost genuinely is not reachable by "anyone" — so the honesty rule
   * below correctly refuses it, and correctly makes the whole path untestable
   * without an escape. This is the same distinction the server already draws
   * with `dev`: a deployment either was started for development or it was not,
   * and this is never a runtime toggle.
   */
  constructor(dataDir: string, options: { allowPrivate?: boolean } = {}) {
    this.allowPrivate = options.allowPrivate === true
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
    const addressed =
      input.transport === 'relay'
        ? validRelayAddress(input.address, input.handle, input.name)
        : validDoorAddress(input.address)
    if (!addressed) return { ok: false, reason: 'bad-address' }
    if (!validFace(input, this.allowPrivate)) return { ok: false, reason: 'bad-face' }
    const door: DoorRecord = {
      handle: input.handle,
      name: input.name,
      title: input.title,
      door: input.door,
      agents: input.agents,
      address: input.address,
      transport: input.transport,
      access: input.access,
      ...(input.priceUsd === undefined ? {} : { priceUsd: input.priceUsd }),
      rails: [...input.rails],
      ...(input.sealKey === undefined ? {} : { sealKey: input.sealKey }),
      ...(input.summary === undefined ? {} : { summary: input.summary.trim() }),
      ...(input.tags === undefined ? {} : { tags: [...input.tags] }),
      ...(input.harnesses === undefined ? {} : { harnesses: input.harnesses.map((h) => h.trim()) }),
      seenAt: Date.now()
    }
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
          : [door.title, door.handle, door.name, door.door, door.summary ?? '', ...(door.tags ?? []), ...(door.harnesses ?? [])]
              .join(' ')
              .toLowerCase()
              .includes(needle)
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
