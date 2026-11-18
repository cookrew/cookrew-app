// A replaced code is followed only to the code the Mac vouched for (path/seal-next-code.ts, seal2/successor.ts).
import { describe, expect, it } from 'vitest'
import { connectCodeId, newConnectCode, replacedKeyOf } from '../src/shared/canvas-seal'
import { proveSuccessor } from '../src/shared/seal2/successor'
import { SealRefusedError } from '../src/renderer/src/path/seal-client'
import { vouchedNextCode } from '../src/renderer/src/path/seal-next-code'
import { memoryStorage } from './support/memory-storage'

const encoded = (code: Uint8Array): string => Buffer.from(code).toString('base64url')

async function setup() {
  const old = newConnectCode()
  const next = newConnectCode()
  const e = 'hello-e-of-this-try'
  const successor = await proveSuccessor(await replacedKeyOf(old), await connectCodeId(old), await connectCodeId(next), e)
  const storage = memoryStorage()
  return { old, next, successor, storage, e }
}

describe('the code waiting beside a replaced one', () => {
  it('is taken when the Mac named it, and only then', async () => {
    const { old, next, successor, storage, e } = await setup()
    storage.setItem('cr_code:m.next', encoded(next))
    expect(await vouchedNextCode(storage, 'cr_code:m', encoded(old), new SealRefusedError('replaced', successor, e))).toBe(encoded(next))
    expect(storage.getItem('cr_code:m.next')).toBeNull()
  })

  it('is not taken for another code, a bare refusal, a missing or forged proof', async () => {
    const { old, successor, storage, e } = await setup()
    storage.setItem('cr_code:m.next', encoded(newConnectCode()))
    expect(await vouchedNextCode(storage, 'cr_code:m', encoded(old), new SealRefusedError('replaced', successor, e))).toBeNull()
    expect(await vouchedNextCode(storage, 'cr_code:m', encoded(old), new SealRefusedError('code', successor, e))).toBeNull()
    expect(await vouchedNextCode(storage, 'cr_code:m', encoded(old), new SealRefusedError('replaced'))).toBeNull()
    expect(await vouchedNextCode(storage, 'cr_code:m', encoded(old), new SealRefusedError('replaced', Buffer.alloc(32, 1).toString('base64url'), e))).toBeNull()
    expect(storage.getItem('cr_code:m.next')).not.toBeNull()
  })

  it('a proof made for one hello is no proof for another: a stale one cannot be played back later', async () => {
    const { old, next, successor, storage, e } = await setup()
    storage.setItem('cr_code:m.next', encoded(next))
    // The same proof, offered against a later hello (another fresh key): refused.
    expect(await vouchedNextCode(storage, 'cr_code:m', encoded(old), new SealRefusedError('replaced', successor, `${e}-later`))).toBeNull()
    expect(await vouchedNextCode(storage, 'cr_code:m', encoded(old), new SealRefusedError('replaced', successor))).toBeNull()
    expect(storage.getItem('cr_code:m.next')).toBe(encoded(next))
  })
})
