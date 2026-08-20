import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { PRESET_VERSION_HEADER } from '../../src/shared/preset-manifest'
import { RegistryStore, isAddress } from './store'
import { TransparencyLog } from './log'

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

    // GET /v1/log?from=
    if (method === 'GET' && parts.length === 2 && parts[0] === 'v1' && parts[1] === 'log') {
      const from = Number(url.searchParams.get('from') ?? '1')
      json(response, 200, { records: log.from(Number.isFinite(from) ? from : 1) })
      return
    }

    json(response, 404, { error: 'not_found' })
  })
}
