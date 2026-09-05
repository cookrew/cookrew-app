import { decodeFrame, encodeFrame, type RelayFrame, type StreamId } from '../../src/shared/relay-frame'

/**
 * THE RELAY, as logic — no sockets, no runtime, no deployment.
 *
 * One door holds a connection open from a laptop that cannot be dialled; many
 * callers arrive from the outside; this pairs them and copies frames. Written
 * against an abstract socket so the SAME hub runs behind a Cloudflare Durable
 * Object, a Node server, or a test with no network at all — which is how a
 * thing that will carry other people's conversations gets tested before it
 * carries any.
 *
 * WHAT IT IS NOT ALLOWED TO BE. It never inspects a payload, never answers on
 * a door's behalf, and holds no credential of either side. Every question of
 * who may call — the sign-in, the price, the owner's lending limit — is
 * answered at the door, on the author's machine. A relay that could answer
 * would be a second gate with different rules, and the first person to notice
 * would be someone who paid.
 *
 * WHAT IT CANNOT READ. The seal is an end-to-end layer between caller and door,
 * and it needed no cooperation from this file — the hub already treated every
 * payload as opaque, so sealing them changed nothing here. Headers, request
 * bodies and replies arrive encrypted and leave encrypted. What remains visible
 * is the shape of an exchange: which door, which method and path, how many
 * bytes, and when.
 */

/** The socket this hub speaks over, reduced to what it uses. */
export interface HubSocket {
  send(data: string): void
  close(): void
}

/** Why a connection was turned away. For the log; never a rendered sentence. */
export type HubRefusal = 'name-taken' | 'no-such-door' | 'bad-name' | 'id-in-use'

