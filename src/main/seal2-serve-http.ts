import type { BridgeCall, BridgeDialer, BridgeResponse } from './canvas-bridge'
import { BRIDGE_BODY_MAX, loggedPath } from './canvas-bridge'
import { bodiless } from './http-compress'
import { ATTACH_UPLOAD_MS, isAttachUpload, SEALED_ATTACH_BUDGET, SEALED_ATTACH_MAX } from './attachments'
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
  /** Fixed for every request when set (tests); otherwise by route: an attachment gets the save cap and ten minutes. */
  readonly bodyMs?: number
  readonly bodyMax?: number
  /** The session's (sealBudget); an attachment's bytes count against it while they arrive. */
  readonly budget?: SealBudget
}

/**
 * What a request may send, by route. The sealed relay carries a body as many
 * small POSTs (seal2/http-link.ts · UP_BATCH), and it is streamed on to the
 * companion as it comes, so the relay's 4 MB is not a limit here for the one
 * route that takes megabytes: an attachment (2026-11-24, a phone's video was
 * refused `body-too-large` at 4 MB, sealed).
 */
export const sealBodyLimits = (method: string, path: string): { readonly max: number; readonly ms: number; readonly budgeted: boolean } =>
  isAttachUpload(method, path)
    ? { max: SEALED_ATTACH_MAX, ms: ATTACH_UPLOAD_MS, budgeted: true }
    : { max: BRIDGE_BODY_MAX, ms: SEAL2_BODY_MS, budgeted: false }

/**
 * THE ATTACHMENT BYTES ONE SESSION MAY HAVE ARRIVING AT ONCE. Credit paces the
 * line, not the companion's memory: what is written to the loopback request is
 * held by the attach route until the body ends. Without this a session's 64
 * streams could each bring an attachment's worth. One per session.
 */
export interface SealBudget {
  /** Count `bytes` more against the session; false, counting nothing, when that would pass its budget. */
  take(bytes: number): boolean
  give(bytes: number): void
}

export const sealBudget = (limit: number = SEALED_ATTACH_BUDGET): SealBudget => {
  let held = 0
  return {
    take: (bytes) => {
      if (held + bytes > limit) return false
      held += bytes
      return true
    },
    give: (bytes) => {
      held = Math.max(0, held - bytes)
    }
  }
}

async function pumpRequest(
  stream: Seal2Stream,
  call: BridgeCall,
  max: number,
  budget: SealBudget | null,
  fail: (code: number, reason: string) => void
): Promise<void> {
  const reader = stream.readable.getReader()
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return call.end()
      if (size + value.length > max) return fail(ABORT.tooLarge, 'body-too-large')
      if (budget && !budget.take(value.length)) return fail(ABORT.busy, 'busy')
      size += value.length
      call.write(Buffer.from(value.buffer, value.byteOffset, value.byteLength))
    }
  } finally {
    // Arrived or not, the route has it or it is gone: the session may take another.
    budget?.give(size)
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
  const limits = sealBodyLimits(request.method, request.path)
  const timer = setTimeout(() => fail(ABORT.timeout, 'body-timed-out'), deps.bodyMs ?? limits.ms)
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
  void pumpRequest(stream, call, deps.bodyMax ?? limits.max, limits.budgeted ? (deps.budget ?? null) : null, fail)
    .then(() => clearTimeout(timer))
    .catch(() => fail(ABORT.cancel, 'the request body stopped'))
}
