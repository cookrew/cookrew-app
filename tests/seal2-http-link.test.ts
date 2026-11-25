// THE CARRIER'S UP SIDE (seal2/http-link.ts) over a slow line. Owner 2026-11-25:
// "sealed之后整体反应变得卡顿". One POST at a time made every record sealed while
// a POST was on the line wait for its whole round trip: a request's last record
// left one round trip late, so every sealed request cost two round trips to the
// relay where a plain one costs one (tests/perf/sealed-latency.perf.ts).
//
// Several POSTs at once must not cost the relay more than that: a record that
// carries no request or answer (ack, credit, ping) never opens a POST of its own
// while one is on the line, the bytes on the line are capped, and nothing goes
// past what the Mac's inbox holds out of order (SEAL_WINDOW).
import { randomBytes } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { createRecordReader, SEAL_WINDOW } from '../src/shared/canvas-seal-wire'
import { readBody, sealedFetch } from '../src/shared/seal2/http'
import { runSeal2Link, type Seal2Link, UP_BYTES_IN_FLIGHT, UP_IN_FLIGHT, UP_SEQ_SPAN } from '../src/shared/seal2/http-link'
import { createSeal2Session } from '../src/shared/seal2/records'
import { farLine, slowLine } from './support/seal2-slow-line'

const session = () => createSeal2Session('s-test', randomBytes(32), randomBytes(32), 'toResponder')
const settle = (ms = 30): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const seqsOf = (body: Uint8Array): number[] => createRecordReader().push(body).map((record) => record.seq)
const url = (path: string): string => `https://relay.test${path}`
const quietly = (promise: Promise<unknown>): void => void promise.catch(() => undefined)
const get = (link: Seal2Link, path: string): void => quietly(sealedFetch(link.connection, { method: 'GET', path }))

/** A request body of many small chunks: one record each. */
const chunked = (count: number, size = 4, pause: (n: number) => number = () => 0): ReadableStream<Uint8Array> => {
  let n = 0
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (n === count) return controller.close()
      const wait = pause(n)
      if (wait > 0) await settle(wait)
      const chunk = new Uint8Array(size)
      new DataView(chunk.buffer).setUint32(0, n)
      controller.enqueue(chunk)
      n += 1
    }
  })
}

/** Answers what is on the line, round after round, until nothing new comes. */
async function answerAll(line: ReturnType<typeof slowLine>, status = 204): Promise<void> {
  for (let quiet = 0; quiet < 3; ) {
    const open = line.open()
    quiet = open.length === 0 ? quiet + 1 : 0
    for (const up of open) up.answer(status)
    await settle(10)
  }
}

const inOrderOnce = (sent: number[]): void => {
  expect(new Set(sent).size).toBe(sent.length)
  expect(sent).toEqual(Array.from({ length: sent.length }, (_, n) => n))
}

let link: Seal2Link | null = null
let farEnd: { close(): void } | null = null
afterEach(() => {
  link?.close()
  link = null
  farEnd?.close()
  farEnd = null
})

