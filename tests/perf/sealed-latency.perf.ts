// HOW MUCH A SEALED RELAY COSTS THE PAGE, over a slow line (owner 2026-11-25:
// "sealed之后整体反应变得卡顿"). The real relay and the real carrier
// (seal2/http-link.ts), with a one-way delay on every request, answer and
// streamed chunk the phone sees, as a far relay adds. Compared with the same
// requests sent in the clear through the same relay.
import { createServer, type Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { SealTerminus } from '../../src/main/canvas-seal-terminus'
import { connectCodeId, newConnectCode } from '../../src/shared/canvas-seal'
import { startCodeHandshake } from '../../src/shared/seal2/handshake'
import { readBody, sealedFetch } from '../../src/shared/seal2/http'
import { runSeal2Link, Seal2RefusedError, shakeHandsOverHttp, type Seal2Link } from '../../src/shared/seal2/http-link'
import type { Seal2Session } from '../../src/shared/seal2/records'
import { isSealPath, loopbackDialer, routeSeal, startRelayWorld, verifyDevice, type RelayWorld } from '../support/seal2-relay-world'

/** One way, phone to relay. A relay ~650 ms away round trip is ~325 here; 150 keeps the run short. */
const ONE_WAY_MS = Number(process.env.SEAL_LAG_MS ?? 150)
const UPLOAD = Buffer.alloc(1_000_000, 7)
/** Sealed may cost this much more than plain over the same far line: the carrier's own work, not a round trip. */
const SEALED_OVER_PLAIN_MAX = 1.4

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Each chunk reaches the phone `ms` after it left the relay, in order. */
function lagged(body: ReadableStream<Uint8Array>, ms: number): ReadableStream<Uint8Array> {
  const reader = body.getReader()
  const queue: { chunk?: Uint8Array; done: boolean; due: number }[] = []
  const waiting: { wake: (() => void) | null } = { wake: null }
  void (async () => {
    for (;;) {
      const read = await reader.read().catch(() => ({ done: true as const, value: undefined }))
      queue.push({ chunk: read.value, done: read.done, due: Date.now() + ms })
      waiting.wake?.()
      if (read.done) return
    }
  })()
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      while (queue.length === 0) await new Promise<void>((resolve) => (waiting.wake = resolve))
      const head = queue.shift() as { chunk?: Uint8Array; done: boolean; due: number }
      const wait = head.due - Date.now()
      if (wait > 0) await sleep(wait)
      if (head.done) controller.close()
      else controller.enqueue(head.chunk as Uint8Array)
    },
    cancel: () => void reader.cancel().catch(() => undefined)
  })
}

/** The phone's fetch over a far line: the request arrives late, the answer and each chunk of it too. */
const far = (inner: typeof fetch, ms: number): typeof fetch => async (input, init) => {
  await sleep(ms)
  const answer = await inner(input, init)
  // The body is read from now, so its first chunk and the headers arrive together, one way later.
  const body = answer.body === null ? null : lagged(answer.body, ms)
  await sleep(ms)
  return new Response(body, { status: answer.status, headers: answer.headers })
}

const companion = (terminus: () => SealTerminus | undefined): Server =>
  createServer((request, response) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host}`)
    if (isSealPath(url.pathname)) return void routeSeal(request, response, terminus())
    request.resume()
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end('ok')
    })
  })

const code = newConnectCode()
let world: RelayWorld
let link: Seal2Link

beforeAll(async () => {
  const id = await connectCodeId(code)
  world = await startRelayWorld(companion, (port, mac) => ({
    codeFor: (asked) => (asked === id ? code : null),
    dial: loopbackDialer(port),
    device: { self: () => mac.signer, verify: verifyDevice, trusted: async () => false, admits: () => false },
    deviceHttp: () => false
  }))
  const deps = { url: (route: string) => `${world.prefix()}${route}`, fetchFn: far(world.capture(world.phoneSession), ONE_WAY_MS) }
  const started = await startCodeHandshake(code, { allowV1: false })
  const done = await shakeHandsOverHttp(deps, started, async () => new Seal2RefusedError('code', 'refused'))
  if (done.version !== 2) throw new Error('not v2')
  link = runSeal2Link(deps, done.session as Seal2Session)
  await sealedFetch(link.connection, { method: 'GET', path: '/api/warm' }).then((answer) => readBody(answer.body))
}, 60_000)

afterAll(async () => {
  link?.close()
  await world?.close()
})

const plainFetch = (): typeof fetch => far(world.capture(world.phoneSession), ONE_WAY_MS)

const sealedSmall = async (n: number): Promise<number> => {
  const start = Date.now()
  const answer = await sealedFetch(link.connection, { method: 'GET', path: `/api/small-${n}` })
  await readBody(answer.body)
  return Date.now() - start
}
const plainSmall = async (n: number): Promise<number> => {
  const start = Date.now()
  await (await plainFetch()(`${world.prefix()}/api/small-${n}`)).arrayBuffer()
  return Date.now() - start
}

const median = (values: number[]): number => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]
const report = (name: string, values: number[]): void =>
  console.log(`sealed-latency ${name} (one way ${ONE_WAY_MS} ms): median ${median(values)} ms, max ${Math.max(...values)} ms, n=${values.length}`)

describe(`a sealed relay over a far line (${ONE_WAY_MS} ms one way)`, () => {
  it('one request at a time', async () => {
    const sealed: number[] = []
    const plain: number[] = []
    for (let n = 0; n < 6; n += 1) sealed.push(await sealedSmall(n))
    for (let n = 0; n < 6; n += 1) plain.push(await plainSmall(n))
    report('one at a time, sealed', sealed)
    report('one at a time, plain', plain)
    // One relay round trip, as plain: two (the old one-POST-at-a-time carrier) is 2x.
    expect(median(sealed)).toBeLessThan(median(plain) * SEALED_OVER_PLAIN_MAX)
  }, 60_000)

  it('eight requests at once, as a page opening does', async () => {
    const sealed = await Promise.all(Array.from({ length: 8 }, (_, n) => sealedSmall(100 + n)))
    const plain = await Promise.all(Array.from({ length: 8 }, (_, n) => plainSmall(100 + n)))
    report('eight at once, sealed', sealed)
    report('eight at once, plain', plain)
    expect(median(sealed)).toBeLessThan(median(plain) * SEALED_OVER_PLAIN_MAX)
  }, 60_000)

  it('a request a moment after a 1 MB upload started', async () => {
    const upload = sealedFetch(link.connection, { method: 'POST', path: '/api/upload', body: UPLOAD }).then((answer) => readBody(answer.body))
    await sleep(20)
    const behind = await Promise.all([sealedSmall(200), sleep(ONE_WAY_MS).then(() => sealedSmall(201))])
    await upload
    report('behind an upload, sealed', behind)
    expect(Math.max(...behind)).toBeLessThan(2 * ONE_WAY_MS * SEALED_OVER_PLAIN_MAX + 100)
  }, 60_000)

  it('requests trickling in, one every 50 ms (taps and scrolls)', async () => {
    // Each lands while the ones before it are on the line: one POST at a time, each waited a round trip for the last.
    const sealed = await Promise.all(Array.from({ length: 10 }, (_, n) => sleep(n * 50).then(() => sealedSmall(300 + n))))
    const plain = await Promise.all(Array.from({ length: 10 }, (_, n) => sleep(n * 50).then(() => plainSmall(300 + n))))
    report('trickle, sealed', sealed)
    report('trickle, plain', plain)
    expect(median(sealed)).toBeLessThan(median(plain) * SEALED_OVER_PLAIN_MAX)
  }, 60_000)
})
