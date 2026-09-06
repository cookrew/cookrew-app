import type http from 'node:http'
import { describe, expect, it } from 'vitest'
import {
  allowedOrigin,
  applyCompanionCors,
  companionCorsHeaders,
  CORS_ALLOW_HEADERS,
  CORS_ALLOW_METHODS,
  CORS_MAX_AGE
} from '../src/main/companion-cors'
import { originAllowed } from '../src/main/browser-cast'

/**
 * The phone's page stays at cookrew.dev while its data plane moves onto this
 * Mac's own name, so these headers are the difference between a fast path and
 * no path at all — and a wildcard here would be every page in every browser
 * reading transcripts off a machine on somebody's LAN.
 */

const REGISTRY = 'https://cookrew.dev'
const MAC = '3f2b9c14-7a55-4d2e-9d0f-1c8e6b4a7f30'
const LAN = 'https://192.168.2.40:8643'
const NAMED = `https://192-168-2-40.${MAC}.d.cookrew.dev:8643`
const ALLOWED = [REGISTRY, LAN, NAMED]

/** A ServerResponse with just the surface the gate touches. */
const fakeResponse = (): http.ServerResponse & {
  set: Record<string, string>
  head: { status: number; headers: Record<string, string> } | null
  ended: boolean
} => {
  const set: Record<string, string> = {}
  const state = {
    set,
    head: null as { status: number; headers: Record<string, string> } | null,
    ended: false,
    setHeader: (name: string, value: string) => {
      set[name.toLowerCase()] = value
    },
    writeHead: (status: number, headers: Record<string, string> = {}) => {
      state.head = { status, headers }
      return state
    },
    end: () => {
      state.ended = true
    }
  }
  return state as unknown as ReturnType<typeof fakeResponse>
}

const request = (origin: string | undefined, method = 'GET'): http.IncomingMessage =>
  ({ headers: origin === undefined ? {} : { origin }, method }) as unknown as http.IncomingMessage

describe('which origins the companion answers for', () => {
  it('matches the whole origin, exactly', () => {
    expect(allowedOrigin(REGISTRY, ALLOWED)).toBe(REGISTRY)
    expect(allowedOrigin(NAMED, ALLOWED)).toBe(NAMED)
    // A trailing slash is the same origin; everything else is not.
    expect(allowedOrigin(`${REGISTRY}/`, ALLOWED)).toBe(REGISTRY)
  })

  it('refuses every near miss', () => {
    for (const origin of [
      'https://notcookrew.dev',
      'https://cookrew.dev.attacker.example',
      'https://evil.example',
      'http://cookrew.dev',
      'https://cookrew.dev:8443',
      `https://192-168-2-40.someone-else.d.cookrew.dev:8643`,
      'null',
      '',
      undefined
    ]) {
      expect(allowedOrigin(origin, ALLOWED), String(origin)).toBeNull()
    }
  })

  it('never answers when the allow-list is empty', () => {
    expect(allowedOrigin(REGISTRY, [])).toBeNull()
    expect(allowedOrigin(REGISTRY, ['', ''])).toBeNull()
  })
})

describe('the headers a companion request gets', () => {
  it('names the methods, the headers and the age — and no credentials', () => {
    const headers = companionCorsHeaders(REGISTRY, ALLOWED)
    expect(headers['access-control-allow-origin']).toBe(REGISTRY)
    expect(headers['access-control-allow-methods']).toBe(CORS_ALLOW_METHODS)
    for (const verb of ['GET', 'POST', 'PUT', 'DELETE']) {
      expect(CORS_ALLOW_METHODS).toContain(verb)
    }
    expect(headers['access-control-allow-headers']).toBe(CORS_ALLOW_HEADERS)
    expect(CORS_ALLOW_HEADERS).toContain('authorization')
    expect(CORS_ALLOW_HEADERS).toContain('content-type')
    expect(headers['access-control-max-age']).toBe(CORS_MAX_AGE)
    // Ambient authority must never ride along; the pairing token is sent
    // deliberately, as a header, by a page that holds it.
    expect(headers['access-control-allow-credentials']).toBeUndefined()
  })

  it('varies on origin whether or not the origin was allowed', () => {
    expect(companionCorsHeaders(REGISTRY, ALLOWED).vary).toBe('origin')
    expect(companionCorsHeaders('https://evil.example', ALLOWED).vary).toBe('origin')
    expect(companionCorsHeaders(undefined, ALLOWED).vary).toBe('origin')
  })

  it('says nothing else to an origin it refuses', () => {
    const headers = companionCorsHeaders('https://evil.example', ALLOWED)
    expect(headers['access-control-allow-origin']).toBeUndefined()
    expect(headers['access-control-allow-methods']).toBeUndefined()
    expect(Object.keys(headers)).toEqual(['vary'])
  })
})

describe('the gate in front of every route', () => {
  it('answers a preflight 204 and stops, before any auth runs', () => {
    const response = fakeResponse()
    expect(applyCompanionCors(request(REGISTRY, 'OPTIONS'), response, ALLOWED)).toBe(true)
    expect(response.head?.status).toBe(204)
    expect(response.ended).toBe(true)
    expect(response.set['access-control-allow-origin']).toBe(REGISTRY)
    expect(response.set['access-control-allow-methods']).toBe(CORS_ALLOW_METHODS)
  })

  it('refuses a preflight from anywhere else with no allow-origin at all', () => {
    const response = fakeResponse()
    expect(applyCompanionCors(request('https://evil.example', 'OPTIONS'), response, ALLOWED)).toBe(true)
    expect(response.head?.status).toBe(204)
    expect(response.set['access-control-allow-origin']).toBeUndefined()
    expect(response.set.vary).toBe('origin')
  })

  it('sets headers and falls through for a real request', () => {
    const response = fakeResponse()
    expect(applyCompanionCors(request(NAMED, 'POST'), response, ALLOWED)).toBe(false)
    expect(response.ended).toBe(false)
    expect(response.set['access-control-allow-origin']).toBe(NAMED)
  })

  it('leaves a same-origin request unmarked but still varying', () => {
    const response = fakeResponse()
    expect(applyCompanionCors(request(undefined), response, ALLOWED)).toBe(false)
    expect(response.set['access-control-allow-origin']).toBeUndefined()
    expect(response.set.vary).toBe('origin')
  })
})

describe('the WebSocket origin guard', () => {
  const host = '192.168.2.40:8643'

  it('accepts the registry and this Mac’s own names', () => {
    expect(originAllowed({ headers: { origin: REGISTRY, host } }, ALLOWED)).toBe(true)
    expect(originAllowed({ headers: { origin: NAMED, host } }, ALLOWED)).toBe(true)
    // Same host needs no list at all — the rule that was here before.
    expect(originAllowed({ headers: { origin: `https://${host}`, host } })).toBe(true)
  })

  it('refuses every other page, list or no list', () => {
    for (const origin of [
      'https://evil.example',
      'https://notcookrew.dev',
      'https://cookrew.dev.attacker.example',
      `https://192-168-2-40.someone-else.d.cookrew.dev:8643`,
      'not a url'
    ]) {
      expect(originAllowed({ headers: { origin, host } }, ALLOWED), origin).toBe(false)
      expect(originAllowed({ headers: { origin, host } }), origin).toBe(false)
    }
  })

  it('still lets a client that sends no Origin through', () => {
    // A browser always sends one; this is the app's own renderer and tests.
    expect(originAllowed({ headers: { host } }, ALLOWED)).toBe(true)
  })
})
