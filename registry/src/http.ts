import type { IncomingMessage, ServerResponse } from 'node:http'

/**
 * The three ways this registry answers. Shared by the routes in server.ts and
 * the write handlers in publish-routes.ts — one definition, because a second
 * `json` that forgot a header is exactly the kind of drift nobody notices until
 * a response is missing a content-length.
 */

export function json(
  response: ServerResponse,
  code: number,
  body: unknown,
  headers: Record<string, string> = {}
): void {
  const payload = Buffer.from(JSON.stringify(body), 'utf8')
  response.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(payload.byteLength),
    ...headers
  })
  response.end(payload)
}

/**
 * The install page's answer. Sent with headers that make the document inert
 * even if a future edit puts something executable in it: no script, no frame,
 * no sniffing, no referrer leaking a shared preset link onward.
 */
export function html(response: ServerResponse, code: number, body: string): void {
  const payload = Buffer.from(body, 'utf8')
  response.writeHead(code, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': String(payload.byteLength),
    'content-security-policy':
      "default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; script-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'",
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    // A preset can be republished under a new address and an old one removed,
    // so this is a page about mutable state — brief caching only.
    'cache-control': 'public, max-age=60'
  })
  response.end(payload)
}

export type BodyResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; reason: 'too_large' | 'bad_json' }

/**
 * Read a JSON body, refusing one that is too big rather than growing memory on
 * a socket. `limit` differs by route because the shapes do: an assertion is
 * small and fixed, a publish carries a team.
 */
export function readJsonBody(request: IncomingMessage, limit: number): Promise<BodyResult> {
  return new Promise((resolve) => {
    let body = ''
    let settled = false
    const settle = (result: BodyResult): void => {
      if (settled) return
      settled = true
      resolve(result)
    }
    request.on('data', (chunk) => {
      // Past the limit we DRAIN rather than store, and rather than destroy.
      //
      // Destroying the socket was the first version and it is why a caller saw
      // EPIPE instead of an answer: the connection died before the 413 could be
      // written, so an oversized publish was indistinguishable from a network
      // fault. Draining keeps memory bounded — nothing is accumulated — while
      // leaving the response writable, and it avoids the deadlock that simply
      // pausing would risk against a client still writing its body.
      if (settled) return
      body += chunk
      if (body.length > limit) {
        body = ''
        settle({ ok: false, reason: 'too_large' })
        request.resume()
      }
    })
    request.on('end', () => {
      try {
        const parsed = JSON.parse(body) as unknown
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          settle({ ok: false, reason: 'bad_json' })
          return
        }
        settle({ ok: true, value: parsed as Record<string, unknown> })
      } catch {
        settle({ ok: false, reason: 'bad_json' })
      }
    })
    request.on('error', () => settle({ ok: false, reason: 'bad_json' }))
  })
}
