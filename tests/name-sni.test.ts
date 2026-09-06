import { X509Certificate } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { createNameSni } from '../src/main/name-sni'
import { NameCertStore } from '../src/main/name-cert-store'
import { DEFAULT_NAME_ZONE, wildcardFor } from '../src/shared/reach-names'
import { issueLeaf, makeCa } from './support/x509-forge'

const MAC = '3f2b9c14-7a55-4d2e-9d0f-1c8e6b4a7f30'
const WILDCARD = wildcardFor(MAC) as string
const DAY = 24 * 60 * 60 * 1000
const ca = makeCa()
const bases: string[] = []
afterAll(() => bases.forEach((base) => rmSync(base, { recursive: true, force: true })))

const storeWithChain = (notAfter = new Date(Date.now() + 90 * DAY)): NameCertStore => {
  const base = mkdtempSync(path.join(tmpdir(), 'cookrew-sni-'))
  bases.push(base)
  const store = new NameCertStore(base)
  const chain = issueLeaf({
    ca,
    spki: Buffer.from(store.publicKey().export({ type: 'spki', format: 'der' })),
    names: [WILDCARD],
    serial: 3,
    notBefore: new Date(Date.now() - DAY),
    notAfter
  })
  expect(store.save(chain, WILDCARD)).not.toBeNull()
  return store
}

/** `SNICallback` as a promise, so a test can read what it chose. */
const ask = (
  sni: ReturnType<typeof createNameSni>,
  servername: string
): Promise<unknown> =>
  new Promise((resolve, reject) =>
    sni(servername, (error, context) => (error ? reject(error) : resolve(context)))
  )

describe('which certificate a handshake gets', () => {
  const held = (store: NameCertStore): ReturnType<typeof createNameSni> =>
    createNameSni({
      held: () => store.held(WILDCARD),
      naming: () => ({ deviceId: MAC, zone: DEFAULT_NAME_ZONE })
    })

  it('answers the trusted chain for a label under this Mac’s wildcard', async () => {
    const sni = held(storeWithChain())
    expect(await ask(sni, `192-168-2-40.${MAC}.${DEFAULT_NAME_ZONE}`)).toBeDefined()
    expect(await ask(sni, `100-101-102-103.${MAC}.${DEFAULT_NAME_ZONE}`)).toBeDefined()
    expect(await ask(sni, `FD7A-115C-A1E0--1234.${MAC}.${DEFAULT_NAME_ZONE}`.toUpperCase())).toBeDefined()
  })

  it('leaves an IP, localhost and the tailnet name on the self-signed default', async () => {
    const sni = held(storeWithChain())
    for (const name of [
      '192.168.2.40',
      'localhost',
      'mac.tail1234.ts.net',
      'cookrew.dev',
      `${MAC}.${DEFAULT_NAME_ZONE}`,
      // A wildcard covers one label; two is not this certificate's name.
      `a.b.${MAC}.${DEFAULT_NAME_ZONE}`,
      // Another Mac's names, and a lookalike zone.
      `192-168-2-40.someone-elses-device.${DEFAULT_NAME_ZONE}`,
      `192-168-2-40.${MAC}.evil.example`
    ]) {
      expect(await ask(sni, name), name).toBeUndefined()
    }
  })

  it('falls back to the default when nothing is held or there is no account', async () => {
    const empty = mkdtempSync(path.join(tmpdir(), 'cookrew-sni-'))
    bases.push(empty)
    const nothing = new NameCertStore(empty)
    const sni = createNameSni({
      held: () => nothing.held(WILDCARD),
      naming: () => ({ deviceId: MAC, zone: DEFAULT_NAME_ZONE })
    })
    expect(await ask(sni, `192-168-2-40.${MAC}.${DEFAULT_NAME_ZONE}`)).toBeUndefined()

    const store = storeWithChain()
    const anonymous = createNameSni({ held: () => store.held(WILDCARD), naming: () => null })
    expect(await ask(anonymous, `192-168-2-40.${MAC}.${DEFAULT_NAME_ZONE}`)).toBeUndefined()
  })

  it('picks up a renewed chain without a restart', async () => {
    const store = storeWithChain(new Date(Date.now() + 10 * DAY))
    const sni = held(store)
    const name = `192-168-2-40.${MAC}.${DEFAULT_NAME_ZONE}`
    const first = await ask(sni, name)
    expect(first).toBeDefined()
    const before = store.held(WILDCARD)?.notAfter ?? 0

    const renewed = issueLeaf({
      ca,
      spki: Buffer.from(store.publicKey().export({ type: 'spki', format: 'der' })),
      names: [WILDCARD],
      serial: 4,
      notBefore: new Date(Date.now() - DAY),
      notAfter: new Date(Date.now() + 90 * DAY)
    })
    expect(store.save(renewed, WILDCARD)).not.toBeNull()
    expect(store.held(WILDCARD)?.notAfter).toBeGreaterThan(before)
    // A NEW context, built from the new chain — not the cached one.
    const second = await ask(sni, name)
    expect(second).toBeDefined()
    expect(second).not.toBe(first)
    expect(new X509Certificate(store.held(WILDCARD)?.chain ?? '').subjectAltName).toContain(WILDCARD)
  })

  it('serves the default rather than refusing when the chain will not load', async () => {
    const sni = createNameSni({
      held: () => ({ key: 'not a key', chain: 'not a chain', notAfter: Date.now() + DAY, wildcard: WILDCARD }),
      naming: () => ({ deviceId: MAC, zone: DEFAULT_NAME_ZONE }),
      log: () => undefined
    })
    expect(await ask(sni, `192-168-2-40.${MAC}.${DEFAULT_NAME_ZONE}`)).toBeUndefined()
  })
})
