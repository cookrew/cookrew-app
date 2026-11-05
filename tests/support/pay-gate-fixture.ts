import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto'
import { buildManifest, signManifest } from '../../src/main/preset-publish'
import { scrubForPublish } from '../../src/main/preset-scrub'
import type { PresetManifest, PresetPricing } from '../../src/shared/preset-manifest'
import type { TeamSnapshot } from '../../src/main/teams'
import type { CanvasNode } from '../../src/shared/model'

/**
 * What the pay-gate tests share: a software authenticator and a signed preset.
 * Every value is invented. Nothing here talks to a network.
 */

export const PAYEE = '0xA1b2C3d4E5f6789012345678901234567890aBcD'
export const ONE_TIME: PresetPricing = { model: 'one-time', amount: '12.00', asset: 'USDC' }

const b64 = (bytes: Buffer): string => bytes.toString('base64url')

/** Credentials only ever go to a registry this test started itself. */
export function loopbackOnly(url: string): string {
  const host = new URL(url).hostname
  if (host !== 'localhost' && host !== '127.0.0.1') throw new Error(`refusing to send credentials to ${url}`)
  return url
}

export function authenticator(credentialId: string, origin: string, rpId = 'localhost') {
  const keys = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const authData = Buffer.concat([
    createHash('sha256').update(rpId).digest(),
    Buffer.from([0x01]),
    Buffer.from([0, 0, 0, 1])
  ])
  return {
    credentialId,
    jwk: keys.publicKey.export({ format: 'jwk' }) as Record<string, unknown>,
    assert(challenge: string) {
      const clientData = Buffer.from(JSON.stringify({ type: 'webauthn.get', origin, challenge }), 'utf8')
      const digest = createHash('sha256').update(clientData).digest()
      return {
        credentialId,
        clientDataJSON: b64(clientData),
        authenticatorData: b64(authData),
        signature: b64(sign('sha256', Buffer.concat([authData, digest]), keys.privateKey))
      }
    }
  }
}

const terminal = (name: string): CanvasNode =>
  ({
    kind: 'terminal', id: 't1', name, preset: 'Claude Code', command: 'npm test',
    cwd: '/w', orch: false, role: null, position: { x: 0, y: 0 }, size: { width: 1, height: 1 }
  }) as CanvasNode

export function authored(
  name: string,
  version: number,
  key: KeyObject,
  pricing?: PresetPricing
): { manifest: PresetManifest; teamBytes: Buffer } {
  const snapshot: TeamSnapshot = { name, savedAt: 1, dir: '/w', nodes: [terminal(name)], connections: [], turns: {} }
  const built = buildManifest({
    scrub: scrubForPublish(snapshot),
    version,
    author: { handle: 'drej' },
    ...(pricing ? { pricing } : {})
  })
  if (!built.ok) throw new Error(`refused: ${built.reason}`)
  return { manifest: signManifest(built.manifest, key), teamBytes: built.teamBytes }
}
