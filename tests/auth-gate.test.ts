import { describe, expect, it, vi } from 'vitest'
import {
  AuthError,
  authHeaders,
  createAuthStore,
  isAuthError,
  reauthMessage,
  TOKEN_KEY,
  tokenFromInput,
  tokenParam,
  type StorageLike
} from '../src/renderer/src/auth-gate'

function memoryStorage(seed: Record<string, string> = {}): StorageLike & { data: Record<string, string> } {
  const data = { ...seed }
  return {
    data,
    getItem: (key) => data[key] ?? null,
    setItem: (key, value) => {
      data[key] = value
    },
    removeItem: (key) => {
      delete data[key]
    }
  }
}

describe('tokenFromInput', () => {
  it('lifts the token out of a pasted pairing URL', () => {
    expect(tokenFromInput('https://workbench.example.ts.net:8643/?token=abc123')).toBe('abc123')
    expect(tokenFromInput('http://192.168.2.13:8639/?token=abc123')).toBe('abc123')
  })

  it('accepts a bare token', () => {
    expect(tokenFromInput('  abc123  ')).toBe('abc123')
  })

  it('REJECTS a URL with no token rather than pasting the URL as a token', () => {
    // Accepting this would "succeed" here and fail on the next request, which
    // is the confusion the re-pair screen exists to end.
    expect(tokenFromInput('https://workbench.example.ts.net:8643/')).toBeNull()
    expect(tokenFromInput('https://workbench.example.ts.net:8643/?token=')).toBeNull()
  })

  it('rejects empty input and anything with whitespace or a path', () => {
    expect(tokenFromInput('')).toBeNull()
    expect(tokenFromInput('   ')).toBeNull()
    expect(tokenFromInput('two words')).toBeNull()
    expect(tokenFromInput('not/a/token')).toBeNull()
  })

  it('rejects a malformed URL without throwing', () => {
    expect(tokenFromInput('https://[not-a-url')).toBeNull()
  })
})

describe('createAuthStore — where the token comes from', () => {
  it('prefers a token on the URL and persists it', () => {
    const local = memoryStorage()
    const store = createAuthStore({ local, search: '?token=fresh' })
    expect(store.token()).toBe('fresh')
    expect(local.data[TOKEN_KEY]).toBe('fresh')
  })

  it('falls back to storage when the URL has none', () => {
    const store = createAuthStore({ local: memoryStorage({ [TOKEN_KEY]: 'stored' }), search: '' })
    expect(store.token()).toBe('stored')
  })

  it('MIGRATES a token paired before the move to localStorage', () => {
    // sessionStorage is dropped when iOS discards the tab, which read as
    // "randomly unpaired". Old pairings are carried over rather than lost.
    const local = memoryStorage()
    const store = createAuthStore({
      local,
      session: memoryStorage({ [TOKEN_KEY]: 'legacy' }),
      search: ''
    })
    expect(store.token()).toBe('legacy')
    expect(local.data[TOKEN_KEY]).toBe('legacy')
  })

  it('has no token when nothing supplies one', () => {
    expect(createAuthStore({ local: memoryStorage(), search: '' }).token()).toBeNull()
  })
})

describe('createAuthStore — the blocked state', () => {
  it('starts unblocked and publishes the first failure', () => {
    const store = createAuthStore({ local: memoryStorage(), search: '' })
    const seen = vi.fn()
    store.subscribe(seen)
    expect(store.blocked()).toBeNull()

    store.report(new AuthError('nope', 'none'))
    expect(store.blocked()?.scope).toBe('none')
    expect(seen).toHaveBeenCalledTimes(1)
  })

  it('does NOT re-publish an identical failure — every keystroke 401s', () => {
    const store = createAuthStore({ local: memoryStorage(), search: '' })
    const seen = vi.fn()
    store.subscribe(seen)
    for (let i = 0; i < 20; i += 1) store.report(new AuthError('nope', 'none'))
    expect(seen).toHaveBeenCalledTimes(1)
  })

  it('publishes when the REASON changes', () => {
    const store = createAuthStore({ local: memoryStorage(), search: '' })
    const seen = vi.fn()
    store.subscribe(seen)
    store.report(new AuthError('nope', 'none'))
    store.report(new AuthError('read only', 'read-only'))
    expect(seen).toHaveBeenCalledTimes(2)
    expect(store.blocked()?.scope).toBe('read-only')
  })

  it('clears the block when a new token is saved', () => {
    const local = memoryStorage()
    const store = createAuthStore({ local, search: '' })
    const seen = vi.fn()
    store.subscribe(seen)
    store.report(new AuthError('nope', 'none'))
    store.save('new-token')
    expect(store.blocked()).toBeNull()
    expect(store.token()).toBe('new-token')
    expect(local.data[TOKEN_KEY]).toBe('new-token')
    expect(seen).toHaveBeenLastCalledWith(null)
  })

  it('forgets the token on clear, including a legacy session copy', () => {
    const local = memoryStorage({ [TOKEN_KEY]: 'a' })
    const session = memoryStorage({ [TOKEN_KEY]: 'a' })
    const store = createAuthStore({ local, session, search: '' })
    store.clear()
    expect(store.token()).toBeNull()
    expect(local.data[TOKEN_KEY]).toBeUndefined()
    expect(session.data[TOKEN_KEY]).toBeUndefined()
  })

  it('stops notifying an unsubscribed listener', () => {
    const store = createAuthStore({ local: memoryStorage(), search: '' })
    const seen = vi.fn()
    store.subscribe(seen)()
    store.report(new AuthError('nope', 'none'))
    expect(seen).not.toHaveBeenCalled()
  })
})

describe('AuthError', () => {
  it('is recognisable across the module boundary', () => {
    expect(isAuthError(new AuthError('x'))).toBe(true)
    expect(isAuthError(new Error('x'))).toBe(false)
    expect(isAuthError(null)).toBe(false)
  })
})

describe('reauthMessage', () => {
  it('tells an unpaired device where to get a URL', () => {
    expect(reauthMessage('none')).toContain('cookrew mobile')
  })

  it('distinguishes read-only from unpaired', () => {
    expect(reauthMessage('read-only')).toContain('read-only')
    expect(reauthMessage('read-only')).not.toBe(reauthMessage('none'))
  })
})

describe('tokenParam / authHeaders — carrying the token to a gated read', () => {
  // Reads are gated now (mobile-api's C1 choke point). Every ordinary call
  // already sent `Authorization: Bearer`, so the only clients that needed
  // anything new are the ones that CANNOT set a header — both EventSource.
  it('appends the token, respecting an existing query string', () => {
    expect(tokenParam('/api/events', 'abc123')).toBe('/api/events?token=abc123')
    expect(tokenParam('/api/browser/b1/thumb?v=7', 'abc123')).toBe(
      '/api/browser/b1/thumb?v=7&token=abc123'
    )
  })

  it('percent-encodes, so a token is never read as more query', () => {
    expect(tokenParam('/api/events', 'a b&c=d')).toBe('/api/events?token=a%20b%26c%3Dd')
  })

  it('leaves the path untouched when there is no token', () => {
    // An unpaired client should get the same 401 an anonymous one gets, not a
    // URL carrying the string "null" — which would read as a wrong token
    // rather than as no token.
    expect(tokenParam('/api/events', null)).toBe('/api/events')
  })

  it('authHeaders is a bearer header, or nothing at all', () => {
    expect(authHeaders('abc123')).toEqual({ authorization: 'Bearer abc123' })
    expect(authHeaders(null)).toEqual({})
  })
})
