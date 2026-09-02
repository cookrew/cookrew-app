import {
  decodeFrame,
  encodeFrame,
  type RelayFrame,
  type StreamId
} from '../shared/relay-frame'
import {
  packBody,
  packRequest,
  startSeal,
  SEAL_EPHEMERAL,
  SEAL_HEADERS,
  type SealPublicKey,
  type SealedPair
} from '../shared/relay-seal'

/**
 * THE CALLER SIDE OF THE RELAY.
 *
 * The same requests a caller already makes to a door on the LAN, addressed to a
 * door that cannot be dialled. The gate answers them unchanged at the other
 * end; nothing here decides anything.
 *
 * NO ROUND TRIP IS ADDED ANYWHERE, and the seal is arranged around that. The
 * caller's ephemeral rides the open frame and the door's rides the head, so the
 * handshake happens inside traffic that was going to happen. Nothing waits.
 *
 * The reply channel that comes out of it is forward-secret. The request
 * direction is not: a body cannot wait for the door's ephemeral without adding
 * a round trip to every prompt, so it is sealed to the door's long-term key
 * instead. That asymmetry is written down where it is paid, in relay-seal.
 */

/** The socket to the relay. Structural, so a test needs no network. */
export interface CallerTransport {
  send(data: string): void
  close(): void
  onMessage(listener: (data: string) => void): void
  onClose(listener: () => void): void
}

export interface RelayAnswer {
  status: number
  headers: Record<string, string>
  body: string
}

/** A live exchange. `close` tells the door to stop producing. */
export interface RelayStream {
  close(): void
}

interface Pending {
  /** Opens what the door sends back. Null until the door's head arrives. */
  seal: SealedPair | null
  finishSeal: ((accept: { e: SealPublicKey }) => SealedPair) | null
  /** The sequence we expect next, so a replayed frame cannot land. */
  rx: number
  head?: { status: number; headers: Record<string, string> }
  chunks: string[]
  /** Characters held in `chunks` so far, against MAX_HELD_CHARS. */
  held: number
  onHead?: (status: number, headers: Record<string, string>) => void
  onChunk?: (chunk: string) => void
  settle?: (answer: RelayAnswer) => void
  fail?: (error: Error) => void
}

export class RelayCallFailed extends Error {}

/** The most a buffered (non-streaming) relayed answer may hold. */
const MAX_HELD_CHARS = 8 * 1024 * 1024

/**
 * A caller's connection to one door through the relay.
 *
 * `doorKey` is the door's published seal key, pinned when the team was imported
 * — the same trust-on-first-use rule the sign-in already follows. A relay that
 * substituted its own key would produce a channel the real door cannot read, so
 * a man in the middle fails at the first frame instead of succeeding quietly.
 */
export class RelayCaller {
  private readonly pending = new Map<StreamId, Pending>()
  private nextLocal = 1
  private closed = false

  constructor(
    private readonly transport: CallerTransport,
    private readonly doorName: string,
    private readonly doorKey: SealPublicKey
  ) {
    transport.onMessage((raw) => this.receive(raw))
    transport.onClose(() => this.giveUp('the relay connection closed'))
  }

  /** One request, answered whole. The face, the ceremony, an ask. */
  request(
    method: string,
    path: string,
    headers: Record<string, string>,
    body = ''
  ): Promise<RelayAnswer> {
    return new Promise((resolve, reject) => {
      this.begin(method, path, headers, body, { settle: resolve, fail: reject })
    })
  }

  /**
   * A live stream — the line. `onChunk` fires as bytes arrive, never batched:
   * the terminal is the thing a person is watching.
   */
  stream(
    method: string,
    path: string,
    headers: Record<string, string>,
    onHead: (status: number, headers: Record<string, string>) => void,
    onChunk: (chunk: string) => void,
    onFail?: (error: Error) => void
  ): RelayStream | null {
    const id = this.begin(method, path, headers, '', {
      onHead,
      onChunk,
      fail: (error) => onFail?.(error)
    })
    if (id === null) return null
    return {
      close: () => {
        this.send({ t: 'end', id })
        this.pending.delete(id)
      }
    }
  }

  close(): void {
    this.giveUp('the caller hung up')
    this.closed = true
    this.transport.close()
  }

  private giveUp(reason: string): void {
    this.closed = true
    for (const [, entry] of this.pending) entry.fail?.(new RelayCallFailed(reason))
    this.pending.clear()
  }