describe('the sealed carrier, sending up over a slow line', () => {
  it('a record sealed while a POST is on the line leaves at once, in a POST of its own', async () => {
    const line = slowLine()
    link = runSeal2Link({ url, fetchFn: line.fetchFn, retryMs: 20 }, session())
    get(link, '/api/a')
    await settle()
    const first = line.ups.length
    expect(first).toBeGreaterThanOrEqual(1)
    get(link, '/api/a2')
    await settle()
    // The first POST is still unanswered: what was sealed after it is already on its way.
    expect(line.ups.length).toBeGreaterThan(first)
    inOrderOnce(line.ups.flatMap((up) => seqsOf(up.body)))
    for (const up of line.ups) up.answer(204)
  })

  it('a POST the line lost goes again as the same bytes, while the others are not held back', async () => {
    const line = slowLine()
    link = runSeal2Link({ url, fetchFn: line.fetchFn, retryMs: 20 }, session())
    get(link, '/api/b')
    await settle()
    get(link, '/api/b2')
    await settle()
    const [first, ...rest] = line.ups
    expect(rest.length).toBeGreaterThan(0)
    const firstSeqs = seqsOf(first.body)
    for (const up of rest) up.answer(204)
    first.answer(502)
    await settle(120)
    const again = line.ups.slice(rest.length + 1).find((up) => seqsOf(up.body)[0] === firstSeqs[0])
    expect(again).toBeDefined()
    expect(Buffer.from(again!.body).equals(Buffer.from(first.body))).toBe(true)
    // Only the lost one went again.
    expect(line.ups.slice(rest.length + 1).every((up) => seqsOf(up.body)[0] === firstSeqs[0])).toBe(true)
    await answerAll(line)
  })

  it('"ahead" is slow down, not a failure: the same bytes go again however often it is said', async () => {
    const line = slowLine()
    link = runSeal2Link({ url, fetchFn: line.fetchFn, retryMs: 5 }, session())
    get(link, '/api/ahead')
    await settle()
    get(link, '/api/ahead2')
    await settle()
    const first = line.ups[0]
    const second = line.ups[1]
    second.answer(204)
    // Past UP_TRIES (6): a 409 never counts as a try.
    for (let round = 0, at = first; round < 9; round += 1) {
      const seen = line.ups.length
      at.answer(409)
      for (let wait = 0; wait < 40 && line.ups.length === seen; wait += 1) await settle(5)
      expect(line.ups.length).toBe(seen + 1)
      at = line.ups[line.ups.length - 1]
      expect(Buffer.from(at.body).equals(Buffer.from(first.body))).toBe(true)
    }
    expect(link.connection.closed).toBe(false)
    await answerAll(line)
    expect(link.connection.closed).toBe(false)
  })

  it.each([404, 400])('after a %i nothing more goes up: not what was waiting, not a retry of the rest', async (status) => {
    const line = slowLine()
    link = runSeal2Link({ url, fetchFn: line.fetchFn, retryMs: 20 }, session())
    for (let n = 0; n < UP_IN_FLIGHT + 2; n += 1) {
      get(link, `/api/q-${n}`)
      await settle(15)
    }
    // The line is full: two requests wait their turn.
    expect(line.ups.length).toBe(UP_IN_FLIGHT)
    line.ups[0].answer(status)
    await settle(60)
    expect(link.connection.closed).toBe(true)
    expect(line.ups.length).toBe(UP_IN_FLIGHT)
    for (const up of line.open()) up.answer(502)
    await settle(150)
    expect(line.ups.length).toBe(UP_IN_FLIGHT)
  })
})

