import { decodeBase64Url } from './key-fingerprint'

/**
 * What arrived in the paste box (Velvet's deck §4).
 *
 * THE SIXTH ROW IS WHY THIS FILE IS SMALL AND THE FINGERPRINT IS NOT. Five of
 * six wrong pastes are caught here and cost the owner ten seconds. The sixth — a
 * well-formed ed25519 key belonging to the wrong party — is invisible to every
 * check that can be written, survives all of them, and is exactly what an
 * attacker supplies. This parser's job is therefore NOT to be the defence. It is
 * to clear the noise so the human comparison in key-fingerprint.ts is the last
 * thing standing, and to be honest that it cannot do more.
 *
 * A PRIVATE KEY IS REFUSED LOUDLY AND NEVER RETURNED. Someone who pastes their
 * counterparty's private key has had a bad day already; the surface must say so,
 * clear the field, and tell them the pair needs replacing. The value must not
 * reach the store even as a rejected record — that is an owner-facing gate in
 * the deck and it is asserted against the STORE, not the pixels.
 */

/** Named for the deck's copy ids: mkt.grant.paste.<reason>. */
export type CallerKeyRefusal =
  | { reason: 'notakey' }
  /** Names the algorithm rather than saying "invalid" — the deck is specific. */
  | { reason: 'wrongtype'; type: string }
  | { reason: 'malformed' }
  | { reason: 'private' }

export type CallerKeyResult =
  | { ok: true; jwk: Record<string, unknown>; raw: Uint8Array }
  | { ok: false; refusal: CallerKeyRefusal }

/** The 12-byte SPKI prefix an ed25519 public key always carries. */
const ED25519_SPKI_PREFIX = [0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00]

const refuse = (refusal: CallerKeyRefusal): CallerKeyResult => ({ ok: false, refusal })

/** A 32-byte raw key → the JWK the store enrols, and the bytes the phrase hashes. */
function accept(raw: Uint8Array): CallerKeyResult {
  const b64 = btoa(String.fromCharCode(...raw))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
  return { ok: true, raw, jwk: { kty: 'OKP', crv: 'Ed25519', x: b64 } }
}

/**
 * Anything that announces itself as private, in any of the shapes people paste.
 *
 * Checked FIRST and on the raw text, before any parse can succeed. A private key
 * that happened to parse as something else would be reported as the wrong error
 * and the owner would never learn what they had just pasted into a chat window.
 */
function looksPrivate(text: string): boolean {
  if (/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/.test(text)) return true
  if (/\bPRIVATE KEY\b/i.test(text)) return true
  // A JWK carrying `d` is the private scalar, whatever else it claims to be.
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>
    if (parsed && typeof parsed === 'object' && typeof parsed.d === 'string') return true
  } catch {
    // Not JSON. The textual checks above already covered the PEM shapes.
  }
  return false
}

/** Name an algorithm the way a person would recognise it. */
function nameOf(kty: unknown, crv: unknown): string {
  if (kty === 'RSA') return 'RSA'
  if (kty === 'EC') return `ECDSA (${typeof crv === 'string' ? crv : 'unknown curve'})`
  if (kty === 'OKP' && typeof crv === 'string') return crv
  return typeof kty === 'string' ? kty : 'unrecognised'
}

function fromJwk(parsed: Record<string, unknown>): CallerKeyResult {
  if (parsed.kty !== 'OKP' || parsed.crv !== 'Ed25519') {
    return refuse({ reason: 'wrongtype', type: nameOf(parsed.kty, parsed.crv) })
  }
  if (typeof parsed.x !== 'string') return refuse({ reason: 'malformed' })
  const raw = decodeBase64Url(parsed.x)
  if (!raw) return refuse({ reason: 'malformed' })
  if (raw.length !== 32) return refuse({ reason: 'malformed' })
  return accept(raw)
}

function fromOpenSsh(text: string): CallerKeyResult | null {
  const match = text.match(/^(ssh-[a-z0-9-]+|ecdsa-sha2-[a-z0-9-]+)\s+([A-Za-z0-9+/=]+)/)
  if (!match) return null
  const [, algorithm, body] = match
  if (algorithm !== 'ssh-ed25519') {
    return refuse({
      reason: 'wrongtype',
      type: algorithm === 'ssh-rsa' ? 'RSA' : algorithm.replace('ecdsa-sha2-', 'ECDSA ')
    })
  }
  const blob = decodeBase64Url(body)
  // 4-byte length + "ssh-ed25519" + 4-byte length + 32 key bytes.
  if (!blob || blob.length < 51) return refuse({ reason: 'malformed' })
  const key = blob.slice(blob.length - 32)
  return accept(key)
}

function fromDer(bytes: Uint8Array): CallerKeyResult {
  if (bytes.length === 32) return accept(bytes)
  if (bytes.length !== 44) return refuse({ reason: 'malformed' })
  const prefixMatches = ED25519_SPKI_PREFIX.every((byte, at) => bytes[at] === byte)
  // A 44-byte SPKI that is not ed25519 is a real key of another algorithm, and
  // the owner is better served by being told which than by "malformed".
  if (!prefixMatches) return refuse({ reason: 'wrongtype', type: 'a non-ed25519' })
  return accept(bytes.slice(12))
}

/**
 * Parse whatever the owner pasted into the enrolment sheet.
 *
 * Accepts the shapes a counterparty actually sends: an `ed25519:`-prefixed or
 * bare base64 SPKI, an OpenSSH public key line, a PEM public block, and a JWK.
 * Everything else is refused with the most specific reason available.
 */
export function parseCallerKey(pasted: unknown): CallerKeyResult {
  if (typeof pasted !== 'string') return refuse({ reason: 'notakey' })
  const text = pasted.trim()
  if (text.length === 0) return refuse({ reason: 'notakey' })

  // FIRST, always. See looksPrivate.
  if (looksPrivate(text)) return refuse({ reason: 'private' })

  if (text.startsWith('{')) {
    try {
      return fromJwk(JSON.parse(text) as Record<string, unknown>)
    } catch {
      return refuse({ reason: 'malformed' })
    }
  }

  const ssh = fromOpenSsh(text)
  if (ssh) return ssh

  if (text.includes('-----BEGIN')) {
    if (!/-----BEGIN PUBLIC KEY-----/.test(text)) return refuse({ reason: 'notakey' })
    const body = text.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, '')
    const bytes = decodeBase64Url(body)
    return bytes ? fromDer(bytes) : refuse({ reason: 'malformed' })
  }

  const body = text.replace(/^ed25519:/i, '').trim()
  // Something with spaces or wide punctuation was never a key; calling that
  // 'malformed' would tell the owner their key was cut off when it was prose.
  if (/\s/.test(body) || !/^[A-Za-z0-9+/_=-]+$/.test(body)) return refuse({ reason: 'notakey' })
  const bytes = decodeBase64Url(body)
  if (!bytes) return refuse({ reason: 'notakey' })
  return fromDer(bytes)
}
