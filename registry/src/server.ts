import { createServer, type IncomingMessage, type Server } from 'node:http'
import { PRESET_VERSION_HEADER, type PresetManifest } from '../../src/shared/preset-manifest'
import { RegistryStore, isAddress } from './store'
import { TransparencyLog } from './log'
import { installPageHtml, originOf } from './install-page'
import { html, json, readJsonBody } from './http'
import { handlePublish, handleRotate } from './publish-routes'
import type { PricingDeps } from './authorize'
import { publicKeyFromId, verifyManifest } from '../../src/main/preset-publish'
import type { IdentityService, TokenScope } from './identity'
import type { Terms } from './terms'
import type { PaymentFailure } from './payment'
import { DoorStore, doorPath, type DoorInput } from './doors'
import { createRelayHttp, type RelayHttp } from './relay-http'
import type { ServerResponse } from 'node:http'

/**
 * REGISTRY SERVER (P2-A1) — routes only. Every answer is chosen by a decision
 * function, and in A1 that function has one rule: public presets are served.
 * A2 identity and the 401 path mount on `authorize` without touching a route.
 *
 * Status codes here are the PROTOCOL (spec §2, A3). They are not user-facing
 * chrome: per R14 no token or code in this file may reach a rendered sheet, and
 * nothing in a response body is a sentence.
 */

export type Verdict =
  | { code: 200 }
  | { code: 401; challenge: string }
  /**
   * M2-A1. The ONE variant payment adds. Everything else — routes, headers, the
   * client's retry loop, the log — is untouched, which is the claim the M1
   * design note made and this slice had to keep true.
   */
  | { code: 402; terms: Terms; reason?: PaymentFailure; retryable?: boolean }
  | { code: 403; reason: string }
  | { code: 404 }

export interface RegistryDeps {
  store: RegistryStore
  log: TransparencyLog
  /**
   * THE SEAM. A1 answers 200 for public and 403 for identified — identity does
   * not exist yet, so refusing is honest where a 401 would promise a ceremony
   * nobody can complete. A2 replaces this with the real challenge/token path
   * and A3's entitlement joins it; M2 adds ONE variant, 402, between
   * entitlement and serve. No route changes at any step.
   */
  authorize?: (presetId: string, request: IncomingMessage) => Verdict
  /** Present from A2: enrolment and assertion routes mount only when it is. */
  identity?: IdentityService
  /**
   * R30. Present → this registry is a DIRECTORY of served teams as well as a
   * store of artifacts. Absent → the /v1/doors routes do not exist, so a
   * deployment that only serves manifests is byte-identical to before.
   */
  doors?: DoorStore
  /**
   * M2-A1. Present → this deployment can price presets and the gate can answer
   * 402. Absent → it sells nothing and behaves exactly as M1 did, which is what
   * keeps every M1 test meaningful rather than merely still-passing.
   */
  pricing?: PricingDeps
  /**
   * DEV MODE. Mounts /v1/dev/* — a credential list and a reset, for a gate
   * matrix that must start from a known state. Off by default and never a
   * runtime toggle: a deployment either was started for development or it was
   * not, and an endpoint that can forget every credential must not be one flag
   * away in production.
   */
  dev?: boolean
  /**
   * THE RELAY. Present → this deployment also CARRIES calls to doors that
   * cannot be dialled, instead of only listing where they are.
   *
   * Separate from `doors` on purpose: a directory that merely publishes
   * addresses holds nothing of anyone's, while a relay holds live connections
   * and other people's traffic. Those are different things to operate and
   * different things to be trusted with, so they are different flags.
   */
  relay?: boolean
  /** Operational notes — a refused stream, a name already held. Never a body. */
  note?: (message: string) => void
}

function defaultAuthorize(store: RegistryStore): (id: string) => Verdict {
  return (id) => {
    const visibility = store.visibilityOf(id)
    if (visibility === null) return { code: 404 }
    if (visibility === 'public') return { code: 200 }
    // A1 has no identity to offer. 403 rather than 401: a 401 invites a
    // ceremony the server cannot yet complete, and a client that loops on it
    // would look broken for a reason no log explains (D4's rule, same shape).
    return { code: 403, reason: 'version_gate' }
  }
}

