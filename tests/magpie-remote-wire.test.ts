// THE SMALL TALK WITH THE OTHER COMPUTER (wire.ts), review M2 and L1: a stream that opens and never
// answers is given up on after a deadline (so the one connect lane is never held for good), and an
// answer that says "not now" (503) is a broken stream to try again, never a refusal that drops the key.
import { describe, expect, it } from 'vitest'
import { ackKeyOver, returnKeyOver } from '../src/main/magpie-remote/wire'
import type { Seal2Stream } from '../src/shared/seal2/stream'

/** A stream that takes the request and never answers; it records being aborted. */
function silentStream(aborted: string[]): Seal2Stream {
  return {
    head: new Promise(() => undefined),
    readable: new ReadableStream(),
    writable: new WritableStream(),
    closed: new Promise(() => undefined),
    abort: (_code?: number, reason?: string) => void aborted.push(reason ?? ''),
    respond: () => undefined
  } as unknown as Seal2Stream
}

/** A stream that answers at once with this status and JSON. */
function answering(status: number, body: unknown): Seal2Stream {
  const bytes = new TextEncoder().encode(JSON.stringify(body))
  return {
    head: Promise.resolve({ status, headers: {} }),
    readable: new ReadableStream({ start: (c) => (c.enqueue(bytes), c.close()) }),
    writable: new WritableStream(),
    closed: Promise.resolve(),
    abort: () => undefined,
    respond: () => undefined
  } as unknown as Seal2Stream
}

describe('a deadline on every exchange', () => {
  it('gives up on an acknowledgement nobody answers, and aborts its stream', async () => {
    const aborted: string[] = []
    const ack = ackKeyOver(async () => silentStream(aborted), { deadlineMs: 30 })
    await expect(ack('peer', 'sk-magpie-key-xxxxxxxxxxxxxxxx', 'id1')).rejects.toThrow(/did not answer/)
    expect(aborted).toHaveLength(1)
  })

  it('gives up when the stream itself never opens', async () => {
    const ack = ackKeyOver(() => new Promise(() => undefined), { deadlineMs: 30 })
    await expect(ack('peer', 'sk-magpie-key-xxxxxxxxxxxxxxxx', 'id1')).rejects.toThrow(/did not answer/)
  })

  it('gives up on a give-back nobody answers', async () => {
    const back = returnKeyOver(async () => silentStream([]), { deadlineMs: 30 })
    await expect(back('peer')).rejects.toThrow()
  })
})

describe('what an acknowledgement answer means', () => {
  it('reads 503 (the other computer could not read its keys just now) as a broken stream, to try again', async () => {
    const ack = ackKeyOver(async () => answering(503, { ok: false, why: 'could not read its Magpie’s keys' }))
    await expect(ack('peer', 'sk-magpie-key-xxxxxxxxxxxxxxxx', 'id1')).rejects.toThrow()
  })

  it('reads 403 (the other computer switched Magpie remote off for now) as a broken stream, keeping the key', async () => {
    const ack = ackKeyOver(async () => answering(403, { ok: false, why: 'Magpie remote is switched off' }))
    await expect(ack('peer', 'sk-magpie-key-xxxxxxxxxxxxxxxx', 'id1')).rejects.toThrow(/switched off/)
  })

  it('reads 401 and 410 as a refusal, and 404 as an older Cookrew', async () => {
    for (const [status, old] of [[401, false], [410, false], [404, true]] as const) {
      const ack = ackKeyOver(async () => answering(status, { ok: false, why: 'no' }))
      expect(await ack('peer', 'sk-magpie-key-xxxxxxxxxxxxxxxx', 'id1')).toEqual({ ok: false, why: 'no', old })
    }
  })
})