  /**
   * Start an exchange.
   *
   * The hooks are in place BEFORE the open frame goes out, because a transport
   * may deliver synchronously — a door that refuses on sight answers inside
   * this very call, and a caller that had not finished wiring itself up would
   * wait forever for a reply that already came.
   */
  private begin(
    method: string,
    path: string,
    headers: Record<string, string>,
    body: string,
    hooks: Pick<Pending, 'onHead' | 'onChunk' | 'settle' | 'fail'>
  ): StreamId | null {
    if (this.closed) {
      hooks.fail?.(new RelayCallFailed('the relay connection is closed'))
      return null
    }
    // The label is ours. The relay answers under it and assigns its own id
    // toward the door, so we never see an id belonging to anybody else.
    const id = `c${this.nextLocal++}`
    let handshake: ReturnType<typeof startSeal>
    try {
      handshake = startSeal(this.doorKey, this.doorName)
    } catch {
      // A pinned key that is not a key. It came from a directory over the
      // network, so this is data — and it must fail THIS exchange rather than
      // throw out of whatever was moving bytes at the time.
      hooks.fail?.(new RelayCallFailed('this door published a key that cannot be used'))
      return null
    }
    this.pending.set(id, {
      seal: null,
      finishSeal: handshake.finish,
      rx: 0,
      chunks: [],
      held: 0,
      ...hooks
    })
    this.send({
      t: 'open',
      id,
      method,
      path,
      headers: packRequest(this.doorKey, this.doorName, handshake.hello.e, headers)
    })
    if (body.length > 0) {
      this.send({ t: 'body', id, data: packBody(this.doorKey, this.doorName, body), done: true })
    }
    return id
  }

  private send(frame: RelayFrame): void {
    if (!this.closed) this.transport.send(encodeFrame(frame))
  }

  private receive(raw: string): void {
    const frame = decodeFrame(raw)
    if (!frame || frame.t === 'ready' || frame.t === 'open' || frame.t === 'body') return
    const entry = this.pending.get(frame.id)
    if (!entry) return

    switch (frame.t) {
      case 'head':
        this.head(frame.id, entry, frame.status, frame.headers)
        return
      case 'chunk': {
        const opened = entry.seal ? entry.seal.rx.open(frame.data, entry.rx++) : null
        // A chunk that does not open is a chunk somebody changed. Passing it on
        // would render altered text as though the agent had said it, so the
        // exchange fails instead of quietly showing a lie.
        if (opened === null) {
          this.abandon(frame.id, entry, 'a relayed frame did not verify')
          return
        }
        if (entry.onChunk) entry.onChunk(opened)
        else {
          // A buffered answer has a ceiling. A stream is delivered as it comes
          // and the consumer decides; a request that waits for the whole body
          // must not be made to wait for gigabytes of it.
          entry.held += opened.length
          if (entry.held > MAX_HELD_CHARS) {
            this.abandon(frame.id, entry, 'the relayed answer is larger than a request may hold')
            return
          }
          entry.chunks.push(opened)
        }
        return
      }
      case 'end':
        entry.settle?.({
          status: entry.head?.status ?? 0,
          headers: entry.head?.headers ?? {},
          body: entry.chunks.join('')
        })
        this.pending.delete(frame.id)
        return
      case 'abort':
        // Already given up on at the other end; saying `end` back would be
        // talking about an exchange that no longer exists.
        this.abandon(frame.id, entry, frame.reason, false)
        return
      default:
        return
    }
  }

  private head(
    id: StreamId,
    entry: Pending,
    status: number,
    wire: Record<string, string>
  ): void {
    // The door's ephemeral arrives here. This is what makes the reply channel
    // forward-secret without a round trip of its own.
    const doorEphemeral = wire[SEAL_EPHEMERAL]
    if (doorEphemeral && entry.finishSeal) {
      entry.seal = entry.finishSeal({ e: doorEphemeral })
      entry.finishSeal = null
    }
    const sealedHeaders = wire[SEAL_HEADERS]
    if (!entry.seal || !sealedHeaders) {
      // An unsealed answer is the relay answering for the door, or a door that
      // does not hold the key we pinned. Either way it is not who we called.
      this.abandon(id, entry, 'the door answered without the seal')
      return
    }
    const headers = asHeaders(entry.seal.rx.open(sealedHeaders, entry.rx++))
    if (headers === null) {
      this.abandon(id, entry, 'the door’s headers did not verify')
      return
    }
    entry.head = { status, headers }
    entry.onHead?.(status, headers)
  }

  /**
   * Give up on one exchange. `tellDoor` stops the far end still producing —
   * a line that failed to verify must not keep streaming into nothing.
   */
  private abandon(id: StreamId, entry: Pending, reason: string, tellDoor = true): void {
    entry.fail?.(new RelayCallFailed(reason))
    this.pending.delete(id)
    if (tellDoor) this.send({ t: 'end', id })
  }
}

function asHeaders(value: string | null): Record<string, string> | null {
  if (value === null) return null
  try {
    const parsed: unknown = JSON.parse(value)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
    const out: Record<string, string> = {}
    for (const [key, val] of Object.entries(parsed)) {
      if (typeof val !== 'string') return null
      out[key.toLowerCase()] = val
    }
    return out
  } catch {
    return null
  }
}
