import type { BridgeDialer, BridgeResponse } from '../canvas-bridge'
import { bodiless } from '../http-compress'
import { ABORT } from '../../shared/seal2/spec'
import type { Seal2Stream } from '../../shared/seal2/stream'

/**
 * ONE SEALED MODEL REQUEST INTO MAGPIE, BODY FIRST (serve.ts).
 *
 * Magpie reads a request's whole body before it looks at the key (0.1.3935, measured
 * 2026-11-19: a held body gets no answer with a read-only, a full or a made-up key).
 * So a request let through with a key that is revoked while its body is held back
 * would reach Magpie as an unknown key, with no limit. Here the body is read whole
 * first (capped, timed), the key is checked again after that, and only then is
 * Magpie dialled, with the body in hand.
 */

export type WholeBody = { readonly ok: true; readonly body: Buffer } | { readonly ok: false; readonly code: number; readonly reason: string }

export async function readWholeBody(stream: Seal2Stream, max: number, ms: number): Promise<WholeBody> {
  const reader = stream.readable.getReader()
  const parts: Uint8Array[] = []
  let size = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<'late'>((resolve) => {
    timer = setTimeout(() => resolve('late'), ms)
  })
  try {
    for (;;) {
      const next = await Promise.race([reader.read(), late])
      if (next === 'late') return { ok: false, code: ABORT.timeout, reason: 'body-timed-out' }
      if (next.done) break
      size += next.value.length
      if (size > max) return { ok: false, code: ABORT.tooLarge, reason: 'body-too-large' }
      parts.push(next.value)
    }
    return { ok: true, body: Buffer.concat(parts) }
  } catch {
    return { ok: false, code: ABORT.cancel, reason: 'the request body stopped' }
  } finally {
    clearTimeout(timer)
  }
}

export interface SendDeps {
  readonly dial: BridgeDialer
  log(line: string): void
}

/** Dial Magpie with the whole body and carry the answer back at the pace the far reader takes it. */
export function sendToMagpie(stream: Seal2Stream, input: { method: string; path: string; headers: Record<string, string> }, body: Buffer, deps: SendDeps): void {
  let settled = false
  let call: ReturnType<BridgeDialer> | null = null
  const fail = (code: number, reason: string): void => {
    if (settled) return
    settled = true
    stream.abort(code, reason)
    call?.destroy()
  }
  void stream.closed.catch(() => fail(ABORT.cancel, 'the far end stopped'))

  const answered = (response: BridgeResponse): void => {
    if (settled) return
    try {
      stream.respond(response.status, Object.fromEntries(Object.entries(response.headers).map(([name, value]) => [name.toLowerCase(), value])))
    } catch {
      return fail(ABORT.upstream, 'unreadable-answer')
    }
    const writer = stream.writable.getWriter()
    if (bodiless(response.status)) {
      call?.destroy()
      void writer.close().then(() => void (settled = true), () => undefined)
      return
    }
    response.onData((chunk) => {
      writer.write(new Uint8Array(chunk)).catch(() => undefined)
      // Held while the far reader is behind: its credit is what lets the answer on.
      if ((writer.desiredSize ?? 1) <= 0) {
        response.pause?.()
        void writer.ready.then(() => response.resume?.()).catch(() => undefined)
      }
    })
    response.onEnd(() => {
      writer.close().then(() => void (settled = true), () => fail(ABORT.ended, 'the answer could not be finished'))
    })
  }
  const failed = (error: Error): void => {
    deps.log(`magpie remote: ${input.method} ${input.path.split('?')[0]} failed: ${error.message}`)
    fail(ABORT.upstream, 'magpie-failed')
  }
  try {
    call = deps.dial(input, answered, failed)
  } catch (error) {
    return failed(error instanceof Error ? error : new Error(String(error)))
  }
  if (body.length > 0) call.write(body)
  call.end()
}