const NAME = /^@[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?\/[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/

export interface HubDoor {
  name: string
  socket: HubSocket
  /** Caller streams currently riding this door. */
  streams: Set<StreamId>
}

/**
 * Pairs doors with callers.
 *
 * Stream ids are assigned HERE, never accepted from a caller: two callers
 * choosing the same id would splice one person's session into another's, and
 * an id a caller controls is an id a caller can guess.
 */
export class RelayHub {
  private readonly doors = new Map<string, HubDoor>()
  /** streamId → the caller waiting on it, and which door it rides. */
  private readonly callers = new Map<
    StreamId,
    { socket: HubSocket; door: string; theirId: StreamId }
  >()
  /**
   * Each caller's own ids, translated.
   *
   * A caller opens an exchange before it can know what the hub will call it, so
   * it labels the exchange itself and the hub answers under that label. The id
   * that reaches the DOOR is still the hub's, which is what keeps two callers
   * from ever naming the same stream — and it means a caller never learns an id
   * belonging to anyone else, so there is nothing to guess at.
   */
  private readonly theirIds = new WeakMap<HubSocket, Map<StreamId, StreamId>>()
  private nextId = 1

  constructor(private readonly log: (message: string) => void = () => undefined) {}

  /**
   * A door arrives and claims its name.
   *
   * One name, one connection: a second claim is REFUSED rather than taking
   * over, because a takeover is how someone who learns a name steals the
   * traffic meant for it. The rightful owner reconnecting after a drop is the
   * same shape as that theft, so the door must drop its old connection first —
   * and it does, since a laptop that lost the line has no old connection.
   */
  openDoor(name: string, socket: HubSocket): { ok: true; door: HubDoor } | { ok: false; reason: HubRefusal } {
    if (!NAME.test(name)) return { ok: false, reason: 'bad-name' }
    if (this.doors.has(name)) return { ok: false, reason: 'name-taken' }
    const door: HubDoor = { name, socket, streams: new Set() }
    this.doors.set(name, door)
    socket.send(encodeFrame({ t: 'ready', name }))
    return { ok: true, door }
  }

  /** A door's connection dropped: every caller on it is told, not left hanging. */
  closeDoor(name: string): void {
    const door = this.doors.get(name)
    if (!door) return
    for (const id of door.streams) {
      const caller = this.callers.get(id)
      if (!caller) continue
      caller.socket.send(encodeFrame({ t: 'abort', id: caller.theirId, reason: 'door-gone' }))
      caller.socket.close()
      this.theirIds.get(caller.socket)?.delete(caller.theirId)
      this.callers.delete(id)
    }
    this.doors.delete(name)
  }

  /**
   * A caller opens one exchange against a door. Returns the assigned id, or a
   * refusal — a name nobody is serving answers the same as a name that never
   * existed, so the hub cannot be used to enumerate who is online.
   */
  openStream(
    name: string,
    caller: HubSocket,
    request: { method: string; path: string; headers: Record<string, string> },
    theirId?: StreamId
  ): { ok: true; id: StreamId } | { ok: false; reason: HubRefusal } {
    const door = this.doors.get(name)
    if (!door) return { ok: false, reason: 'no-such-door' }
    const id = `s${this.nextId++}`
    const mine = theirId ?? id
    let owned = this.theirIds.get(caller)
    if (!owned) {
      owned = new Map()
      this.theirIds.set(caller, owned)
    }
    // Reusing a label it already has open would leave the caller unable to tell
    // its own two exchanges apart. Refuse rather than pick one.
    if (owned.has(mine)) return { ok: false, reason: 'id-in-use' }
    owned.set(mine, id)
    this.callers.set(id, { socket: caller, door: name, theirId: mine })
    door.streams.add(id)
    door.socket.send(
      encodeFrame({ t: 'open', id, method: request.method, path: request.path, headers: request.headers })
    )
    return { ok: true, id }
  }

  /**
   * A frame from the CALLER side, forwarded to its door.
   *
   * The id is rewritten from the hub's own table rather than trusted: a caller
   * naming someone else's stream is the one move that would let two sessions
   * touch, and it is refused by not being possible — a caller may only speak
   * about ids this hub handed it.
   */
  fromCaller(theirId: StreamId, socket: HubSocket, raw: string): void {
    const id = this.theirIds.get(socket)?.get(theirId)
    const entry = id === undefined ? undefined : this.callers.get(id)
    if (id === undefined || !entry || entry.socket !== socket) {
      this.log(`relay: a caller spoke about a stream that is not theirs (${theirId})`)
      return
    }
    const frame = decodeFrame(raw)
    if (!frame) return
    if (frame.t !== 'body' && frame.t !== 'end' && frame.t !== 'abort') return
    const door = this.doors.get(entry.door)
    if (!door) return
    door.socket.send(encodeFrame({ ...frame, id }))
    if (frame.t === 'end' || frame.t === 'abort') this.endStream(id)
  }

  /** A frame from the DOOR, forwarded to the one caller waiting on that id. */
  fromDoor(name: string, raw: string): void {
    const frame = decodeFrame(raw)
    if (!frame || frame.t === 'ready' || frame.t === 'open' || frame.t === 'ping' || frame.t === 'pong') return
    const entry = this.callers.get(frame.id)
    // A door answering a stream it was never given is not routed anywhere.
    if (!entry || entry.door !== name) return
    entry.socket.send(encodeFrame({ ...frame, id: entry.theirId }))
    if (frame.t === 'end' || frame.t === 'abort') this.endStream(frame.id)
  }

  /** A caller went away mid-exchange: tell the door so it stops the stream. */
  closeCaller(id: StreamId): void {
    const entry = this.callers.get(id)
    if (!entry) return
    this.doors.get(entry.door)?.socket.send(encodeFrame({ t: 'end', id }))
    this.endStream(id)
  }

  private endStream(id: StreamId): void {
    const entry = this.callers.get(id)
    if (!entry) return
    this.doors.get(entry.door)?.streams.delete(id)
    this.theirIds.get(entry.socket)?.delete(entry.theirId)
    this.callers.delete(id)
  }

  /** For the health page and the tests: what is currently carried. */
  stats(): { doors: number; streams: number } {
    return { doors: this.doors.size, streams: this.callers.size }
  }

  has(name: string): boolean {
    return this.doors.has(name)
  }
}

/** Re-exported so an adapter needs one import to speak the wire. */
export type { RelayFrame }
