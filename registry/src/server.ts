import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { PRESET_VERSION_HEADER } from '../../src/shared/preset-manifest'
import { RegistryStore, isAddress } from './store'
import { TransparencyLog } from './log'
import type { IdentityService, TokenScope } from './identity'

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
   * DEV MODE. Mounts /v1/dev/* — a credential list and a reset, for a gate
   * matrix that must start from a known state. Off by default and never a
   * runtime toggle: a deployment either was started for development or it was
   * not, and an endpoint that can forget every credential must not be one flag
   * away in production.
   */
  dev?: boolean
}

function json(response: ServerResponse, code: number, body: unknown, headers: Record<string, string> = {}): void {
  const payload = Buffer.from(JSON.stringify(body), 'utf8')
  response.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(payload.byteLength),
    ...headers
  })
  response.end(payload)
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

  return createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://registry.local')
    const method = request.method ?? 'GET'
    const parts = url.pathname.split('/').filter(Boolean)

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
        json(response, verdict.code, verdict.code === 403 ? { reason: verdict.reason } : {}, headers)
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
        slice: 'P2-A2',
        dev: deps.dev === true,
        routes: [
          'GET /v1/health',
          'GET /v1/presets?q=',
          'GET /v1/presets/:id/manifest',
          'HEAD /v1/presets/:id/manifest',
          'GET /v1/blobs/:address',
          'GET /v1/log?from=',
          'POST /v1/identity/register',
          'POST /v1/identity/assert',
          ...(deps.dev === true ? ['GET /v1/dev/identities', 'DELETE /v1/dev/identities'] : [])
        ],
        // Named so a harness does not build fixtures against a route that is
        // never going to exist. Payment RETRIES the manifest GET with an
        // X-Payment header (spec §4); there is deliberately no confirm endpoint.
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

    // GET /v1/log?from=
    if (method === 'GET' && parts.length === 2 && parts[0] === 'v1' && parts[1] === 'log') {
      const from = Number(url.searchParams.get('from') ?? '1')
      json(response, 200, { records: log.from(Number.isFinite(from) ? from : 1) })
      return
    }

    json(response, 404, { error: 'not_found' })
  })
}
