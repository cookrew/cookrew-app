import {
  decodeFrame,
  encodeFrame,
  isDoorPath,
  type RelayFrame,
  type StreamId
} from '../shared/relay-frame'

/**
 * THE DOOR SIDE OF THE RELAY.
 *
 * A laptop cannot be dialled from outside, so it dials out and holds the line
 * open; a caller's request arrives backwards down it. This turns those frames
 * back into the request the door already knows how to answer, and streams the
 * answer back.
 *
 * IT ADDS NO AUTHORITY. Every relayed request goes through the SAME handler
 * that answers on the LAN, so the sign-in, the 402, the session mint and the
 * sandbox are unchanged and unaware. The relay cannot admit anyone; it can
 * only carry the asking. That is the property that makes this safe to add to
 * a gate that was reviewed without it.
 *
 * WHAT IT REFUSES, and this is the whole containment: only the door's own
 * paths (relay-frame.isDoorPath), and only under the slug this door was
 * published as. Without either, a connection meant to expose one team would
 * expose the owner's entire mobile API — every terminal in every workspace —
 * to anyone who could reach the relay.
 */

/** The socket, reduced to what this needs. Structural so a test needs no network. */
export interface RelaySocket {
  send(data: string): void
  close(): void
  onMessage(listener: (data: string) => void): void
  onClose(listener: () => void): void
}

/** One relayed exchange, as the door answers it. */
export interface RelayResponse {
  status: number
  headers: Record<string, string>
  /** Whole-body answers. Absent for a stream. */
  body?: string
  /**
   * A stream (the line). Called with a writer; resolves when the door is done.
   * The returned function is invoked if the CALLER goes away first.
   */
  stream?: (write: (chunk: string) => void, done: () => void) => () => void
}

export interface RelayDoorDeps {
  /** The slug this door is published as. Prepended to every relayed path. */
  slug: string
  /**
   * Answer one request, exactly as the LAN listener would. The relay never
   * inspects the result beyond moving it.
   */
  handle(input: {
    method: string
    path: string
    headers: Record<string, string>
    body: string
  }): Promise<RelayResponse>
  /**
   * THE SEAL, and the reason this is a parameter rather than a default.
   *
   * These frames are plaintext. Inside the door's own process that is fine;
   * on cookrew.dev it is not, because the product already promises "Cookrew
   * never sends your conversation anywhere else". Slice 2 puts an end-to-end
   * channel between the caller and the door — both of which are Cookrew — and
   * the relay keeps working unchanged while carrying bytes it cannot read.
   *
   * Until then `sealed` is false and this client refuses any relay that is not
   * loopback, so the transport cannot be pointed at a public host by
   * configuration alone and quietly break the claim.
   */
  sealed?: boolean
  log?: (message: string) => void
}

/** Is this relay one where plaintext frames stay on this machine? */
function isLoopbackRelay(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase()
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]'
  } catch {
    return false
  }
}

export class RelayRefused extends Error {}

/**
 * Attach a door to a relay socket. Returns a detach function.
 *
 * `relayUrl` is passed only so the seal guard can judge it — this does not
 * dial; the caller supplies an already-open socket, which is what lets the
 * whole protocol be tested without a network.
 */
export function attachDoorToRelay(
  socket: RelaySocket,
  relayUrl: string,
  deps: RelayDoorDeps
): () => void {
  if (deps.sealed !== true && !isLoopbackRelay(relayUrl)) {
    throw new RelayRefused(
      'refusing to relay through a remote host without an end-to-end sealed channel'
    )
  }
  const log = deps.log ?? ((): void => undefined)
  /** Request bodies still arriving, and stream cancels for answers going out. */
  const pendingBody = new Map<StreamId, string>()
  const cancels = new Map<StreamId, () => void>()
  let closed = false

  const send = (frame: RelayFrame): void => {
    if (closed) return
    socket.send(encodeFrame(frame))
  }

  const abort = (id: StreamId, reason: string): void => {
    pendingBody.delete(id)
    cancels.get(id)?.()
    cancels.delete(id)
    send({ t: 'abort', id, reason })
  }

  const answer = async (
    id: StreamId,
    method: string,
    path: string,
    headers: Record<string, string>,
    body: string
  ): Promise<void> => {
    let result: RelayResponse
    try {
      result = await deps.handle({ method, path: `/${deps.slug}${path}`, headers, body })
    } catch (error) {
      // The door failing is OURS, and it must not take the connection with it:
      // one bad request would otherwise drop every other caller on this door.
      log(`relay: handling ${method} ${path} failed: ${String(error)}`)
      abort(id, 'door-error')
      return
    }
    send({ t: 'head', id, status: result.status, headers: result.headers })
    if (result.stream) {
      const cancel = result.stream(
        (chunk) => send({ t: 'chunk', id, data: chunk }),
        () => {
          cancels.delete(id)
          send({ t: 'end', id })
        }
      )
      cancels.set(id, cancel)
      return
    }
    if (result.body) send({ t: 'chunk', id, data: result.body })
    send({ t: 'end', id })
  }

  socket.onMessage((raw) => {
    const frame = decodeFrame(raw)
    // An unparseable message is not a frame and gets no answer: replying to
    // one would tell whoever sent it that something is listening.
    if (!frame) return
    switch (frame.t) {
      case 'open': {
        if (!isDoorPath(frame.path)) {
          // The containment, said out loud in the log because a relay that
          // started asking for other paths is worth noticing.
          log(`relay: refused a path outside the door: ${frame.path}`)
          abort(frame.id, 'not-a-door-path')
          return
        }
        pendingBody.set(frame.id, '')
        // A body-less request answers immediately; anything with a body waits
        // for its `done`. GET is the common case and must not wait.
        if (frame.method === 'GET' || frame.method === 'HEAD') {
          pendingBody.delete(frame.id)
          void answer(frame.id, frame.method, frame.path, frame.headers, '')
        } else {
          openRequests.set(frame.id, frame)
        }
        return
      }
      case 'body': {
        const open = openRequests.get(frame.id)
        const so_far = pendingBody.get(frame.id)
        if (!open || so_far === undefined) return
        const next = so_far + frame.data
        if (next.length > MAX_BODY) {
          abort(frame.id, 'body-too-large')
          openRequests.delete(frame.id)
          return
        }
        pendingBody.set(frame.id, next)
        if (frame.done) {
          openRequests.delete(frame.id)
          pendingBody.delete(frame.id)
          void answer(frame.id, open.method, open.path, open.headers, next)
        }
        return
      }
      case 'end':
      case 'abort': {
        // The CALLER hung up. Stop the stream we are feeding them, which is
        // how closing a card stops the line rather than leaking it.
        cancels.get(frame.id)?.()
        cancels.delete(frame.id)
        openRequests.delete(frame.id)
        pendingBody.delete(frame.id)
        return
      }
      default:
        return
    }
  })

  const openRequests = new Map<StreamId, Extract<RelayFrame, { t: 'open' }>>()

  socket.onClose(() => {
    closed = true
    for (const cancel of cancels.values()) cancel()
    cancels.clear()
    openRequests.clear()
    pendingBody.clear()
  })

  return () => {
    closed = true
    for (const cancel of cancels.values()) cancel()
    cancels.clear()
    socket.close()
  }
}

/** A relayed request body is a small JSON post; the line's payload is a stream. */
const MAX_BODY = 256 * 1024
