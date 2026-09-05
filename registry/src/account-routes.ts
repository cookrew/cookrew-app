import { createHash, randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { HANDLE, presentable, type Device } from './accounts'
import { json, readJsonBody } from './http'
import { bindStatement, type IdentityService, type TokenClaims } from './identity'
import { jwkThumbprint, publicJwk, verifyDetached } from './jwk'
import { parseAttestationObject } from './passkey'
import { clientAddress } from './rate-limit'

/**
 * ACCOUNT ROUTES — minting a username, binding devices to it, taking them away.
 *
 * Its own module rather than more of `server.ts` for the reason the identity
 * design gives: the ceremony answers "who signed", and these routes answer "who
 * may edit this account". Those are different questions and the second one is
 * where the interesting refusals live.
 *
 * Two rules run through everything here.
 *
 *   THE HANDLE COMES FROM THE PATH, THE AUTHORITY FROM THE TOKEN. A body never
 *   says whose account is being edited. `@drej`'s token cannot bind a device to
 *   `@mira` however the JSON is spelled.
 *
 *   A BIND IS VOUCHED FOR BY A KEY, NOT BY A SESSION. The account token proves
 *   a device of this account is calling; the `vouch` signature proves THAT
 *   device deliberately named THIS new key. A registry that only checked the
 *   token could add a device to an account by itself — which is exactly the
 *   compromise the design's threat table says every bind must be witnessed
 *   against.
 */

/** Answers that depend on who asked: never shared, never cached. */
const PRIVATE: Record<string, string> = {
  'cache-control': 'private, no-store',
  vary: 'cookie, authorization'
}

/** An assertion, a device and a vouch all fit; an attestation object is the big one. */
const BODY_LIMIT = 16 * 1024

const clean = (segment: string): string => decodeURIComponent(segment).replace(/^@/, '').toLowerCase()

/** The Bearer, or null. The cookie is deliberately NOT read on these routes. */
function bearer(request: IncomingMessage): string | null {
  const auth = request.headers.authorization ?? ''
  return auth.startsWith('Bearer ') ? auth.slice(7) : null
}

/**
 * The caller is an unrevoked device of THIS account, holding an `account`
 * token — or a `link` token minted for the one device it is about to vouch for.
 *
 * The `link` case is why the scope exists: a device may hand out a two-minute,
 * single-use permission to bind exactly one key without handing over its
 * ten-minute account token.
 */
export function callerDevice(
  identity: IdentityService,
  request: IncomingMessage,
  handle: string,
  forDeviceId?: string
): { claims: TokenClaims; device: Device } | null {
  const token = bearer(request)
  if (token === null) return null
  const claims = identity.verifyToken(token)
  if (claims === null) return null
  if (claims.sub !== handle) return null
  if (claims.scope === 'link') {
    if (forDeviceId === undefined) return null
    // Spending is what makes it single use, and it happens before the bind so a
    // refused bind still burns the permission.
    if (identity.spendLink(token, forDeviceId) === null) return null
  } else if (claims.scope !== 'account') {
    return null
  }
  if (typeof claims.dev !== 'string') return null
  const device = identity.accounts.signer(handle, claims.dev)
  return device === null ? null : { claims, device }
}

/**
 * Mount the account surface. Returns true when it claimed the path, so
 * `server.ts` can fall through to everything else untouched.
 */
export function handleAccountRoutes(
  identity: IdentityService,
  request: IncomingMessage,
  response: ServerResponse,
  method: string,
  parts: readonly string[]
): boolean {
  if (parts[0] !== 'v1' || parts[1] !== 'accounts') return false

  if (parts.length === 2) {
    if (method !== 'POST') {
      json(response, 405, { error: 'method_not_allowed' }, { ...PRIVATE, allow: 'POST' })
      return true
    }
    run(response, mint(identity, request, response))
    return true
  }

  const handle = clean(parts[2])
  if (!HANDLE.test(handle)) {
    json(response, 404, { error: 'not_found' }, PRIVATE)
    return true
  }

  // HEAD/GET /v1/accounts/:handle — is this name taken, and how many keys hold it.
  if (parts.length === 3) {
    if (method === 'HEAD') {
      response.writeHead(identity.accounts.exists(handle) ? 200 : 404, PRIVATE)
      response.end()
      return true
    }
    if (method === 'GET') {
      const account = identity.accounts.get(handle)
      json(
        response,
        account === null ? 404 : 200,
        account === null
          ? { error: 'not_found' }
          : // A COUNT, never the keys: whether a name is taken is public, and
            // which machines its owner holds is not.
            { handle, devices: identity.accounts.active(handle).length },
        PRIVATE
      )
      return true
    }
    json(response, 405, { error: 'method_not_allowed' }, { ...PRIVATE, allow: 'GET, HEAD' })
    return true
  }

  if (parts.length === 4 && parts[3] === 'devices') {
    if (method === 'GET') {
      const caller = callerDevice(identity, request, handle)
      if (caller === null) {
        json(response, 401, { error: 'unidentified' }, PRIVATE)
        return true
      }
      json(response, 200, { handle, devices: identity.accounts.devices(handle).map(presentable) }, PRIVATE)
      return true
    }
    if (method === 'POST') {
      run(response, bind(identity, request, response, handle))
      return true
    }
    json(response, 405, { error: 'method_not_allowed' }, { ...PRIVATE, allow: 'GET, POST' })
    return true
  }

  if (parts.length === 5 && parts[3] === 'devices') {
    if (method !== 'DELETE') {
      json(response, 405, { error: 'method_not_allowed' }, { ...PRIVATE, allow: 'DELETE' })
      return true
    }
    const caller = callerDevice(identity, request, handle)
    if (caller === null) {
      json(response, 401, { error: 'unidentified' }, PRIVATE)
      return true
    }
    const out = identity.accounts.revoke(handle, decodeURIComponent(parts[4]))
    if (out.ok) {
      json(response, 200, { ok: true }, PRIVATE)
      return true
    }
    // 409 for the last device: the request was understood and refused for a
    // reason the caller can act on (bind another device first).
    json(
      response,
      out.reason === 'last_device' ? 409 : 404,
      { error: out.reason },
      PRIVATE
    )
    return true
  }

  if (parts.length === 4 && parts[3] === 'link-codes' && method === 'POST') {
    const caller = callerDevice(identity, request, handle)
    if (caller === null) {
      json(response, 401, { error: 'unidentified' }, PRIVATE)
      return true
    }
    json(response, 201, identity.linkCodes.issue(handle, caller.device.id), PRIVATE)
    return true
  }

  if (parts.length === 4 && parts[3] === 'link' && method === 'POST') {
    /**
     * THE ONE ROUTE WITH NO CREDENTIAL, so the one route with a limit.
     *
     * Counted per (handle, caller address) and taken BEFORE the body is read:
     * a refused attempt must cost the registry a map lookup, not sixteen
     * kilobytes of parsing. The limiter is the second line — the wrong-guess
     * counter inside `LinkCodes` is the first, because it counts guesses
     * against the secret rather than against whoever made them, and behind a
     * reverse proxy every caller shares one address.
     */
    const verdict = identity.linkAttempts.take(`${handle}|${clientAddress(request)}`)
    if (!verdict.ok) {
      json(
        response,
        429,
        {
          error: 'too_many_attempts',
          message:
            'Too many link attempts. Wait a moment, then ask the device that holds this account for a fresh code.'
        },
        { ...PRIVATE, 'retry-after': String(verdict.retryAfter) }
      )
      // Drained rather than left unread: an unanswered body keeps the socket
      // busy, and the point of a limit is to stop paying for the attempt.
      request.resume()
      return true
    }
    run(response, link(identity, request, response, handle))
    return true
  }

  if (parts.length === 5 && parts[3] === 'passkey' && parts[4] === 'options' && method === 'POST') {
    const caller = callerDevice(identity, request, handle)
    if (caller === null) {
      json(response, 401, { error: 'unidentified' }, PRIVATE)
      return true
    }
    json(response, 200, creationOptions(identity, handle), PRIVATE)
    return true
  }

  if (parts.length === 4 && parts[3] === 'passkey' && method === 'POST') {
    run(response, enrolPasskey(identity, request, response, handle))
    return true
  }

  json(response, 404, { error: 'not_found' }, PRIVATE)
  return true
}

/** A route's promise, with the one failure mode a route may not have: silence. */
function run(response: ServerResponse, work: Promise<void>): void {
  work.catch(() => {
    if (!response.headersSent) json(response, 400, { error: 'malformed' }, PRIVATE)
    else response.end()
  })
}

async function body(
  request: IncomingMessage,
  response: ServerResponse
): Promise<Record<string, unknown> | null> {
  const read = await readJsonBody(request, BODY_LIMIT)
  if (!read.ok) {
    json(response, read.reason === 'too_large' ? 413 : 400, { error: 'malformed' }, PRIVATE)
    return null
  }
  return read.value
}

/** POST /v1/accounts — mint a username with its first device. TOFU, first wins. */
async function mint(
  identity: IdentityService,
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  const value = await body(request, response)
  if (value === null) return
  const handle = typeof value.handle === 'string' ? value.handle.replace(/^@/, '').toLowerCase() : ''
  const out = identity.accounts.mint(handle, value.device)
  if (out.ok) {
    json(response, 201, { handle: out.handle, deviceId: out.deviceId }, PRIVATE)
    return
  }
  json(response, out.reason === 'taken' ? 409 : 400, { error: out.reason }, PRIVATE)
}

/** POST /v1/accounts/@h/devices — one device vouching for another. */
async function bind(
  identity: IdentityService,
  request: IncomingMessage,
  response: ServerResponse,
  handle: string
): Promise<void> {
  const value = await body(request, response)
  if (value === null) return
  const device = value.device as { id?: unknown; jwk?: unknown } | undefined
  const deviceId = typeof device?.id === 'string' ? device.id.toLowerCase() : ''
  const caller = callerDevice(identity, request, handle, deviceId)
  if (caller === null) {
    json(response, 401, { error: 'unidentified' }, PRIVATE)
    return
  }
  const jwk = publicJwk(device?.jwk)
  const thumbprint = jwk === null ? null : jwkThumbprint(jwk)
  if (thumbprint === null || deviceId === '') {
    json(response, 400, { error: 'bad_device' }, PRIVATE)
    return
  }
  // THE VOUCH, over the account, the new device's id AND its key. All three,
  // because a signature over any two of them would still be valid if the third
  // were swapped in flight.
  const vouch = typeof value.vouch === 'string' ? value.vouch : ''
  if (!verifyDetached(caller.device.jwk, bindStatement(handle, deviceId, thumbprint), vouch)) {
    json(response, 403, { error: 'bad_vouch' }, PRIVATE)
    return
  }
  const out = identity.accounts.bind(handle, value.device, caller.device.id)
  if (out.ok) {
    json(response, 201, { handle, deviceId: out.deviceId }, PRIVATE)
    return
  }
  json(response, out.reason === 'device_exists' ? 409 : 400, { error: out.reason }, PRIVATE)
}

/**
 * POST /v1/accounts/@h/link — redeem a six-character code.
 *
 * UNAUTHENTICATED on purpose: the device redeeming has no key this account
 * knows yet, which is the whole point. The code is the authority, it lives two
 * minutes, and it is spent whether or not the bind that follows succeeds.
 */
async function link(
  identity: IdentityService,
  request: IncomingMessage,
  response: ServerResponse,
  handle: string
): Promise<void> {
  const value = await body(request, response)
  if (value === null) return
  const spent = identity.linkCodes.spend(String(value.code ?? ''), handle)
  if (!spent.ok) {
    // An expired code is 410 because retrying the same one is pointless; an
    // unknown one — including a code for another account — is 404, so the route
    // cannot be used to learn which handles have codes outstanding.
    json(response, spent.reason === 'expired' ? 410 : 404, { error: spent.reason }, PRIVATE)
    return
  }
  const out = identity.accounts.bind(handle, value.device, spent.by)
  if (out.ok) {
    json(response, 201, { handle, deviceId: out.deviceId }, PRIVATE)
    return
  }
  json(response, out.reason === 'device_exists' ? 409 : 400, { error: out.reason }, PRIVATE)
}

/** The creation options a browser hands to `navigator.credentials.create`. */
function creationOptions(identity: IdentityService, handle: string): Record<string, unknown> {
  const rp = identity.rp()
  return {
    challenge: identity.challenge(),
    rp: { id: rp.id, name: 'Cookrew' },
    user: {
      // The account, not a person: a handle is what this registry knows and the
      // only thing it can put in front of somebody choosing a key.
      id: Buffer.from(handle, 'utf8').toString('base64url'),
      name: handle,
      displayName: `@${handle}`
    },
    pubKeyCredParams: [
      { type: 'public-key', alg: -7 },
      { type: 'public-key', alg: -8 }
    ],
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
    timeout: 60_000
  }
}

/**
 * POST /v1/accounts/@h/passkey — enrol a platform authenticator as a device.
 *
 * The attestation statement is NOT verified (see passkey.ts): this is the same
 * TOFU trade the credential map made, and it is written down in both places
 * rather than implied. What IS checked is that the ceremony was this one — this
 * server's challenge, this origin, this RP — so a registration captured
 * elsewhere cannot be replayed into an account here.
 */
async function enrolPasskey(
  identity: IdentityService,
  request: IncomingMessage,
  response: ServerResponse,
  handle: string
): Promise<void> {
  const value = await body(request, response)
  if (value === null) return
  const caller = callerDevice(identity, request, handle)
  if (caller === null) {
    json(response, 401, { error: 'unidentified' }, PRIVATE)
    return
  }
  const credential = value.credential as
    | { response?: { clientDataJSON?: unknown; attestationObject?: unknown } }
    | undefined
  const clientDataJSON = credential?.response?.clientDataJSON
  const attestationObject = credential?.response?.attestationObject
  if (typeof clientDataJSON !== 'string' || typeof attestationObject !== 'string') {
    json(response, 400, { error: 'malformed' }, PRIVATE)
    return
  }
  let clientData: { type?: unknown; origin?: unknown; challenge?: unknown }
  try {
    clientData = JSON.parse(Buffer.from(clientDataJSON, 'base64url').toString('utf8')) as never
  } catch {
    json(response, 400, { error: 'malformed' }, PRIVATE)
    return
  }
  const rp = identity.rp()
  // The challenge is spent FIRST, so a refusal further down cannot be retried
  // with the same nonce and a different attestation.
  const fresh = identity.spendChallenge(clientData.challenge)
  if (clientData.type !== 'webauthn.create' || clientData.origin !== rp.origin || !fresh) {
    json(response, 400, { error: 'bad_ceremony' }, PRIVATE)
    return
  }
  const parsed = parseAttestationObject(Buffer.from(attestationObject, 'base64url'))
  if (!parsed.ok) {
    json(response, 400, { error: parsed.reason }, PRIVATE)
    return
  }
  const expected = createHash('sha256').update(rp.id).digest('base64url')
  if (parsed.passkey.rpIdHash !== expected || !parsed.passkey.userPresent) {
    json(response, 400, { error: 'bad_ceremony' }, PRIVATE)
    return
  }
  const name = typeof value.name === 'string' && value.name.trim() !== '' ? value.name : 'Passkey'
  const out = identity.accounts.bind(
    handle,
    // The device id is minted HERE: a registration response carries the
    // authenticator's credential id, which is not a UUID and is not the
    // device's to choose.
    { id: randomUUID(), jwk: parsed.passkey.jwk, kind: 'passkey', name },
    caller.device.id,
    { credentialId: parsed.passkey.credentialId }
  )
  if (out.ok) {
    json(
      response,
      201,
      { handle, deviceId: out.deviceId, credentialId: parsed.passkey.credentialId },
      PRIVATE
    )
    return
  }
  json(response, out.reason === 'device_exists' ? 409 : 400, { error: out.reason }, PRIVATE)
}
