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

/** What a chunk is charged at the least: its object and buffer cost about this much on their own. */
const CHUNK_FLOOR = 1024

export type WholeBody = { readonly ok: true; readonly parts: readonly Uint8Array[]; readonly size: number } | { readonly ok: false; readonly code: number; readonly reason: string }

/** Bytes held in main for bodies being read: shared by every computer, so none can fill main's memory. */
export interface BodyBudget {
  take(bytes: number): boolean
  give(bytes: number): void
}

export function bodyBudget(max: number): BodyBudget & { held(): number } {
  let held = 0
  return {
    take: (bytes) => {
      if (held + bytes > max) return false
      held += bytes
      return true
    },
    give: (bytes) => {
      held = Math.max(0, held - bytes)
    },
    held: () => held
  }
}

/** The body as it came, in its own chunks (never copied whole); its bytes are taken from `budget` and stay taken until `release`. */
export async function readWholeBody(stream: Seal2Stream, max: number, ms: number, budget: BodyBudget = bodyBudget(Infinity)): Promise<WholeBody & { release(): void }> {
  let taken = 0
  const release = (): void => {
    budget.give(taken)
    taken = 0
  }
  const answer = await readInto(stream, max, ms, budget, (n) => (taken += n))
  if (!answer.ok) release()
  return { ...answer, release }
}

async function readInto(stream: Seal2Stream, max: number, ms: number, budget: BodyBudget, took: (n: number) => void): Promise<WholeBody> {
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
      // A chunk costs what it holds in memory, not only its bytes: tiny chunks must not get around the budget.
      const cost = Math.max(next.value.length, CHUNK_FLOOR)
      if (!budget.take(cost)) return { ok: false, code: ABORT.busy, reason: 'too-much-in-flight' }
      took(cost)
      parts.push(next.value)
    }
    return { ok: true, parts, size }
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
export function sendToMagpie(stream: Seal2Stream, input: { method: string; path: string; headers: Record<string, string> }, body: readonly Uint8Array[], deps: SendDeps): void {
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
  for (const part of body) call.write(Buffer.from(part.buffer, part.byteOffset, part.byteLength))
  call.end()
}
