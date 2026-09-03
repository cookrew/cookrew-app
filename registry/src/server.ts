import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
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
import { DoorStore, doorPath, type DoorInput, type DoorRecord } from './doors'
import { createRelayHttp, type RelayHttp } from './relay-http'
import { RESERVED_HANDLES, handlePage, homePage, marketPage, marketQuery, teamPage } from './site'
import { handleSiteRoute } from './site-routes'
import type { Pulse } from './pulse'
import type { CommitsCache } from './github-commits'
import { respondPage } from './site-shell'
import type { StarStore } from './stars'
import type { Release, ReleaseCache } from './releases'

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
  /**
   * The canonical public origin, for addresses printed on a page.
   *
   * Taken from the request's Host header when absent — which is right for a
   * dev registry reached by several names, and wrong for a deployment behind a
   * proxy, where Host is whatever the caller sent. A published address is
   * something a person will copy, so it is configured rather than reflected.
   */
  origin?: string
  /** Stars on served teams — a sort key for the market, never a gate. */
  stars?: StarStore
  /** The current build, from GitHub — the homepage's download buttons and /download. */
  releases?: ReleaseCache
  /** Today's counts — lines opened per door, pages viewed. Never who. */
  pulse?: Pulse
  /** The dev branch's latest commits, for the homepage's built-in-the-open feed. */
  commits?: CommitsCache
}