export function createRegistry(deps: RegistryDeps): Server {
  const { store, log } = deps
  const authorize = deps.authorize ?? ((id: string) => defaultAuthorize(store)(id))

  /**
   * What the write routes need, assembled once.
   *
   * A manifest is verified against the key IT NAMES, which is only sound
   * because a publish also carries a countersignature binding the caller's
   * identity to that key: the signature proves the key signed these bytes, the
   * countersignature proves this identity claims the key. Either alone would
   * let someone publish under a name that is not theirs.
   */
  const writeDeps = {
    store,
    log,
    identity: deps.identity,
    // M2-A1: present only when this deployment prices things. A publish of a
    // priced manifest into a registry that sells nothing is refused rather
    // than quietly stored as if it were free.
    payouts: deps.pricing?.payouts,
    verifyManifest: (manifest: PresetManifest): boolean => {
      try {
        return verifyManifest(manifest, publicKeyFromId(manifest.author.keyId))
      } catch {
        // A key id that cannot be parsed is not a verification failure to
        // reason about — it is simply not a key, and this runs on data a
        // caller chose.
        return false
      }
    }
  }

  const relay: RelayHttp | null = deps.relay
    ? createRelayHttp({ identity: deps.identity, log: deps.note })
    : null

  return createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://registry.local')
    const method = request.method ?? 'GET'
    const parts = url.pathname.split('/').filter(Boolean)

    // ── THE RELAY, first ──────────────────────────────────────────────────
    //
    // Ahead of every other route because its connections are long-lived and
    // must not be delayed behind anything, and because it owns its whole path
    // prefix: nothing under /v1/relay is served by the rest of this file.
    if (relay && relay.handle(request, response, parts, url)) return

    // GET /install/:presetId — R21 Option A, the page for a reader with no app.
    //
    // Outside /v1 on purpose: this is a URL people SHARE, and a version prefix
    // in a link someone pastes into a message is a promise to keep that link
    // working when the API moves on. The API is versioned because clients bind
    // to it; a shared link is bound to by humans.
    if (method === 'GET' && parts.length === 2 && parts[0] === 'install') {
      // Content addresses compare by value: the app's recogniser lowercases,
      // so a link with a capitalised digest that the APP accepts must not 404
      // here. Two spellings of one digest are one preset or the halves of R21
      // disagree about what a link is.
      const id = decodeURIComponent(parts[1]).toLowerCase()
      const summary = isAddress(id) ? store.list().find((p) => p.id === id) : undefined
      html(
        response,
        summary === undefined ? 404 : 200,
        summary === undefined
          ? installPageHtml({ kind: 'unknown' })
          : installPageHtml({
              kind: 'preset',
              name: summary.name,
              author: summary.author,
              // THIS address's version, never the lineage's latest. The id in
              // the link is the content address of one specific team, and it
              // is what the app will download — a page that advertised the
              // newest version would be describing a different preset than the
              // one the link actually hands over.
              version: summary.version,
              gated: summary.visibility === 'identified',
              origin: originOf(request.headers.host),
              id: summary.id
            })
      )
      return
    }

    // POST /v1/presets — PUBLISH. The write side of the gate (A3), mounted.
    //
    // Three independent things must hold, and the route proves them in the
    // order that costs least: the caller holds a publish-scoped token (WHO),
    // the identity countersigned THIS operation on THIS key and preset (a
    // deliberate act, per spec §6 a fresh ceremony per manifest), and the
    // library's own checks pass (the bytes are what the manifest says).
    if (method === 'POST' && parts.length === 2 && parts[0] === 'v1' && parts[1] === 'presets') {
      void handlePublish(request, response, writeDeps)
      return
    }

    // POST /v1/presets/:id/rotate — record a countersigned key rotation (R20's
    // registry half). Same ceremony, different operation, and the difference is
    // inside the countersignature rather than only in the URL.
    if (
      method === 'POST' &&
      parts.length === 4 &&
      parts[0] === 'v1' &&
      parts[1] === 'presets' &&
      parts[3] === 'rotate'
    ) {
      void handleRotate(decodeURIComponent(parts[2]), request, response, writeDeps)
      return
    }

    // ── DOORS (R30) — teams someone is SERVING, not artifacts to download ──
    //
    // Mounted only when this deployment keeps a door store, the same way
    // pricing and identity mount: a registry that lists nothing behaves
    // exactly as it did before, which is what keeps the older tests meaningful
    // rather than merely still-passing.
    if (deps.doors && method === 'GET' && parts.length === 2 && parts[0] === 'v1' && parts[1] === 'doors') {
      json(response, 200, { doors: deps.doors.list(url.searchParams.get('q') ?? '') })
      return
    }
    if (
      deps.doors &&
      method === 'GET' &&
      parts.length === 4 &&
      parts[0] === 'v1' &&
      parts[1] === 'doors'
    ) {
      // The @ is optional here because the canonical path a door is PUBLISHED
      // at carries one — /@drej/alpha — and a client that looked up the thing
      // it was handed would otherwise be told it does not exist.
      const found = deps.doors.get(
        decodeURIComponent(parts[2]).replace(/^@/, ''),
        decodeURIComponent(parts[3])
      )
      // A door nobody registered and a handle that never existed answer the
      // same, so the directory cannot be used to enumerate owners.
      if (!found) {
        json(response, 404, { error: 'not_found' })
        return
      }
      json(response, 200, found)
      return
    }
    if (deps.doors && method === 'POST' && parts.length === 2 && parts[0] === 'v1' && parts[1] === 'doors') {
      void handleDoorRegistration(deps.doors, deps.identity, request, response)
      return
    }

    // GET /v1/presets?q=
    if (method === 'GET' && parts.length === 2 && parts[0] === 'v1' && parts[1] === 'presets') {
      json(response, 200, { presets: store.search(url.searchParams.get('q') ?? '') })
      return
    }

    // GET|HEAD /v1/presets/:id/manifest
    if (
      (method === 'GET' || method === 'HEAD') &&
      parts.length === 4 &&
      parts[0] === 'v1' &&
      parts[1] === 'presets' &&
      parts[3] === 'manifest'
    ) {
      const id = decodeURIComponent(parts[2])
      // Validate the shape before it reaches the store. The store checks too;
      // this keeps a malformed address from being an interesting input at all.
      if (!isAddress(id)) {
        json(response, 404, { error: 'not_found' })
        return
      }
      const verdict = authorize(id, request)
      if (verdict.code !== 200) {
        // The 401 carries its challenge in the header the spec names, so a
        // client reads one place for "what do I do next" (spec §2).
        const headers: Record<string, string> =
          verdict.code === 401
            ? { 'www-authenticate': `WebAuthn realm="market", challenge=${verdict.challenge}` }
            : {}
        // 402 carries its terms, 403 its reason. Both are machine values: per
        // R14 nothing in a response body is a sentence, and Velvet's
        // mkt.pay.* strings interpolate from the terms rather than reading
        // anything we wrote here.
        const body =
          verdict.code === 403
            ? { reason: verdict.reason }
            : verdict.code === 402
              ? {
                  terms: verdict.terms,
                  // Absent on the first ask — not having paid yet is not a
                  // failure — and present only when a proof was refused.
                  ...(verdict.reason !== undefined
                    ? { reason: verdict.reason, retryable: verdict.retryable === true }
                    : {})
                }
              : {}
        json(response, verdict.code, body, headers)
        return
      }
      const manifest = store.getManifest(id)
      if (manifest === null) {
        json(response, 404, { error: 'not_found' })
        return
      }
      // R3: a HEAD is the whole update check. It answers the LATEST version in
      // this preset's lineage, which is the only question the client is asking.
      const summary = store.list().find((p) => p.id === id)
      const headers = { [PRESET_VERSION_HEADER]: String(summary?.latestVersion ?? manifest.version) }
      if (method === 'HEAD') {
        response.writeHead(200, headers)
        response.end()
        return
      }
      json(response, 200, manifest, headers)
      return
    }

    // GET /v1/blobs/:address
    if (method === 'GET' && parts.length === 3 && parts[0] === 'v1' && parts[1] === 'blobs') {
      const bytes = store.getBlob(decodeURIComponent(parts[2]))
      if (bytes === null) {
        json(response, 404, { error: 'not_found' })
        return
      }
      // Immutable by construction: the address IS the content, so a cached copy
      // can never be stale. Ungated on purpose — the bytes are inert without
      // the manifest that names them, and the manifest is the gate.
      response.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': String(bytes.byteLength),
        'cache-control': 'public, max-age=31536000, immutable'
      })
      response.end(bytes)
      return
    }

    // POST /v1/identity/register  |  POST /v1/identity/assert
    if (method === 'POST' && parts.length === 3 && parts[0] === 'v1' && parts[1] === 'identity') {
      const identity = deps.identity
      if (!identity) {
        json(response, 404, { error: 'not_found' })
        return
      }
      let body = ''
      request.on('data', (chunk) => {
        body += chunk
        // A body this size is already not a WebAuthn assertion; stop reading
        // rather than let an unauthenticated route grow memory.
        if (body.length > 64 * 1024) request.destroy()
      })
      request.on('end', () => {
        let parsed: Record<string, string> & { publicKeyJwk?: Record<string, unknown> }
        try {
          parsed = JSON.parse(body)
        } catch {
          json(response, 400, { error: 'bad_request' })
          return
        }
        if (parts[2] === 'register') {
          const out = identity.register(parsed.credentialId, parsed.publicKeyJwk ?? {})
          json(response, out.ok ? 201 : 409, out.ok ? { ok: true } : { error: out.reason })
          return
        }
        if (parts[2] === 'assert') {
          // SCOPE CROSSES THE WIRE. Without this the assert route could only
          // ever mint download tokens, so authorize's 403 branch — a valid
          // identity that does not cover the request (D4) — was unreachable
          // over HTTP and untestable from outside the process. An unknown or
          // absent value falls back to `download`: the narrower scope is the
          // safe default, and a caller asking for something unrecognised must
          // not be handed the broader one.
          const scope: TokenScope = parsed.scope === 'publish' ? 'publish' : 'download'
          const out = identity.assert(
            {
              credentialId: parsed.credentialId,
              clientDataJSON: parsed.clientDataJSON,
              authenticatorData: parsed.authenticatorData,
              signature: parsed.signature
            },
            scope
          )
          // The refusal REASON stays server-side. A client learns only that the
          // ceremony did not take, because which check failed is a map of the
          // verifier for anyone probing it.
          json(response, out.ok ? 200 : 401, out.ok ? { token: out.token, scope } : {})
          return
        }
        json(response, 404, { error: 'not_found' })
      })
      return
    }

    // GET /v1/health — liveness plus a self-description of the contract, so a
    // harness can reconcile what it expects against what is actually served
    // instead of discovering the difference one 404 at a time.
    if (method === 'GET' && parts.length === 2 && parts[0] === 'v1' && parts[1] === 'health') {
      json(response, 200, {
        ok: true,
        // The slice this deployment actually implements. A harness reconciles
        // what it expects against this string, so it moves with the code —
        // it said A2 through the whole of A3, which is exactly the drift the
        // self-description exists to prevent.
        slice: 'P2-A3',
        dev: deps.dev === true,
        // BOTH WAYS. A route appears here exactly when it is mounted, and the
        // write routes and the identity routes are mounted only when there is
        // an identity service — a publish without one would be anonymous. A
        // list that named routes this deployment answers 404 for would be worse
        // than no list, because a harness would trust it.
        routes: [
          // Outside /v1 because people share it (R21 Option A). Listed anyway:
          // a harness reconciling against this must not have to guess that the
          // page exists.
          'GET /install/:presetId',
          'GET /v1/health',
          'GET /v1/presets?q=',
          'GET /v1/presets/:id/manifest',
          'HEAD /v1/presets/:id/manifest',
          'GET /v1/blobs/:address',
          'GET /v1/log?from=&preset=',
          ...(deps.identity
            ? [
                'POST /v1/identity/register',
                'POST /v1/identity/assert',
                'POST /v1/presets',
                'POST /v1/presets/:id/rotate'
              ]
            : []),
          ...(deps.dev === true && deps.identity
            ? ['GET /v1/dev/identities', 'DELETE /v1/dev/identities']
            : [])
        ],
        // M2-A1. Advertised so a harness knows the gate can answer 402 without
        // discovering it from a preset that happens to be priced.
        payments: deps.pricing === undefined
          ? { served: false, note: 'this deployment prices nothing; the gate answers 200/401/403 only' }
          : {
              served: true,
              on: 'GET /v1/presets/:id/manifest',
              asset: 'USDC',
              chain: deps.pricing.config.chain,
              termsTtlMs: deps.pricing.config.ttlMs,
              // Stated in the contract, not only in a design note: the money
              // path is buyer → author and this process is never in it. A
              // harness can assert it, and an operator can read it.
              custody: 'none — funds move buyer to author; the registry never holds them'
            },
        // Named so a harness does not build fixtures against a route that is
        // never going to exist. Payment RETRIES the manifest GET with an
        // X-Payment header (spec §4); there is deliberately no confirm endpoint.
        // STILL TRUE IN M2, and it has to stay true: 402 mounts on the gate.
        notServed: { '/v1/pay': 'never — M2 mounts 402 on the manifest gate itself' }
      })
      return
    }

    // GET|DELETE /v1/dev/identities — dev only.
    if (parts.length === 3 && parts[0] === 'v1' && parts[1] === 'dev' && parts[2] === 'identities') {
      if (deps.dev !== true || !deps.identity) {
        json(response, 404, { error: 'not_found' })
        return
      }
      if (method === 'GET') {
        json(response, 200, { credentials: deps.identity.enrolled() })
        return
      }
      if (method === 'DELETE') {
        deps.identity.forgetAll()
        json(response, 200, { ok: true })
        return
      }
      json(response, 404, { error: 'not_found' })
      return
    }

    // GET /v1/log?from=&preset=
    if (method === 'GET' && parts.length === 2 && parts[0] === 'v1' && parts[1] === 'log') {
      const from = Number(url.searchParams.get('from') ?? '1')
      const records = log.from(Number.isFinite(from) ? from : 1)
      // `preset` narrows the chain to one preset's records. R20's rotation
      // sheet links here — "view in the transparency log" has to land on
      // something a person can read, and the whole chain is not that. The
      // records keep their real seq and prev, so a narrowed view is still
      // checkable against a full one rather than a different story.
      const preset = url.searchParams.get('preset')
      json(response, 200, {
        records: preset === null ? records : records.filter((r) => r.presetId === preset)
      })
      return
    }

    json(response, 404, { error: 'not_found' })
  })
}

