import { describe, expect, it } from 'vitest'
import { authOriginPolicy } from '../registry/src/auth-origin-policy'

describe('auth origin routing', () => {
  const origin = 'https://auth.cookrew.dev'

  it('serves only the standalone entry and its own exact assets on the auth origin', () => {
    expect(authOriginPolicy({ configuredOrigin: origin, host: 'auth.cookrew.dev', path: '/sign-in', method: 'GET' })).toBe('page')
    expect(authOriginPolicy({ configuredOrigin: origin, host: 'auth.cookrew.dev', path: '/', method: 'GET' })).toBe('redirect')
    expect(authOriginPolicy({ configuredOrigin: origin, host: 'auth.cookrew.dev', path: '/assets/auth-site.js', method: 'GET' })).toBe('asset')
    expect(authOriginPolicy({ configuredOrigin: origin, host: 'auth.cookrew.dev', path: '/assets/inter.woff2', method: 'GET' })).toBe('asset')
    expect(authOriginPolicy({ configuredOrigin: origin, host: 'auth.cookrew.dev', path: '/v2/sessions', method: 'POST' })).toBe('auth-api')
  })

  it('never exposes the marketplace, relay, unrelated account APIs or arbitrary assets under the auth origin', () => {
    for (const path of ['/v1/relay', '/me', '/market', '/v2/me', '/assets/site.js', '/assets/constructor', '/v2/keys']) {
      expect(authOriginPolicy({ configuredOrigin: origin, host: 'auth.cookrew.dev', path, method: 'GET' }), path).toBe('deny')
    }
    expect(authOriginPolicy({ configuredOrigin: origin, host: 'auth.cookrew.dev', path: '/sign-in', method: 'POST' })).toBe('deny')
  })

  it('does not intercept the product origin or spoofed host', () => {
    for (const host of ['cookrew.dev', 'auth.cookrew.dev.evil.test', 'evil.test']) {
      expect(authOriginPolicy({ configuredOrigin: origin, host, path: '/sign-in', method: 'GET' })).toBe('other-origin')
    }
  })

  it('recognizes exact configured ports, but never matches a different port', () => {
    const configuredOrigin = 'http://127.0.0.1:9876'
    expect(authOriginPolicy({ configuredOrigin, host: '127.0.0.1:9876', path: '/', method: 'GET' })).toBe('redirect')
    expect(authOriginPolicy({ configuredOrigin, host: '127.0.0.1:9877', path: '/', method: 'GET' })).toBe('other-origin')
  })
})

it('protects canonical auth host spellings with unset and custom origins', () => {
  for (const configuredOrigin of [null, 'http://127.0.0.1:9876', 'https://auth.cookrew.dev']) {
    for (const host of ['auth.cookrew.dev', 'AUTH.COOKREW.DEV.', 'auth.cookrew.dev.:443', 'auth.cookrew.dev:443']) {
      expect(authOriginPolicy({ configuredOrigin, host, path: '/v1/health', method: 'GET' }), `${configuredOrigin} ${host}`).toBe('deny')
    }
    expect(authOriginPolicy({ configuredOrigin, host: 'cookrew.dev', path: '/v1/health', method: 'GET' })).toBe('other-origin')
  }
})


it('treats an explicit default TLS port as the same protected auth host', () => {
  expect(authOriginPolicy({ configuredOrigin: 'https://auth.cookrew.dev', host: 'auth.cookrew.dev:443', path: '/me', method: 'GET' })).toBe('deny')
})

it('denies malformed host authorities', () => {
  for (const host of ['auth.cookrew.dev:', 'auth.cookrew.dev@evil.test', 'auth.cookrew.dev/path', 'auth.cookrew.dev:0443', 'auth.cookrew.dev:443:443', 'auth..cookrew.dev', 'cookrew.dev:65536']) {
    expect(authOriginPolicy({ configuredOrigin: 'https://auth.cookrew.dev', host, path: '/', method: 'GET' }), host).toBe('deny')
  }
})

it('fails closed on malformed auth-origin configuration', () => {
  for (const configuredOrigin of ['not a url', 'https://auth.cookrew.dev/path', 'http://auth.cookrew.dev', 'https://user@auth.cookrew.dev', 'https://auth.cookrew.dev?x=1', 'https://auth.cookrew.dev/unexpected/..', 'https://auth.cookrew.dev?', 'https://auth.cookrew.dev#', 'https://auth.cookrew.dev:0443']) {
    expect(() => authOriginPolicy({ configuredOrigin, host: 'auth.cookrew.dev', path: '/', method: 'GET' }), configuredOrigin).toThrow()
  }
})

it('accepts exact pending passkey routes and refuses wrong methods', () => {
  const base = { configuredOrigin: 'https://auth.cookrew.dev', host: 'auth.cookrew.dev' }
  const pending = '01234567-89ab-cdef-0123-456789abcdef'
  expect(authOriginPolicy({ ...base, path: `/v2/sessions/${pending}/passkey/options`, method: 'GET' })).toBe('auth-api')
  expect(authOriginPolicy({ ...base, path: `/v2/sessions/${pending}/passkey`, method: 'POST' })).toBe('auth-api')
  expect(authOriginPolicy({ ...base, path: `/v2/sessions/${pending}/passkey`, method: 'GET' })).toBe('deny')
})

it('routes underscore product hosts such as container service names to the product origin', () => {
  for (const configuredOrigin of [null, 'http://127.0.0.1:9876', 'https://auth.cookrew.dev']) {
    for (const host of ['my_registry:8790', 'my_registry', 'MY_REGISTRY:8790', 'my_registry.:8790', 'svc.my_registry.internal:8790']) {
      expect(authOriginPolicy({ configuredOrigin, host, path: '/v1/health', method: 'GET' }), `${configuredOrigin} ${host}`).toBe('other-origin')
    }
  }
})

it('denies malformed underscore authorities', () => {
  for (const host of ['my_registry:', 'my_registry:08790', 'my_registry:0', 'my_registry:65536', 'my_registry:8790:8790', 'my_registry@evil.test', 'my_registry/path', 'my_registry..internal', '_', '_registry', 'registry_', 'my_registry:+8790', 'my_registry :8790', `${'a_'.repeat(32)}b`]) {
    expect(authOriginPolicy({ configuredOrigin: 'https://auth.cookrew.dev', host, path: '/', method: 'GET' }), host).toBe('deny')
  }
})

it('denies normalized auth host variants on default and nondefault ports', () => {
  for (const configuredOrigin of [null, 'http://127.0.0.1:9876', 'https://auth.cookrew.dev']) {
    for (const host of ['auth.cookrew.dev.', 'Auth.Cookrew.Dev', 'auth.cookrew.dev:80', 'auth.cookrew.dev.:80', 'auth.cookrew.dev:8790', 'AUTH.COOKREW.DEV.:8790', 'auth.cookrew.dev:443', 'auth.cookrew.dev.:443']) {
      expect(authOriginPolicy({ configuredOrigin, host, path: '/v1/health', method: 'GET' }), `${configuredOrigin} ${host}`).toBe('deny')
    }
  }
})
