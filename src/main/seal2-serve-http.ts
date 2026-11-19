import type { BridgeCall, BridgeDialer, BridgeResponse } from './canvas-bridge'
import { BRIDGE_BODY_MAX, loggedPath } from './canvas-bridge'
import { bodiless } from './http-compress'
import { readRequest } from '../shared/seal2/http'
import { ABORT } from '../shared/seal2/spec'
import type { Seal2Stream } from '../shared/seal2/stream'

/**
 * A SEALED "http" STREAM, ANSWERED BY THIS MAC'S OWN COMPANION (spec.ts §5).
 *
 * The request becomes a loopback request the way the bridge makes one, so the
 * companion's own checks decide everything: the session proves a connection,
 * not a person, and the pairing token or machine key inside is still what is
 * asked for. Backpressure runs both ways: a body is read from the stream only
 * as the companion takes it, and an answer is paused while the far reader is
 * behind.
 */

/** How long a request may take to finish arriving. An answer may run as long as it likes. */
export const SEAL2_BODY_MS = 120_000

export interface ServeHttpDeps {
  readonly dial: BridgeDialer
  /** The headers the request goes in with, from what it asked and what the carrier said. */
  headersFor(asked: Readonly<Record<string, string>>): Record<string, string>
  log(line: string): void
  readonly bodyMs?: number
  readonly bodyMax?: number
}

async function pumpRequest(stream: Seal2Stream, call: BridgeCall, max: number, fail: (code: number, reason: string) => void): Promise<void> {
  const reader = stream.readable.getReader()
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return call.end()
    size += value.length
    if (size > max) return fail(ABORT.tooLarge, 'body-too-large')
    call.write(Buffer.from(value.buffer, value.byteOffset, value.byteLength))
  }
}

function pumpAnswer(stream: Seal2Stream, response: BridgeResponse, onDone: () => void, fail: (code: number, reason: string) => void): void {
  const writer = stream.writable.getWriter()
  response.onData((chunk) => {
    writer.write(new Uint8Array(chunk)).catch(() => undefined)
    // Held while the far reader is behind: its credit is what lets the answer on.
    if ((writer.desiredSize ?? 1) <= 0) {
      response.pause?.()
      void writer.ready.then(() => response.resume?.()).catch(() => undefined)
    }
  })
  response.onEnd(() => {
    writer.close().then(onDone, () => fail(ABORT.ended, 'the answer could not be finished'))
  })
}

export function serveHttpStream(stream: Seal2Stream, deps: ServeHttpDeps): void {
  const request = readRequest(stream.fields)
  if (request === null) return stream.abort(ABORT.refused, 'bad-request')
  let call: BridgeCall | null = null
  let settled = false
  const timer = setTimeout(() => fail(ABORT.timeout, 'body-timed-out'), deps.bodyMs ?? SEAL2_BODY_MS)
  const fail = (code: number, reason: string): void => {
    clearTimeout(timer)
    if (settled) return
    settled = true
    stream.abort(code, reason)
    call?.destroy()
  }
  const done = (): void => {
    settled = true
    clearTimeout(timer)
  }
  void stream.closed.catch(() => fail(ABORT.cancel, 'the far end stopped'))

  const answered = (response: BridgeResponse): void => {
    if (settled) return
    try {
      stream.respond(response.status, Object.fromEntries(Object.entries(response.headers).map(([name, value]) => [name.toLowerCase(), value])))
    } catch {
      return fail(ABORT.upstream, 'unreadable-answer')
    }
    if (bodiless(response.status)) {
      void stream.writable.close().then(done, () => undefined)
      call?.destroy()
      return
    }
    pumpAnswer(stream, response, done, fail)
  }
  const failed = (error: Error): void => {
    deps.log(`seal2: ${request.method} ${loggedPath(request.path)} failed: ${error.message}`)
    fail(ABORT.upstream, 'companion-failed')
  }
  try {
    call = deps.dial({ method: request.method, path: request.path, headers: deps.headersFor(request.headers) }, answered, failed)
  } catch (error) {
    // Node refuses to build some requests outright: a path or a value past latin1.
    return failed(error instanceof Error ? error : new Error(String(error)))
  }
  void pumpRequest(stream, call, deps.bodyMax ?? BRIDGE_BODY_MAX, fail)
    .then(() => clearTimeout(timer))
    .catch(() => fail(ABORT.cancel, 'the request body stopped'))
}
