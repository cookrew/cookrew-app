import type { IncomingMessage } from 'node:http'
import { sessionTokenOf } from './v2-http'

/**
 * WHAT A CONSOLE SESSION MAY ASK FOR, AND NOTHING ELSE.
 *
 * The console is a page on its own origin. Its token lives in page storage,
 * where a script that got into the page could read it, so the token is worth
 * as little as the console can do with less: read who is signed in and the
 * account's machines as they look from outside, take the device pass, keep its
 * own session going and end it, sign in again. Reaching a machine is the relay
 * path, which reads the session from a header of its own and is not judged
 * here (v2-canvas-relay.ts).
 *
 * EVERYTHING ELSE IS REFUSED, by an allow-list checked once, before any route
 * runs: changing a password, a factor or a device, deleting the account,
 * minting a join code, a seat, a publish, a machine's own line. Those are done
 * on the auth host, behind a step-up, or by a machine's own session. An
 * allow-list rather than a list of the dangerous routes, so a route added
 * tomorrow is refused to the console until somebody decides otherwise.
 *
 * The mark is read from the token WITHOUT checking its signature. That is
 * enough here and cannot be turned around: a forged token wearing the mark is
 * only ever refused more, and one that hides it has a signature the route
 * itself then rejects (v2-tokens.ts · verify).
 */

const CONSOLE_ROUTES: readonly [method: string, path: RegExp][] = [
  ['GET', /^\/v2\/me$/],
  ['GET', /^\/v2\/me\/desktops$/],
  ['GET', /^\/v2\/me\/presence$/],
  ['POST', /^\/v2\/me\/device-grant$/],
  ['POST', /^\/v2\/me\/device-grant\/options$/],
  ['DELETE', /^\/v2\/sessions\/current$/],
  ['POST', /^\/v2\/sessions\/current$/],
  ['GET', /^\/v2\/sessions\/renew-nonce$/],
  ['POST', /^\/v2\/sessions\/renew$/],
  ['POST', /^\/v2\/auth\/requests$/],
  // A request's id is the registry's own random token (auth-requests.ts), not a uuid.
  ['POST', /^\/v2\/auth\/requests\/[A-Za-z0-9_-]{43}\/proof$/],
  ['POST', /^\/v2\/auth\/token$/],
  ['POST', /^\/v2\/verify-hello$/],
  ['GET', /^\/v2\/keys$/],
  ['GET', /^\/v2\/names\/[A-Za-z0-9.-]{1,255}$/]
]

/** Does this token say it is a console session? Its body is read; its signature is the route's to check. */
export function saysConsole(token: string | null): boolean {
  if (token === null) return false
  try {
    const body = token.split('.')[0]
    if (!body || body.length > 4096) return false
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as { via?: unknown }
    return claims.via === 'console'
  } catch {
    return false
  }
}

/** May a console session ask this at all? */
export const consoleMayAsk = (method: string, pathname: string): boolean =>
  CONSOLE_ROUTES.some(([allowed, path]) => allowed === method && path.test(pathname))

/**
 * True when this request carries a console session and asks for something a
 * console session is not for. The relay path is not this file's: its session
 * travels in another header.
 */
export function consoleScopeRefuses(request: IncomingMessage, method: string, pathname: string): boolean {
  if (pathname.startsWith('/api/m/')) return false
  if (!saysConsole(sessionTokenOf(request))) return false
  return !consoleMayAsk(method === 'HEAD' ? 'GET' : method, pathname)
}