describe('what the carrier costs the relay', () => {
  it('a control-only record rides the next POST, and opens one only when none is on the line', async () => {
    const line = slowLine()
    link = runSeal2Link({ url, fetchFn: line.fetchFn, retryMs: 20 }, session())
    link.connection.ping()
    await settle()
    // Nothing was on the line: it goes.
    expect(line.ups.length).toBe(1)
    for (let n = 0; n < 4; n += 1) {
      link.connection.ping()
      await settle(10)
    }
    // A POST is on the line: they wait for it, however far apart they were sealed.
    expect(line.ups.length).toBe(1)
    line.ups[0].answer(204)
    await settle()
    // ...and then leave together.
    expect(line.ups.length).toBe(2)
    expect(seqsOf(line.ups[1].body)).toEqual([1, 2, 3, 4])
    link.connection.ping()
    await settle(10)
    get(link, '/api/c')
    await settle()
    // A request does not wait: it opens a POST of its own and takes the ping ahead of it.
    expect(line.ups.length).toBe(3)
    expect(seqsOf(line.ups[2].body).slice(0, 2)).toEqual([5, 6])
    inOrderOnce(line.ups.flatMap((up) => seqsOf(up.body)))
    await answerAll(line)
  })

  it('a streamed download over a slow line costs about one up-POST per round trip, as one at a time did', async () => {
    const oneWay = 50
    const chunk = new Uint8Array(16 * 1024).fill(3)
    const far = await farLine({
      oneWayMs: oneWay,
      onStream: (stream) => {
        stream.respond(200, {})
        void (async () => {
          const writer = stream.writable.getWriter()
          for (const until = Date.now() + 2_500; Date.now() < until; ) {
            await writer.write(chunk)
            await settle(10)
          }
          await writer.close()
        })().catch(() => undefined)
      }
    })
    farEnd = far
    link = runSeal2Link({ url, fetchFn: far.fetchFn, retryMs: 20 }, far.session)
    const started = Date.now()
    const answer = await sealedFetch(link.connection, { method: 'GET', path: '/api/download' })
    const body = await readBody(answer.body)
    const roundTrips = (Date.now() - started) / (2 * oneWay)
    // Acks every 20 ms and credit every 64 KB, while the answer streams: each a POST of its own was ~5 per round trip.
    expect(body.length).toBeGreaterThan(1024 * 1024)
    expect(far.posts()).toBeLessThanOrEqual(Math.ceil(roundTrips) + 2)
    expect(far.statuses.every((status) => status === 204)).toBe(true)
  }, 15_000)

  it('never has more than UP_BYTES_IN_FLIGHT on the line, however much is sealed', async () => {
    const line = slowLine()
    link = runSeal2Link({ url, fetchFn: line.fetchFn, retryMs: 20 }, session())
    // Four uploads of a stream window each: 4 MiB sealed, nothing answered.
    for (let n = 0; n < 4; n += 1) quietly(sealedFetch(link.connection, { method: 'POST', path: `/api/up-${n}`, body: new Uint8Array(1024 * 1024 - 64).fill(n) }))
    await settle(300)
    const onTheLine = (): number => line.open().reduce((sum, up) => sum + up.body.length, 0)
    expect(onTheLine()).toBeLessThanOrEqual(UP_BYTES_IN_FLIGHT)
    expect(onTheLine()).toBeGreaterThan(UP_BYTES_IN_FLIGHT / 2)
    const before = line.ups.length
    // Answered oldest first until room opens: how the records were batched depends on timing (under load a
    // small POST can come first, and answering it frees too little for the next 1 MiB), so no one answer is
    // promised to let another go. The cap holds at every step, and something does go.
    for (let step = 0; line.ups.length <= before && line.open().length > 0 && step < 16; step += 1) {
      line.open()[0].answer(204)
      for (const deadline = Date.now() + 1000; line.ups.length <= before && Date.now() < deadline; ) await settle(20)
      expect(onTheLine()).toBeLessThanOrEqual(UP_BYTES_IN_FLIGHT)
    }
    expect(line.ups.length).toBeGreaterThan(before)
    await answerAll(line)
    inOrderOnce(line.ups.flatMap((up) => seqsOf(up.body)))
  })

  it('never sends a record past the span the Mac holds out of order, counted from the oldest POST not yet answered', async () => {
    expect(UP_SEQ_SPAN).toBeLessThan(SEAL_WINDOW)
    const line = slowLine()
    link = runSeal2Link({ url, fetchFn: line.fetchFn, retryMs: 20 }, session())
    // One stream, thousands of tiny records: far past the span, well under every byte limit.
    quietly(sealedFetch(link.connection, { method: 'POST', path: '/api/tiny', body: chunked(2_000) }))
    await settle(150)
    expect(line.ups.length).toBeGreaterThanOrEqual(1)
    expect(line.ups.length).toBeLessThanOrEqual(UP_IN_FLIGHT)
    // Every POST but the first is answered, again and again: the first still holds the span.
    const first = line.ups[0]
    for (let quiet = 0; quiet < 3; ) {
      const open = line.open().filter((up) => up !== first)
      quiet = open.length === 0 ? quiet + 1 : 0
      for (const up of open) up.answer(204)
      await settle(15)
    }
    const sent = line.ups.flatMap((up) => seqsOf(up.body))
    expect(Math.max(...sent)).toBe(UP_SEQ_SPAN - 1)
    // Once the oldest is answered the rest follows, in order and each record once.
    first.answer(204)
    await answerAll(line)
    const all = line.ups.flatMap((up) => seqsOf(up.body))
    expect(Math.max(...all)).toBeGreaterThan(2_000)
    inOrderOnce(all)
  })

  it('POSTs that overtake each other reach the real inbox whole, and the body arrives in order', async () => {
    let got: Uint8Array | null = null
    const far = await farLine({
      oneWayMs: 5,
      // Every other POST is slow, so the one after it arrives first.
      upDelayMs: (n) => (n % 2 === 0 ? 60 : 5),
      onStream: (stream) => {
        void (async () => {
          got = await readBody(stream.readable)
          stream.respond(200, {})
          await stream.writable.getWriter().close()
        })().catch(() => undefined)
      }
    })
    farEnd = far
    link = runSeal2Link({ url, fetchFn: far.fetchFn, retryMs: 20 }, far.session)
    const answer = await sealedFetch(link.connection, { method: 'POST', path: '/api/upload', body: chunked(300, 4, (n) => (n % 10 === 0 ? 6 : 0)) })
    await readBody(answer.body)
    expect(answer.status).toBe(200)
    expect(far.overtakes()).toBeGreaterThan(0)
    expect(far.statuses.every((status) => status === 204)).toBe(true)
    const view = new DataView(got!.buffer, got!.byteOffset, got!.byteLength)
    expect(got!.length).toBe(300 * 4)
    expect(Array.from({ length: 300 }, (_, n) => view.getUint32(n * 4))).toEqual(Array.from({ length: 300 }, (_, n) => n))
  }, 15_000)
})
