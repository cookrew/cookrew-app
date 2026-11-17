// THE REGISTRY MAKES ITS OWN VAPID KEY (owner, 2026-11-17: "改成自动生成，我不关心").
// Phone push needs one key pair for the life of the deployment: a new pair
// unsubscribes every phone. So it is made once, on first start, in the data
// directory (a persistent volume in production, beside token-key.jwk), and
// read back on every start after. The environment still wins when it is set.
import { createECDH } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadVapidKeys, VAPID_KEY_FILE, vapidOf, vapidPairOf } from '../registry/src/v2-push-vapid'
import { expectMode } from './support/file-mode'

const dir = (): string => mkdtempSync(path.join(tmpdir(), 'cookrew-vapid-'))

describe('the VAPID key on first start and after', () => {
  it('made on first start, valid, kept private', () => {
    const data = dir()
    const keys = loadVapidKeys({}, data)
    expect(keys).toBeDefined()
    expect(typeof vapidOf(keys!)).not.toBe('string')
    expect(keys!.subject).toBe('https://cookrew.dev')
    expectMode(path.join(data, VAPID_KEY_FILE), 0o600)
  })

  it('the same key on every start after', () => {
    const data = dir()
    const first = loadVapidKeys({}, data)
    const second = loadVapidKeys({}, data)
    expect(second).toEqual(first)
  })

  it('a key file that cannot be read turns push off and is never overwritten (a new key would unsubscribe every phone)', () => {
    const data = dir()
    writeFileSync(path.join(data, VAPID_KEY_FILE), '{broken', { mode: 0o600 })
    const said: string[] = []
    expect(loadVapidKeys({}, data, (line) => said.push(line))).toBeUndefined()
    expect(readFileSync(path.join(data, VAPID_KEY_FILE), 'utf8')).toBe('{broken')
    expect(said.join(' ')).toMatch(/push is off/)
    expect(said.join(' ')).not.toMatch(/"d"|privateKey/)
  })

  it('a key file holding a pair that does not match turns push off', () => {
    const data = dir()
    const a = loadVapidKeys({}, dir())!
    const b = loadVapidKeys({}, dir())!
    writeFileSync(path.join(data, VAPID_KEY_FILE), JSON.stringify({ publicKey: a.publicKey, privateKey: b.privateKey }), { mode: 0o600 })
    expect(loadVapidKeys({}, data)).toBeUndefined()
  })

  it('the environment wins when set, and then no file is made', () => {
    const data = dir()
    const pair = loadVapidKeys({}, dir())!
    const env = { COOKREW_VAPID_PUBLIC_KEY: pair.publicKey, COOKREW_VAPID_PRIVATE_KEY: pair.privateKey, COOKREW_VAPID_SUBJECT: 'mailto:ops@cookrew.dev' }
    expect(loadVapidKeys(env, data)).toEqual({ ...pair, subject: 'mailto:ops@cookrew.dev' })
    expect(existsSync(path.join(data, VAPID_KEY_FILE))).toBe(false)
  })

  it('half a pair in the environment is a mistake: push off, no file made behind its back', () => {
    const data = dir()
    expect(loadVapidKeys({ COOKREW_VAPID_PUBLIC_KEY: 'x' }, data)).toBeUndefined()
    expect(existsSync(path.join(data, VAPID_KEY_FILE))).toBe(false)
  })

  it('the subject from the environment applies to a made key too', () => {
    expect(loadVapidKeys({ COOKREW_VAPID_SUBJECT: 'mailto:ops@cookrew.dev' }, dir())!.subject).toBe('mailto:ops@cookrew.dev')
  })
})

// ECDH.getPrivateKey() drops leading zero bytes, so about one fresh pair in 256
// came out with a 31-byte private key, failed the 32-byte check, and was kept on
// disk forever with push off (CI main c972436d, macOS).
// A fixed scalar whose top byte is zero, handed back short the way ECDH does.
const shortScalarPair = (): { getPublicKey(): Buffer; getPrivateKey(): Buffer } => {
  const full = Buffer.concat([Buffer.from([0]), Buffer.alloc(31, 0x5a)])
  const pair = createECDH('prime256v1')
  pair.setPrivateKey(full)
  const publicKey = pair.getPublicKey()
  return { getPublicKey: () => publicKey, getPrivateKey: () => full.subarray(1) }
}

describe('a private key whose top byte is zero', () => {
  it('is made as a full 32-byte key that signs', () => {
    const made = vapidPairOf(shortScalarPair())
    expect(Buffer.from(made.privateKey, 'base64url').byteLength).toBe(32)
    expect(typeof vapidOf({ ...made, subject: 'https://cookrew.dev' })).not.toBe('string')
  })

  it('already stored short is read back as the same key, so no phone is unsubscribed', () => {
    const pair = shortScalarPair()
    const stored = { publicKey: pair.getPublicKey().toString('base64url'), privateKey: pair.getPrivateKey().toString('base64url') }
    const data = dir()
    writeFileSync(path.join(data, VAPID_KEY_FILE), JSON.stringify(stored), { mode: 0o600 })
    const keys = loadVapidKeys({}, data)
    expect(keys?.publicKey).toBe(stored.publicKey)
    expect(Buffer.from(keys!.privateKey, 'base64url').byteLength).toBe(32)
    expect(typeof vapidOf(keys!)).not.toBe('string')
    expect(readFileSync(path.join(data, VAPID_KEY_FILE), 'utf8')).toBe(JSON.stringify(stored))
  })
})
