import type { IncomingMessage, ServerResponse } from 'node:http'
import { json, readJsonBody } from './http'
import { countersignBinding, type CountersignOperation } from './countersign'
import { publishPreset, rotateAuthorKey, type PublishDeps, type PublishFailure } from './publish'
import { isAddress, type RegistryStore } from './store'
import { publicKeyFromId } from '../../src/main/preset-publish'
import type { TransparencyLog } from './log'
import type { AssertionInput, IdentityService } from './identity'
import type { PresetManifest } from '../../src/shared/preset-manifest'

/**
 * THE WRITE SIDE, OVER HTTP (A3 completed).
 *
 * A3 shipped publish and rotation as a unit-tested library that no route
 * mounted, which made "authenticated publish" a claim about code rather than
 * about a server. M2 mounts payment on this gate, so the gate had to exist.
 *
 * WHAT MOUNTING FORCED, and it is not a detail. Both operations used to share
 * ONE countersignature payload — sha256(authorKeyId ‖ presetId) — checked as a
 * bare signature and then APPENDED TO THE PUBLIC LOG. Anyone could read a
 * countersig out of the log and present it at the other route: a publish became
 * a key rotation, which is the one operation that moves who may sign a lineage.
 *
 * Two changes close it, and both were needed. The payload now names the
 * operation (./countersign.ts), so the two are different bytes. And the
 * countersignature is verified as a FULL ASSERTION against a challenge this
 * server issued and has now spent — so it proves an authenticator was present
 * for this exact act, and a value copied out of the log proves nothing at all.
 *
 * The verification happens in exactly ONE place: the library's own
 * `verifyCountersign` seam, closed over the assertion this request carried.
 * Checking it in the route as well would spend the single-use challenge before
 * the library ever saw it — two checks, and the second always failing.
 */

/** A team blob plus a manifest. Generous, but not a place to grow memory. */
const PUBLISH_BODY_LIMIT = 1024 * 1024
const ROTATE_BODY_LIMIT = 64 * 1024

/**
 * What the write routes need. `verifyCountersign` is absent on purpose: it is
 * inherently request-scoped, because the thing it verifies arrives in the body.
 */
export interface WriteDeps {
  store: RegistryStore
  log: TransparencyLog
  verifyManifest: (manifest: PresetManifest) => boolean
  identity?: IdentityService
  now?: () => number
}

function bearer(request: IncomingMessage): string | null {
  const header = request.headers.authorization
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return null
  const token = header.slice('Bearer '.length).trim()
  return token.length > 0 ? token : null
}

/**
 * WHO is asking, or the answer to send instead.
 *
 * D4/R26 in the other direction: a DOWNLOAD token at a publish route is a valid
 * identity that does not cover this request, so it is 403 `scope` and never
 * 401. Until these routes existed only one direction of that rule was
 * reachable, which meant half of R26 was untested by construction.
 */
function callerOf(
  identity: IdentityService,
  request: IncomingMessage,
  response: ServerResponse
): string | null {
  const token = bearer(request)
  const claims = token === null ? null : identity.verifyToken(token)
  if (claims === null) {
    json(response, 401, {}, {
      'www-authenticate': `WebAuthn realm="market", challenge=${identity.challenge()}`
    })
    return null
  }
  if (claims.scope !== 'publish') {
    json(response, 403, { reason: 'scope' })
    return null
  }
  return claims.sub
}

/** The assertion shape, or null if the body did not carry one. */
function assertionOf(value: unknown): AssertionInput | null {
  if (typeof value !== 'object' || value === null) return null
  const raw = value as Record<string, unknown>
  const fields = ['credentialId', 'clientDataJSON', 'authenticatorData', 'signature'] as const
  for (const field of fields) if (typeof raw[field] !== 'string') return null
  return {
    credentialId: raw.credentialId as string,
    clientDataJSON: raw.clientDataJSON as string,
    authenticatorData: raw.authenticatorData as string,
    signature: raw.signature as string
  }
}

/**
 * Ask for the countersignature: a 401 carrying a challenge bound to exactly
 * this operation, key and preset. The same header the spec names for the login
 * ceremony, because to a client both mean "run a ceremony and come back".
 *
 * Sent both when no assertion arrived and when one arrived and failed. Which of
 * those happened is not the caller's business — the remedy is identical, and
 * distinguishing them maps the verifier for anyone probing it.
 */
function askForCountersignature(
  identity: IdentityService,
  response: ServerResponse,
  operation: CountersignOperation,
  authorKeyId: string,
  presetId: string
): void {
  // The binding is the countersign payload in hex — derived by the SAME
  // function the library will use when it verifies, so the value a challenge is
  // minted for and the value later checked against cannot drift apart.
  const challenge = identity.countersignChallenge(
    countersignBinding(operation, authorKeyId, presetId)
  )
  json(response, 401, { countersign: { operation, authorKeyId, presetId } }, {
    'www-authenticate': `WebAuthn realm="market", challenge=${challenge}`
  })
}

/**
 * Build the request-scoped verifier the library calls. The library computes the
 * payload — INCLUDING the operation — and this checks the assertion against it,
 * then confirms the countersignature came from the caller themselves.
 *
 * That last check is not redundant with the token. Without it, A could publish
 * while presenting a countersignature made by B: the log would record A's
 * identity beside a ceremony A never performed, and the transparency log's one
 * job is that its records are true.
 */
