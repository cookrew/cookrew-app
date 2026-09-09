import { describe, expect, it } from 'vitest'
import { acceptSeal, generateSealKeyPair, openBody, openRequest } from '../src/shared/relay-seal'
import '../registry/assets/seal.js'

/**
 * THE BROWSER'S SEAL MATCHES THE DOOR'S — byte for byte.
 *
 * seal.js is the caller half of src/shared/relay-seal.ts written in WebCrypto
 * for the team page. The only thing that makes it correct is that the door,
 * running the Node implementation, can open what it packs and it can open
 * what the door seals back. So this test is the door: it runs the page's
 * script under Node's WebCrypto and answers with relay-seal.ts.
 */

type Seal = {
  seal(doorKeySpki: string, info: string): Promise<{
    pack(headers: Record<string, string>, body: string): Promise<{ headers: Record<string, string>; body: string }>
    finish(doorEphemeralSpki: string): Promise<{ open(sealed: string, at: number): Promise<string | null> }>
  }>
}
const CookrewSeal = (globalThis as unknown as { CookrewSeal: Seal }).CookrewSeal
const INFO = '@drej/cookrew-alpha'

describe('the page seals what the door can open', () => {
  it('headers and body, sealed to the long-term key, open at the door', async () => {
    const door = generateSealKeyPair()
    const caller = await CookrewSeal.seal(door.publicKey, INFO)
    const packed = await caller.pack({ authorization: 'Bearer t', accept: 'text/event-stream' }, '{"registryToken":"x"}')
    expect(Object.keys(packed.headers).sort()).toEqual(['x-seal-e', 'x-seal-h', 'x-seal-k'])
    const opened = openRequest(door.privateKey, INFO, packed.headers)
    expect(opened?.headers).toEqual({ authorization: 'Bearer t', accept: 'text/event-stream' })
    expect(openBody(door.privateKey, INFO, packed.body)).toBe('{"registryToken":"x"}')
    // An empty body is still a sealed body — the door never waits on nothing.
    const empty = await caller.pack({}, '')
    expect(openBody(door.privateKey, INFO, empty.body)).toBe('')
  })

  it('and opens what the door seals back, head at 0 then chunks in order', async () => {
    const door = generateSealKeyPair()
    const caller = await CookrewSeal.seal(door.publicKey, INFO)
    const packed = await caller.pack({ accept: 'text/event-stream' }, '')
    const opened = openRequest(door.privateKey, INFO, packed.headers)
    expect(opened).not.toBeNull()
    const accepted = acceptSeal(door.privateKey, opened!.hello, INFO)
    const head = accepted.channel.tx.seal(JSON.stringify({ 'content-type': 'text/event-stream' }))
    const first = accepted.channel.tx.seal('event: hello\ndata: {"cols":100}\n\n')
    const second = accepted.channel.tx.seal('event: data\ndata: "❯ "\n\n')

    const rx = await caller.finish(accepted.accept.e)
    expect(await rx.open(head, 0)).toBe('{"content-type":"text/event-stream"}')
    expect(await rx.open(first, 1)).toBe('event: hello\ndata: {"cols":100}\n\n')
    expect(await rx.open(second, 2)).toBe('event: data\ndata: "❯ "\n\n')
    // Out of order, or under another exchange's channel, nothing opens.
    expect(await rx.open(second, 1)).toBeNull()
    const other = await (await CookrewSeal.seal(door.publicKey, INFO)).finish(accepted.accept.e)
    expect(await other.open(head, 0)).toBeNull()
  })

  it('a different door name is a different secret', async () => {
    const door = generateSealKeyPair()
    const caller = await CookrewSeal.seal(door.publicKey, '@mira/growth-desk')
    const packed = await caller.pack({ a: '1' }, 'b')
    expect(openRequest(door.privateKey, INFO, packed.headers)).toBeNull()
    expect(openBody(door.privateKey, INFO, packed.body)).toBeNull()
  })
})