/**
 * REGISTERING A DOOR — the write side of the directory.
 *
 * The handle is taken from the ASSERTION, never from the body: a listing that
 * let a caller name its own owner would let anyone park a team under someone
 * else's handle, which is the one thing a directory of other people's
 * addresses must not allow. The identity layer already mints a token for a
 * present authenticator; this reuses it rather than inventing a second way to
 * prove who is calling.
 */
async function handleDoorRegistration(
  doors: DoorStore,
  identity: IdentityService | undefined,
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  if (!identity) {
    // No identity service means nobody can prove a handle, and an unowned
    // listing is worse than no listing.
    json(response, 503, { error: 'identity_unavailable' })
    return
  }
  const body = await readJsonBody(request, 16 * 1024)
  if (!body.ok || typeof body.value !== 'object' || body.value === null) {
    json(response, 400, { error: 'malformed' })
    return
  }
  const input = body.value as { assertion?: unknown; door?: unknown; withdraw?: unknown }
  // No assertion → a challenge, the same ladder every other gated route here
  // climbs. Without it a client had to go and get one from an unrelated route,
  // which is how a ceremony ends up being started in two different places.
  if (input.assertion === undefined) {
    json(response, 401, { error: 'unidentified', challenge: identity.challenge() })
    return
  }
  const asserted = identity.assert(input.assertion as never, 'download')
  if (!asserted.ok) {
    json(response, 401, { error: 'unidentified' })
    return
  }
  // WITHDRAWING is a listing decision, not a lock: the door keeps working for
  // anyone holding its address. Only the handle that registered it may make it.
  if (typeof input.withdraw === 'string') {
    const gone = doors.withdraw(asserted.sub, input.withdraw)
    json(response, gone ? 200 : 404, gone ? { ok: true } : { error: 'not_found' })
    return
  }
  const result = doors.register(asserted.sub, input.door as DoorInput)
  if (!result.ok) {
    json(response, 400, { error: result.reason })
    return
  }
  json(response, 200, { door: result.door, path: doorPath(result.door.handle, result.door.name) })
}