function countersignVerifier(
  identity: IdentityService,
  assertion: AssertionInput,
  caller: string
): PublishDeps['verifyCountersign'] {
  return (_operation, identityId, payload) => {
    if (identityId !== caller) return false
    const out = identity.countersign(assertion, payload.toString('hex'))
    return out.ok && out.credentialId === caller
  }
}

/** How a library refusal reaches the wire. */
const PUBLISH_STATUS: Record<PublishFailure, number> = {
  // The request does not describe what it claims to. Nothing to retry.
  schema_unsupported: 400,
  unsigned: 400,
  signature_invalid: 400,
  hash_mismatch: 400,
  // Run the ceremony again — this one IS retryable, which is why it is 401.
  countersign_missing: 401,
  // A conflict with what the log already holds. Not the caller's to fix by
  // repeating themselves.
  author_key_changed: 409,
  version_not_newer: 409,
  scope: 403
}

export async function handlePublish(
  request: IncomingMessage,
  response: ServerResponse,
  deps: WriteDeps
): Promise<void> {
  const identity = deps.identity
  // No identity service means no ceremony, and a publish without one would be
  // anonymous. Absent rather than refused: the route genuinely does not exist
  // in a deployment that cannot authenticate.
  if (!identity) {
    json(response, 404, { error: 'not_found' })
    return
  }

  const caller = callerOf(identity, request, response)
  if (caller === null) return

  const body = await readJsonBody(request, PUBLISH_BODY_LIMIT)
  if (!body.ok) {
    json(response, body.reason === 'too_large' ? 413 : 400, { error: 'bad_request' })
    return
  }

  const manifest = body.value.manifest as PresetManifest | undefined
  const team = body.value.team
  const teamName = body.value.teamName
  if (
    typeof manifest !== 'object' ||
    manifest === null ||
    typeof manifest.author?.keyId !== 'string' ||
    typeof manifest.id !== 'string' ||
    typeof team !== 'string' ||
    typeof teamName !== 'string' ||
    teamName.length === 0
  ) {
    json(response, 400, { error: 'bad_request' })
    return
  }
  // Validated before it is used to derive a challenge binding: an id that is
  // not an address cannot name a preset, and minting nonces for arbitrary
  // strings is a way to fill the challenge map with garbage.
  if (!isAddress(manifest.id)) {
    json(response, 400, { error: 'bad_request' })
    return
  }

  const assertion = assertionOf(body.value.countersign)
  if (assertion === null) {
    askForCountersignature(identity, response, 'publish', manifest.author.keyId, manifest.id)
    return
  }

  const result = publishPreset(
    { ...deps, verifyCountersign: countersignVerifier(identity, assertion, caller) },
    {
      manifest,
      teamBytes: Buffer.from(team, 'base64'),
      teamName,
      visibility: body.value.visibility === 'identified' ? 'identified' : 'public',
      identityId: caller,
      // The countersignature is an assertion now, so what the log records is
      // the signature that carried it. The bytes it committed to are derivable
      // by anyone from the record itself — kind, authorKeyId and presetId ARE
      // the payload — so the record stays checkable without growing.
      countersig: assertion.signature,
      at: (deps.now ?? Date.now)()
    }
  )

  if (!result.ok) {
    if (result.reason === 'countersign_missing') {
      askForCountersignature(identity, response, 'publish', manifest.author.keyId, manifest.id)
      return
    }
    json(response, PUBLISH_STATUS[result.reason], { reason: result.reason })
    return
  }
  json(response, 201, { id: result.id, version: result.version })
}

export async function handleRotate(
  presetId: string,
  request: IncomingMessage,
  response: ServerResponse,
  deps: WriteDeps
): Promise<void> {
  const identity = deps.identity
  if (!identity || !isAddress(presetId)) {
    json(response, 404, { error: 'not_found' })
    return
  }

  const caller = callerOf(identity, request, response)
  if (caller === null) return

  const body = await readJsonBody(request, ROTATE_BODY_LIMIT)
  if (!body.ok) {
    json(response, body.reason === 'too_large' ? 413 : 400, { error: 'bad_request' })
    return
  }

  const newAuthorKeyId = body.value.newAuthorKeyId
  if (typeof newAuthorKeyId !== 'string' || newAuthorKeyId.length === 0) {
    json(response, 400, { error: 'bad_request' })
    return
  }
  // A key id that names no usable key cannot become the one a lineage is bound
  // to. Refused here rather than at the first client that tries to verify
  // against it and finds nothing there.
  try {
    publicKeyFromId(newAuthorKeyId)
  } catch {
    json(response, 400, { error: 'bad_request' })
    return
  }

  const assertion = assertionOf(body.value.countersign)
  if (assertion === null) {
    askForCountersignature(identity, response, 'key-rotation', newAuthorKeyId, presetId)
    return
  }

  const result = rotateAuthorKey(
    { ...deps, verifyCountersign: countersignVerifier(identity, assertion, caller) },
    {
      presetId,
      newAuthorKeyId,
      identityId: caller,
      countersig: assertion.signature,
      at: (deps.now ?? Date.now)()
    }
  )
  if (!result.ok) {
    const reason = result.reason ?? 'author_key_changed'
    if (reason === 'countersign_missing') {
      askForCountersignature(identity, response, 'key-rotation', newAuthorKeyId, presetId)
      return
    }
    json(response, PUBLISH_STATUS[reason], { reason })
    return
  }
  json(response, 200, { ok: true })
}
