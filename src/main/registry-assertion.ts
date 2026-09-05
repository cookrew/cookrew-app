import { createHash, createPrivateKey, sign } from 'node:crypto'

/**
 * THE ONE CEREMONY, in one place.
 *
 * The registry knows exactly one way to be convinced that a key is present:
 * the WebAuthn assertion shape it verifies for the site, for the app, and now
 * for every device an account holds. It used to be written out inside
 * registry-account.ts, which meant the account file (account.ts) either
 * imported a module about the RETIRED per-registry credential or wrote the
 * ceremony a second time — and two copies of a signature format is two ways to
 * be refused for reasons nobody can see.
 *
 * So the bytes live here, and both callers are thin over them.
 */

export interface RegistryAssertion {
  credentialId: string
  clientDataJSON: string
  authenticatorData: string
  signature: string
}

const B64 = 'base64url' as const

/**
 * Sign `challenge` for `origin` as `credentialId`.
 *
 * The user-present bit is set because the owner started this app and told it
 * to serve; the counter is fixed because this is a key on a disk, not a device
 * with a monotonic clock. Both were true of the old implementation and are
 * restated here rather than lost in the move.
 */
export function buildRegistryAssertion(input: {
  origin: string
  credentialId: string
  privateKeyJwk: Record<string, unknown>
  challenge: string
}): RegistryAssertion {
  const url = new URL(input.origin)
  const clientDataJSON = Buffer.from(
    JSON.stringify({ type: 'webauthn.get', origin: url.origin, challenge: input.challenge }),
    'utf8'
  )
  const authenticatorData = Buffer.concat([
    createHash('sha256').update(url.hostname).digest(),
    Buffer.from([0x01]),
    Buffer.from([0, 0, 0, 1])
  ])
  const signature = sign(
    null,
    Buffer.concat([authenticatorData, createHash('sha256').update(clientDataJSON).digest()]),
    createPrivateKey({ key: input.privateKeyJwk as never, format: 'jwk' })
  )
  return {
    credentialId: input.credentialId,
    clientDataJSON: clientDataJSON.toString(B64),
    authenticatorData: authenticatorData.toString(B64),
    signature: signature.toString(B64)
  }
}

/**
 * RFC 7638 thumbprint of a JWK, base64url.
 *
 * The bind message names a device by its key's thumbprint rather than by the
 * key: a vouch is then a statement about ONE key and cannot be replayed over a
 * device record whose jwk was swapped in flight. The member set is fixed by the
 * RFC per key type and the JSON is lexicographic with no whitespace — anything
 * else produces a different digest on the two sides of the wire.
 */
export function jwkThumbprint(jwk: Record<string, unknown>): string {
  const canonical = requiredMembers(jwk)
  const json = `{${Object.keys(canonical)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${JSON.stringify(canonical[key])}`)
    .join(',')}}`
  return createHash('sha256').update(json, 'utf8').digest('base64url')
}

function requiredMembers(jwk: Record<string, unknown>): Record<string, unknown> {
  const kty = jwk.kty
  if (kty === 'OKP') return { crv: jwk.crv, kty, x: jwk.x }
  if (kty === 'EC') return { crv: jwk.crv, kty, x: jwk.x, y: jwk.y }
  if (kty === 'RSA') return { e: jwk.e, kty, n: jwk.n }
  throw new Error(`a device key of type ${String(kty)} cannot be named — expected OKP, EC or RSA`)
}

/**
 * WHAT A VOUCH SAYS, exactly.
 *
 * "@handle says device <id>, whose key is <thumbprint>, may sign for it." The
 * version prefix is load-bearing: a signature over an unversioned string could
 * be re-read under a later, wider meaning, and the registry would have no way
 * to tell which sentence the owner actually signed.
 */
export function bindMessage(handle: string, deviceId: string, thumbprint: string): string {
  return `cookrew-bind/1 ${handle} ${deviceId} ${thumbprint}`
}
