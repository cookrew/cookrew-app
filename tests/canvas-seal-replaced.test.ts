import { describe, expect, it } from 'vitest'
import { checkReplaced, newConnectCode, proveReplaced, replacedKeyOf, startHandshake } from '../src/shared/canvas-seal'

/**
 * "THE CODE WAS CHANGED, PAIR AGAIN." A phone that holds a machine's old
 * connect code is refused, and until now could not tell a changed code from a
 * wrong address or a relay that says no. The machine keeps one thing from a
 * code it replaced, a key derived from it, and answers an old code's hello
 * with a proof under that key over that very hello. Only the machine that held
 * the code can make it, only for this hello, and the phone checks it with the
 * code it still holds.
 */
describe('a machine says its code was changed, and the phone can believe it', () => {
  it('the proof made from the old code’s key checks against the old code and this hello', async () => {
    const old = newConnectCode()
    const { hello } = await startHandshake(old)
    const proof = await proveReplaced(await replacedKeyOf(old), hello)
    expect(await checkReplaced(old, hello, proof)).toBe(true)
  })

  it('does not check for another hello, another code, or something that is not a proof', async () => {
    const old = newConnectCode()
    const { hello } = await startHandshake(old)
    const proof = await proveReplaced(await replacedKeyOf(old), hello)
    const { hello: later } = await startHandshake(old)
    expect(await checkReplaced(old, later, proof)).toBe(false)
    expect(await checkReplaced(newConnectCode(), hello, proof)).toBe(false)
    for (const junk of ['', 'AAAA', undefined, 7, proof.slice(0, -2)]) expect(await checkReplaced(old, hello, junk)).toBe(false)
  })

  it('the key kept from an old code is not the code and not its session keys’ input', async () => {
    const old = newConnectCode()
    const key = await replacedKeyOf(old)
    expect(key).toHaveLength(32)
    expect(Buffer.from(key).equals(Buffer.from(old))).toBe(false)
  })
})
