import { createHash } from 'node:crypto'

/**
 * RFC 7638 JWK THUMBPRINT, base64url — node only.
 *
 * What a device grant names its key by (registry/src/v2-device-grant.ts mints,
 * src/main/account-pair.ts checks). The canonical member subset, in
 * lexicographic order, no whitespace: `crv, kty, x` for OKP, `crv, kty, x, y`
 * for EC — the same subset site.js's device-id.js hashes.
 */
export function jwkThumbprint(jwk: Record<string, unknown>): string | null {
  const { kty, crv, x, y } = jwk
  if (typeof kty !== 'string' || typeof crv !== 'string' || typeof x !== 'string') return null
  const canonical =
    kty === 'OKP' ? JSON.stringify({ crv, kty, x }) : kty === 'EC' && typeof y === 'string' ? JSON.stringify({ crv, kty, x, y }) : null
  return canonical === null ? null : createHash('sha256').update(canonical, 'utf8').digest('base64url')
}
