import type http from 'node:http'
import { timingSafeEqual } from 'node:crypto'

/** Small HTTP helpers shared by the mobile server's route modules. */

export function respondJson(
  response: http.ServerResponse,
  status: number,
  body: unknown
): void {
  // No access-control-allow-origin (C2): the phone UI is served same-origin
  // by this very server, so CORS is unneeded — and a wildcard let any web
  // page in any browser read transcripts and drive mutating routes.
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body ?? null))
}

/**
 * Pairing-token check for mutating mobile routes (C1): the desktop surfaces
 * the token once (as `?token=` on the pairing URL) and clients send it back
 * as `Authorization: Bearer <token>` — or as `?token=` for clients that
 * cannot set headers. Compared constant-time; a missing/short candidate
 * never matches.
 */
export function pairingAuthorized(
  request: Pick<http.IncomingMessage, 'headers'>,
  url: URL,
  token: string
): boolean {
  const header = request.headers.authorization
  const bearer = typeof header === 'string' && header.startsWith('Bearer ')
    ? header.slice('Bearer '.length)
    : null
  return secretEquals(bearer ?? url.searchParams.get('token'), token)
}

/**
 * Constant-time secret compare, for every credential this process checks.
 *
 * Extracted so there is ONE of these. `===` on a secret leaks its length and
 * then its prefix through timing — a slow leak, but the listener is 0.0.0.0
 * and the attacker chooses the retry rate. A missing or wrong-length candidate
 * short-circuits to false, which reveals only what the caller already knows
 * (timingSafeEqual requires equal lengths and would throw otherwise).
 */
export function secretEquals(candidate: string | null | undefined, secret: string): boolean {
  if (!candidate || !secret) return false
  const a = Buffer.from(candidate)
  const b = Buffer.from(secret)
  return a.length === b.length && timingSafeEqual(a, b)
}

export function readBody(request: http.IncomingMessage, limit = 1_000_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ''
    request.on('data', (chunk) => {
      data += chunk
      if (data.length > limit) reject(new Error('Body too large'))
    })
    request.on('end', () => resolve(data))
    request.on('error', reject)
  })
}

export async function readJson<T>(request: http.IncomingMessage, limit?: number): Promise<T> {
  const raw = await readBody(request, limit)
  return JSON.parse(raw || '{}') as T
}

export type SseSend = (event: string, data: unknown) => void

/**
 * Switch a response into a Server-Sent-Events stream. Returns the emitter;
 * register cleanup via `request.on('close', ...)` at the call site.
 */
export function startSse(response: http.ServerResponse): SseSend {
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-store',
    connection: 'keep-alive'
  })
  response.write(':ok\n\n')
  return (event, data) => {
    response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  }
}
