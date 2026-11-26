// Fake relay lines for the sealed carrier (seal2/http-link.ts): one whose up
// POSTs wait for the test to answer them, and one with a real cookrew-seal/2
// responder (and so the real inbox, canvas-seal-wire.ts · createInbox) behind it.
import { createRecordReader } from '../../src/shared/canvas-seal-wire'
import { createSeal2Connection, type Seal2Connection, type Seal2Stream } from '../../src/shared/seal2/connection'
import { acceptCodeHandshake, startCodeHandshake } from '../../src/shared/seal2/handshake'
import type { Seal2Session } from '../../src/shared/seal2/records'

export interface Up {
  readonly body: Uint8Array
  readonly at: number
  answer(status: number): void
  answered(): boolean
}

const aborted = (): Error => new DOMException('The operation was aborted.', 'AbortError')
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** A down stream that stays open and silent until its fetch is aborted. */
const silentDown = (signal: AbortSignal | null | undefined): Response =>
  new Response(
    new ReadableStream<Uint8Array>({
      start: (controller) => signal?.addEventListener('abort', () => controller.error(aborted()), { once: true })
    }),
    { status: 200 }
  )

/** Up POSTs answered only when the test says so; an aborted POST fails as a real fetch does. */
export function slowLine() {
  const ups: Up[] = []
  const fetchFn: typeof fetch = async (input, init) => {
    const signal = init?.signal
    if (String(input).includes('/~seal/down')) return silentDown(signal)
    const body = new Uint8Array(await new Response(init?.body as BodyInit).arrayBuffer())
    return new Promise<Response>((resolve, reject) => {
      let done = false
      if (signal?.aborted) return reject(aborted())
      signal?.addEventListener('abort', () => ((done = true), reject(aborted())), { once: true })
      ups.push({
        body,
        at: Date.now(),
        answered: () => done,
        answer: (status) => {
          if (done) return
          done = true
          resolve(new Response(null, { status }))
        }
      })
    })
  }
  const open = (): Up[] => ups.filter((up) => !up.answered())
  return { ups, open, fetchFn }
}

export interface FarLineOptions {
  /** One way, each direction, for the down stream and an up POST's answer. */
  readonly oneWayMs: number
  /** How long the n-th up POST takes to reach the far end (default oneWayMs): unequal values let POSTs overtake. */
  readonly upDelayMs?: (n: number) => number
  readonly onStream: (stream: Seal2Stream) => void
}

/**
 * A slow line with the real far end behind it, as main/seal2-live.ts carries
 * it: each POST's records go to a responder connection, answered 400 / 409 /
 * 204 as the Mac does; whatever the responder sends comes down one way later.
 */
export async function farLine(options: FarLineOptions) {
  const code = new Uint8Array(32).fill(7)
  const started = await startCodeHandshake(code, { allowV1: false })
  const accepted = await acceptCodeHandshake(code, started.hello)
  const done = await started.finish(accepted?.accept)
  if (accepted === null || done === null || done.version !== 2) throw new Error('no session')
  const statuses: number[] = []
  /** The index of each POST in the order it reached the far end. */
  const arrivals: number[] = []
  let posts = 0
  let down: ReadableStreamDefaultController<Uint8Array> | null = null

  const responder: Seal2Connection = createSeal2Connection({
    session: accepted.session,
    role: 'responder',
    onStream: options.onStream,
    send: (wire) => {
      const to = down
      setTimeout(() => {
        try {
          to?.enqueue(wire)
        } catch {
          // The down stream was let go: the next one replays.
        }
      }, options.oneWayMs)
    }
  })

  const openDown = (url: string, signal: AbortSignal | null | undefined): Response => {
    const from = Number(new URL(url).searchParams.get('from') ?? 0)
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        down = controller
        for (const wire of responder.replay(from)) controller.enqueue(wire)
        signal?.addEventListener(
          'abort',
          () => {
            if (down === controller) down = null
            controller.error(aborted())
          },
          { once: true }
        )
      }
    })
    return new Response(body, { status: 200 })
  }

  const fetchFn: typeof fetch = async (input, init) => {
    const url = String(input)
    const signal = init?.signal
    if (url.includes('/~seal/down')) return openDown(url, signal)
    const index = posts
    posts += 1
    const raw = new Uint8Array(await new Response(init?.body as BodyInit).arrayBuffer())
    await sleep(options.upDelayMs?.(index) ?? options.oneWayMs)
    if (signal?.aborted) throw aborted()
    arrivals.push(index)
    const answers = await responder.receive(createRecordReader().push(raw))
    const status = answers.includes('forged') ? 400 : answers.includes('ahead') ? 409 : 204
    statuses.push(status)
    await sleep(options.oneWayMs)
    if (signal?.aborted) throw aborted()
    return new Response(null, { status })
  }

  return {
    fetchFn,
    session: done.session as Seal2Session,
    responder,
    statuses,
    posts: (): number => posts,
    /** POSTs that reached the far end before one sent earlier than them. */
    overtakes: (): number => arrivals.filter((index, at) => arrivals.slice(at + 1).some((later) => later < index)).length,
    close: (): void => responder.close('test over')
  }
}
