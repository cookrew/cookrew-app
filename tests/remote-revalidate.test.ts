import { describe, expect, it } from 'vitest'
import { createRemoteRevalidation } from '../src/main/remote-revalidate'

/**
 * ANOTHER MACHINE'S ANSWERS, ASKED FOR AGAIN ONLY IF THEY CHANGED (bytes 0.6.2).
 * A machine that tags its answers is asked with the tag held; its 304 hands the
 * held answer back, and nothing is read twice.
 */

/** A machine that tags its body and answers 304 to the tag it would send. */
function machine(initial: string): { body: string; asked: Record<string, string>[]; send: (headers: Record<string, string>) => Promise<Response> } {
  const state = { body: initial, asked: [] as Record<string, string>[] }
  return {
    get body() {
      return state.body
    },
    set body(next: string) {
      state.body = next
    },
    asked: state.asked,
    send: async (headers) => {
      state.asked.push(headers)
      const tag = `W/"${state.body.length}-${state.body.slice(0, 8)}"`
      if (headers['if-none-match'] === tag) return new Response(null, { status: 304, headers: { etag: tag } })
      return new Response(state.body, { status: 200, headers: { etag: tag, 'content-type': 'application/json' } })
    }
  }
}

const json = async (response: Response): Promise<unknown> => (await response.json()) as unknown

describe('a read of another machine, made again', () => {
  it('names the tag it holds, and a 304 gives back what it held without reading a byte', async () => {
    const reads = createRemoteRevalidation()
    const mac = machine('{"rev":1}')
    const first = await reads.get('m1', 'api/fleet', mac.send, json)
    expect(first).toMatchObject({ value: { rev: 1 }, reused: false })
    expect(mac.asked[0]).toEqual({})
    const second = await reads.get('m1', 'api/fleet', mac.send, json)
    expect(second).toMatchObject({ value: { rev: 1 }, reused: true })
    expect(second.response?.status).toBe(304)
    expect(mac.asked[1]['if-none-match']).toMatch(/^W\//)
  })

  it('takes a changed answer whole, and holds that one next', async () => {
    const reads = createRemoteRevalidation()
    const mac = machine('{"rev":1}')
    await reads.get('m1', 'api/fleet', mac.send, json)
    mac.body = '{"rev":22}'
    expect(await reads.get('m1', 'api/fleet', mac.send, json)).toMatchObject({ value: { rev: 22 }, reused: false })
    expect(await reads.get('m1', 'api/fleet', mac.send, json)).toMatchObject({ value: { rev: 22 }, reused: true })
  })

  it('keeps each machine and route apart', async () => {
    const reads = createRemoteRevalidation()
    const a = machine('{"a":1}')
    const b = machine('{"b":1}')
    await reads.get('m1', 'api/fleet', a.send, json)
    await reads.get('m2', 'api/fleet', b.send, json)
    await reads.get('m1', 'api/watch/cards', a.send, json)
    expect(a.asked.map((headers) => headers['if-none-match'] ?? null)).toEqual([null, null])
    expect((await reads.get('m2', 'api/fleet', b.send, json)).value).toEqual({ b: 1 })
  })

  it('holds nothing an answer did not tag, and nothing that was not a 200', async () => {
    const reads = createRemoteRevalidation()
    const untagged = async (): Promise<Response> => new Response('{"x":1}', { status: 200 })
    await reads.get('m1', 'api/fleet', untagged, json)
    expect(reads.size()).toBe(0)
    const refused = async (): Promise<Response> => new Response('{"error":"no"}', { status: 401, headers: { etag: 'W/"e"' } })
    expect(await reads.get('m1', 'api/fleet', refused, json)).toMatchObject({ value: { error: 'no' }, reused: false })
    expect(reads.size()).toBe(0)
  })

  it('a 304 with nothing held is no answer, and a machine forgotten is asked whole', async () => {
    const reads = createRemoteRevalidation()
    const lost = await reads.get('m1', 'api/fleet', async () => new Response(null, { status: 304 }), json)
    expect(lost).toMatchObject({ value: null, reused: false })
    const mac = machine('{"rev":1}')
    await reads.get('m1', 'api/fleet', mac.send, json)
    reads.forget('m1')
    await reads.get('m1', 'api/fleet', mac.send, json)
    expect(mac.asked[1]).toEqual({})
  })

  it('nothing came back is nothing', async () => {
    const reads = createRemoteRevalidation()
    expect(await reads.get('m1', 'api/fleet', async () => null, json)).toEqual({ response: null, value: null, reused: false })
  })

  it('holds a bounded number of answers, letting the least recently used go', async () => {
    const reads = createRemoteRevalidation(2)
    const mac = machine('{"rev":1}')
    await reads.get('m1', 'r1', mac.send, json)
    await reads.get('m1', 'r2', mac.send, json)
    await reads.get('m1', 'r1', mac.send, json)
    await reads.get('m1', 'r3', mac.send, json)
    expect(reads.size()).toBe(2)
    mac.asked.length = 0
    await reads.get('m1', 'r2', mac.send, json)
    expect(mac.asked[0]).toEqual({})
  })
})
