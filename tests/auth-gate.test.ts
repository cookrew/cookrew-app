import { describe, expect, it, vi } from 'vitest'
import {
  AuthError,
  authHeaders,
  createAuthStore,
  isAuthError,
  REAUTH_COPY,
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

// ── REACH v2.1, PHASE S3 ──────────────────────────────────────────────────
//
// One credential, one URL. The Mac prints a cookrew.dev link with the token in
// the fragment; the same origin now hosts every Mac the owner has, so the
// store has to know WHICH Mac it is holding a token for.

const RELAY_DEVICE = '11111111-2222-3333-4444-555555555555'
const RELAY_BASE = `/relay/@owner/desktop/${RELAY_DEVICE}`
const RELAY_TOKEN = 'Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MEFC'

describe('createAuthStore — the pairing fragment', () => {
  it('takes the token out of #pair= and persists it', () => {
    const local = memoryStorage()
    const store = createAuthStore({ local, search: '', hash: `#pair=${RELAY_TOKEN}` })
    expect(store.token()).toBe(RELAY_TOKEN)
    expect(local.data[TOKEN_KEY]).toBe(RELAY_TOKEN)
  })

  it('takes it out of the #/pair= form too', () => {
    const store = createAuthStore({ local: memoryStorage(), hash: `#/pair=${RELAY_TOKEN}` })
    expect(store.token()).toBe(RELAY_TOKEN)
  })

  it('ignores a mis-shaped fragment rather than storing junk', () => {
    const local = memoryStorage()
    expect(createAuthStore({ local, hash: '#pair=nope' }).token()).toBeNull()
    expect(local.data[TOKEN_KEY]).toBeUndefined()
  })

  it('prefers a fresh credential on the URL over the one in storage', () => {
    const store = createAuthStore({
      local: memoryStorage({ [TOKEN_KEY]: 'stale' }),
      hash: `#pair=${RELAY_TOKEN}`
    })
    expect(store.token()).toBe(RELAY_TOKEN)
  })
})

describe('createAuthStore — one token per desktop under a relay base', () => {
  it('keys the token by desktop id, not by origin', () => {
    const local = memoryStorage()
    const store = createAuthStore({ local, base: RELAY_BASE, hash: `#pair=${RELAY_TOKEN}` })
    expect(store.token()).toBe(RELAY_TOKEN)
    expect(local.data[`cr_token:${RELAY_DEVICE}`]).toBe(RELAY_TOKEN)
    // The root key is where a DIRECT LAN pairing lives. Writing there would
    // hand the next Mac opened at cookrew.dev this Mac's credential.
    expect(local.data[TOKEN_KEY]).toBeUndefined()
  })

  it('does not read another desktop’s token, nor the root one', () => {
    const other = '99999999-8888-7777-6666-555555555555'
    const store = createAuthStore({
      local: memoryStorage({
        [TOKEN_KEY]: 'a-direct-lan-pairing',
        [`cr_token:${other}`]: 'another-macs-token'
      }),
      base: RELAY_BASE
    })
    expect(store.token()).toBeNull()
  })

  it('does NOT migrate a legacy sessionStorage token under a base', () => {
    // The legacy key is unscoped by construction, so under a relay prefix it
    // says nothing about WHICH Mac it was for. Only the root may claim it.
    const store = createAuthStore({
      local: memoryStorage(),
      session: memoryStorage({ [TOKEN_KEY]: 'legacy' }),
      base: RELAY_BASE
    })
    expect(store.token()).toBeNull()
  })

  it('still migrates it at the root, exactly as before', () => {
    const local = memoryStorage()
    const store = createAuthStore({
      local,
      session: memoryStorage({ [TOKEN_KEY]: 'legacy' }),
      base: ''
    })
    expect(store.token()).toBe('legacy')
    expect(local.data[TOKEN_KEY]).toBe('legacy')
  })

  it('saves and clears under the scoped key', () => {
    const local = memoryStorage()
    const session = memoryStorage()
    const store = createAuthStore({ local, session, base: RELAY_BASE })
    store.save('a-new-token')
    expect(local.data[`cr_token:${RELAY_DEVICE}`]).toBe('a-new-token')
    store.clear()
    expect(local.data[`cr_token:${RELAY_DEVICE}`]).toBeUndefined()
    expect(store.token()).toBeNull()
  })
})

describe('tokenFromInput — the three things the Not paired card accepts', () => {
  it('1 — the canonical cookrew.dev URL, token in the fragment', () => {
    expect(
      tokenFromInput(`https://cookrew.dev${RELAY_BASE}/#pair=${RELAY_TOKEN}`)
    ).toBe(RELAY_TOKEN)
    expect(
      tokenFromInput(` https://cookrew.dev${RELAY_BASE}/#/pair=${RELAY_TOKEN} `)
    ).toBe(RELAY_TOKEN)
  })

  it('2 — the direct LAN URL, token in the query', () => {
    expect(tokenFromInput(`https://192.168.2.40:8643/?token=${RELAY_TOKEN}`)).toBe(RELAY_TOKEN)
  })

  it('3 — the bare token', () => {
    expect(tokenFromInput(`  ${RELAY_TOKEN}  `)).toBe(RELAY_TOKEN)
  })

  it('refuses a relay URL with no credential on it', () => {
    // The commonest paste: the address bar of an already-open companion. It
    // carries no token because the boot scrubbed it.
    expect(tokenFromInput(`https://cookrew.dev${RELAY_BASE}/`)).toBeNull()
    expect(tokenFromInput(`https://cookrew.dev${RELAY_BASE}/#pair=`)).toBeNull()
  })
})

describe('the Not paired copy', () => {
  it('sends the reader to the Mac, by both routes', () => {
    expect(REAUTH_COPY.title).toBe('Not paired')
    expect(REAUTH_COPY.unpaired).toBe(
      "Scan the QR on the Mac's avatar → Pair a phone, or paste what `cookrew mobile` printed."
    )
    expect(reauthMessage('none')).toBe(REAUTH_COPY.unpaired)
    expect(REAUTH_COPY.label).toBe('Pairing URL or token')
    expect(REAUTH_COPY.pair).toBe('Pair')
  })

  it('names the shape when the paste is not one', () => {
    expect(REAUTH_COPY.shape).toBe(
      'That is not a pairing URL or token. Paste the whole line the Mac printed.'
    )
  })

  it('says the Mac refused it, not that the desktop did', () => {
    expect(REAUTH_COPY.refused).toBe(
      'The Mac did not take that token. It may have been rotated — get it from the Mac again.'
    )
  })

  it('leaves the read-only device wording alone', () => {
    expect(reauthMessage('read-only')).toBe(
      'This device is paired read-only. Open the pairing URL from the desktop to make changes.'
    )
  })
})
