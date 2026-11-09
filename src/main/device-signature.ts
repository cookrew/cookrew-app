import { createPublicKey, verify } from 'node:crypto'

/**
 * A DEVICE KEY'S SIGNATURE. Ed25519 signs the message whole; a browser's P-256
 * key signs SHA-256 of it and WebCrypto writes r‖s (64 bytes), while the site
 * converts to DER for the registry — both are read.
 */
export function deviceSignatureValid(jwk: Record<string, unknown>, message: string, sig: string): boolean {
  if (typeof sig !== 'string' || sig.length === 0 || sig.length > 320 || !/^[A-Za-z0-9_-]+$/.test(sig)) return false
  const signature = Buffer.from(sig, 'base64url')
  try {
    const key = createPublicKey({ key: jwk as never, format: 'jwk' })
    const data = Buffer.from(message, 'utf8')
    if (jwk.kty === 'OKP') return verify(null, data, key, signature)
    if (jwk.kty !== 'EC') return false
    const dsaEncoding = signature.length === 64 ? 'ieee-p1363' : 'der'
    return verify('sha256', data, { key, dsaEncoding }, signature)
  } catch {
    return false
  }
}
