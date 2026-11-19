// Accounts for cookrew-seal/2 runs, with no test runner in them: the relay
// world (seal2-relay-world.ts) and the capture script both use these.
import { createPublicKey, generateKeyPairSync, randomUUID, sign, verify, type KeyObject } from 'node:crypto'
import { deviceIdFor } from '../../src/main/account-v2'
import type { DeviceKey, DeviceSigner, DeviceVerifier } from '../../src/shared/seal2/handshake'

const PASSWORD = 'correct horse battery staple'

export interface Device {
  readonly id: string
  readonly jwk: DeviceKey
  readonly signer: DeviceSigner
}

export function newDevice(): Device {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const { kty, crv, x } = publicKey.export({ format: 'jwk' }) as { kty: 'OKP'; crv: 'Ed25519'; x: string }
  const jwk: DeviceKey = { kty, crv, x }
  const id = deviceIdFor(jwk as unknown as Record<string, unknown>)
  return { id, jwk, signer: signerFor(id, jwk, privateKey) }
}

const signerFor = (deviceId: string, jwk: DeviceKey, key: KeyObject): DeviceSigner => ({
  deviceId,
  jwk,
  sign: async (message) => sign(null, Buffer.from(message), key).toString('base64url')
})

export const verifyDevice: DeviceVerifier = async (jwk, message, sig) =>
  verify(null, Buffer.from(message), createPublicKey({ key: jwk as never, format: 'jwk' }), Buffer.from(sig, 'base64url'))


export async function signUp(site: { readonly origin: string }, mac: Device, other: Device): Promise<{ desktopToken: string; otherSession: string; phoneSession: string; phoneDeviceId: string }> {
  const json = { 'content-type': 'application/json' }
  const claimed = await fetch(`${site.origin}/v2/accounts`, { method: 'POST', headers: json, body: JSON.stringify({ username: 'owner', password: PASSWORD, device: { id: mac.id, kind: 'desktop', name: 'This Mac', jwk: mac.jwk } }) })
  const desktopToken = ((await claimed.json()) as { session: { token: string } }).session.token
  await fetch(`${site.origin}/v2/me/desktops/${mac.id}`, { method: 'PUT', headers: { ...json, authorization: `Bearer ${desktopToken}` }, body: JSON.stringify({ name: 'This Mac', workspaces: [{ id: 'w1', name: 'One' }] }) })
  const attach = async (device: { id: string; kind: string; name: string; jwk: unknown }): Promise<string> => {
    const attached = await fetch(`${site.origin}/v2/sessions`, { method: 'POST', headers: json, body: JSON.stringify({ username: 'owner', password: PASSWORD, device }) })
    const asked = (await attached.json()) as { pending: string; match: string }
    const request = await fetch(`${site.origin}/v2/sessions/${asked.pending}/approve`, { method: 'POST' })
    const { approval } = (await request.json()) as { approval: string }
    await fetch(`${site.origin}/v2/me/approvals/${approval}`, { method: 'POST', headers: { ...json, authorization: `Bearer ${desktopToken}` }, body: JSON.stringify({ decision: 'approve', match: asked.match }) })
    const done = await fetch(`${site.origin}/v2/sessions/${asked.pending}`)
    return ((await done.json()) as { token: string }).token
  }
  const otherSession = await attach({ id: other.id, kind: 'desktop', name: 'Other Mac', jwk: other.jwk })
  const phoneJwk = generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' })
  const phoneDeviceId = randomUUID()
  const phoneSession = await attach({ id: phoneDeviceId, kind: 'phone', name: 'A phone', jwk: phoneJwk })
  return { desktopToken, otherSession, phoneSession, phoneDeviceId }
}