/** An account name: the same shape a handle has everywhere else on this site. */
const HANDLE_SHAPE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/

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
    ? createRelayHttp({
        identity: deps.identity,
        log: deps.note,
        onAnswer: (name, method, path, status) => {
          if (status >= 400) return
          deps.pulse?.door(name, method === 'GET' && status === 200 && (path === '/line' || path.startsWith('/line?')) ? 'line' : 'call')
        }
      })
    : null

  /**
   * IS THIS DOOR ACTUALLY THERE?
   *
   * A record and a connection are different things, and the directory used to
   * know only the first. So a team stayed listed as though it were available
   * for as long as its record lasted, while its author's laptop had been shut
   * since Tuesday — somebody would paste the address, be told nobody was
   * serving it, and reasonably conclude the address was wrong.
   *
   * The relay already knows: it is holding the connection or it is not. This
   * is that answer, computed per response and never stored, because a stored
   * one would be the same lie with an extra step.
   */
  const live = (handle: string, name: string): boolean =>
    relay?.hub.has(`@${handle}/${name}`) ?? false
  const withLive = (door: DoorRecord): DoorRecord & { live: boolean } => ({
    ...door,
    live: live(door.handle, door.name)
  })
  const withStars = (door: DoorRecord): DoorRecord & { live: boolean; stars: number; today: { lines: number; calls: number } } => ({
    ...withLive(door),
    stars: deps.stars?.count(door.handle, door.name) ?? 0,
    today: deps.pulse?.doorToday(`@${door.handle}/${door.name}`) ?? { lines: 0, calls: 0 }
  })
  const pulseOf = (handle: string, name: string): { lines: number; calls: number } =>
    deps.pulse?.doorToday(`@${handle}/${name}`) ?? { lines: 0, calls: 0 }

  // NO REQUEST TIMEOUT. Node's default (300s) sends 408 to any request whose
  // body has not finished — and a door's uplink is a POST whose body never
  // finishes by design. Under the default, every door lost its uplink at
  // 312s on the dot (nginx: upstream_status 408), redialled, and every
  // exchange in flight died 'door-gone' — a five-minute zombie metronome.
  // Header parsing keeps its own bound; only the body may take forever.
  /**
   * WHO IS READING A PAGE. The site's script keeps the account token in a
   * cookie so the market can render stars and the starred tab on the server;
   * the JSON routes take it as a Bearer. Either way it is the identity
   * service's own token, verified here, never trusted from its shape. A
   * `call` token is for one door, not for this registry, and does not count.
   */
  const accountOf = (request: IncomingMessage, mode: 'any' | 'bearer' = 'any'): string | null => {
    const identity = deps.identity
    if (!identity) return null
    const auth = request.headers.authorization ?? ''
    const cookie =
      mode === 'bearer' ? undefined : /(?:^|;\s*)cr_account=([A-Za-z0-9_.-]+)/.exec(request.headers.cookie ?? '')?.[1]
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : cookie
    if (!token) return null
    const claims = identity.verifyToken(token)
    if (!claims || claims.scope === 'call') return null
    return claims.sub
  }
  const starsOf = (handle: string, name: string): number => deps.stars?.count(handle, name) ?? 0
  /** Headers for an answer that depends on who asked: never shared, never cached. */
  const PRIVATE: Record<string, string> = { 'cache-control': 'private, no-store', vary: 'cookie, authorization' }

  /** decodeURIComponent that answers null instead of throwing on a bad escape. */
  const decode = (value: string): string | null => {
    try {
      return decodeURIComponent(value)
    } catch {
      return null
    }
  }

  return createServer({ requestTimeout: 0, headersTimeout: 60_000 }, (request, response) => {
    try {
      route(request, response)
    } catch (error) {
      // A request that throws is a malformed request, not a dead registry:
      // the process holds every door's downlink, and one bad path segment
      // must never take those down.
      deps.note?.(`request failed: ${error instanceof Error ? error.message : String(error)}`)
      if (!response.headersSent) json(response, 400, { error: 'malformed' })
      else response.end()
    }
  })

  function route(request: IncomingMessage, response: ServerResponse): void {
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
      json(response, 200, {
        doors: deps.doors.list(url.searchParams.get('q') ?? '').map(withStars)
      })
      return
    }
    // ★ /v1/doors/@handle/name/star — GET the count (and whether the reader
    // starred it), POST to toggle. One per account per team; a sort key for
    // the market and nothing more, so it never gates and never prices.
    if (deps.doors && deps.stars && parts.length === 5 && parts[0] === 'v1' && parts[1] === 'doors' && parts[4] === 'star') {
      if (method !== 'GET' && method !== 'POST') {
        json(response, 405, { error: 'method_not_allowed' }, { allow: 'GET, POST' })
        return
      }
      const handle = (decode(parts[2]) ?? '').replace(/^@/, '')
      const name = decode(parts[3]) ?? ''
      if (!deps.doors.get(handle, name)) {
        json(response, 404, { error: 'not_found' })
        return
      }
      if (method === 'GET') {
        const account = accountOf(request)
        json(response, 200, {
          stars: deps.stars.count(handle, name),
          starred: account !== null && deps.stars.starred(account, handle, name)
        }, PRIVATE)
        return
      }
      // A state change takes the Bearer only — never the cookie, so a page on
      // another origin cannot star on a reader's behalf.
      const account = accountOf(request, 'bearer')
      if (account === null) {
        json(response, 401, { error: 'unidentified' }, PRIVATE)
        return
      }
      const out = deps.stars.toggle(account, handle, name)
      json(response, out === null ? 400 : 200, out ?? { error: 'malformed' }, PRIVATE)
      return
    }
    // GET /v1/doors/@handle — everything one owner is serving. The account
    // page and the import sheet both need it, and both used to have to fetch
    // the whole directory and filter it themselves.
    if (deps.doors && method === 'GET' && parts.length === 3 && parts[0] === 'v1' && parts[1] === 'doors') {
      const handle = decodeURIComponent(parts[2]).replace(/^@/, '')
      json(response, 200, {
        handle,
        doors: deps.doors.list().filter((d) => d.handle === handle).map(withStars)
      })
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
      json(response, 200, withStars(found))
      return
    }
    if (deps.doors && method === 'POST' && parts.length === 2 && parts[0] === 'v1' && parts[1] === 'doors') {
      handleDoorRegistration(deps.doors, deps.identity, request, response).catch((error: unknown) => {
        deps.note?.(`door registration failed: ${error instanceof Error ? error.message : String(error)}`)
        if (!response.headersSent) json(response, 400, { error: 'malformed' })
      })
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

    // POST /v1/identity/challenge — a login nonce for the site's own ceremony.
    // Every other route hands one out only inside a 401; a page signing in on
    // purpose should not have to provoke a refusal to get one.
    if (deps.identity && method === 'POST' && parts.length === 3 && parts[0] === 'v1' && parts[1] === 'identity' && parts[2] === 'challenge') {
      json(response, 200, { challenge: deps.identity.challenge() })
      return
    }
    // GET /v1/identity/key — the token key's public half, for a DOOR to verify
    // a call token without asking here on every knock.
    if (deps.identity && method === 'GET' && parts.length === 3 && parts[0] === 'v1' && parts[1] === 'identity' && parts[2] === 'key') {
      json(response, 200, { jwk: deps.identity.publicKeyJwk() })
      return
    }
    // GET /v1/identity/whoami — the account a Bearer (or the site cookie) names.
    if (deps.identity && method === 'GET' && parts.length === 3 && parts[0] === 'v1' && parts[1] === 'identity' && parts[2] === 'whoami') {
      const sub = accountOf(request)
      json(response, sub === null ? 401 : 200, sub === null ? {} : { sub }, PRIVATE)
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
          // The credential id becomes an ACCOUNT — the handle the market
          // prints and stars key on — so it is held to the handle's shape
          // here, not only by the page that offered it.
          if (
            typeof parsed.credentialId !== 'string' ||
            !HANDLE_SHAPE.test(parsed.credentialId) ||
            typeof parsed.publicKeyJwk !== 'object' ||
            parsed.publicKeyJwk === null
          ) {
            json(response, 400, { error: 'bad_request' })
            return
          }
          const out = identity.register(parsed.credentialId, parsed.publicKeyJwk)
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
          const scope: TokenScope =
            parsed.scope === 'publish' ? 'publish' : parsed.scope === 'call' ? 'call' : 'download'
          const out = identity.assert(
            {
              credentialId: parsed.credentialId,
              clientDataJSON: parsed.clientDataJSON,
              authenticatorData: parsed.authenticatorData,
              signature: parsed.signature
            },
            scope,
            typeof parsed.aud === 'string' ? parsed.aud : undefined
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

    // ── THE SITE'S OWN ROUTES — crawl files, features, start, assets, /download ──
    if (
      handleSiteRoute({
        method,
        parts,
        url,
        request,
        response,
        decode,
        doors: () => (deps.doors?.list() ?? []).map(withLive),
        release: () => (deps.releases?.latest() ?? Promise.resolve<Release | null>(null)).catch(() => null),
        pulse: deps.pulse,
        note: deps.note
      })
    )
      return

    // ── THE PUBLIC FACE, last ────────────────────────────────────────────
    //
    // Last because an owner's page lives at /<handle>, which would otherwise
    // shadow every route above it. Reaching here means nothing more specific
    // claimed the path — and RESERVED_HANDLES keeps that true even for a route
    // added tomorrow, so a handle can never capture one.
    if (deps.doors && method === 'GET') {
      const site = deps.doors
      // The @ is optional everywhere a person types a name. `@drej/alpha` is
      // what the app passes around; `/drej/alpha` is what somebody reads out.
      const bare = (value: string): string => (decode(value) ?? '').replace(/^@/, '')

      if (parts.length === 0) {
        deps.pulse?.page('/')
        void Promise.all([
          (deps.releases?.latest() ?? Promise.resolve<Release | null>(null)).catch(() => null),
          (deps.commits?.latest() ?? Promise.resolve(null)).catch(() => null)
        ])
          .then(([release, commits]) => {
            respondPage(
              response,
              homePage({
                doors: site.list().map(withLive),
                release,
                stars: starsOf,
                pulse: pulseOf,
                linesToday: deps.pulse?.linesToday() ?? 0,
                commits
              })
            )
          })
          .catch((error: unknown) => {
            deps.note?.(`render failed: ${error instanceof Error ? error.message : String(error)}`)
            if (!response.headersSent) json(response, 500, { error: 'server' })
          })
        return
      }
      if (parts.length === 1 && parts[0] === 'market') {
        deps.pulse?.page('/market')
        const account = accountOf(request)
        respondPage(
          response,
          marketPage({
            doors: site.list().map(withLive),
            presets: store.list(),
            query: marketQuery(url.searchParams),
            stars: starsOf,
            account,
            starredTeams: account === null ? [] : (deps.stars?.byAccount(account) ?? [])
          })
        )
        return
      }
      if (parts.length === 1 && !RESERVED_HANDLES.has(parts[0].toLowerCase())) {
        const handle = bare(parts[0])
        respondPage(
          response,
          handlePage(handle, site.list().filter((d) => d.handle === handle).map(withLive), starsOf)
        )
        return
      }
      if (parts.length === 2 && !RESERVED_HANDLES.has(parts[0].toLowerCase())) {
        const at = deps.origin ?? originOf(request.headers.host) ?? ''
        const handle = bare(parts[0])
        const name = bare(parts[1])
        const found = site.get(handle, name)
        const account = accountOf(request)
        if (found) deps.pulse?.page(`/${handle}/${name}`)
        respondPage(
          response,
          teamPage({
            door: found === null ? null : withLive(found),
            origin: at,
            stars: starsOf(handle, name),
            starred: account !== null && (deps.stars?.starred(account, handle, name) ?? false),
            account
          })
        )
        return
      }
    }

    json(response, 404, { error: 'not_found' })
  }
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
