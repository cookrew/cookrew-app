import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'

/**
 * #account OPENS THE SHEET (identity v2, phase 2 — found in real-UI QA).
 *
 * The front page is a DOCUMENT by its own CSP: no script, so its SIGN IN
 * cannot open anything and links to `/market#account` instead. Nothing on the
 * market page read that hash, so the button landed on the marketplace and
 * appeared to do nothing at all — which reads as broken, not as a page that
 * scrolled somewhere.
 *
 * `site.js` is a browser file with no build step, so it is LOADED AND RUN here
 * against a document reduced to what the sheet touches, rather than described
 * by a test that agrees with a copy of it.
 *
 * SINCE AUTH.COOKREW.DEV the same hash goes to the one sign-in page: the page
 * opens an auth request for this browser's device key, proves the key, and
 * leaves. The sheet is what a registry without that page still gets — it
 * answers /v2/auth/requests with a 404.
 */

const source = readFileSync(path.join(__dirname, '..', 'registry', 'assets', 'site.js'), 'utf8')

interface Stub {
  id: string
  value: string
  textContent: string
  hidden: boolean
  disabled: boolean
  open: boolean
  className: string
  dataset: Record<string, string>
  modals: number
  focused: number
  showModal(): void
  close(): void
  focus(): void
  setAttribute(name: string, value: string): void
  addEventListener(type: string, handler: (event: unknown) => void): void
  querySelector(): null
  querySelectorAll(): Stub[]
}

function stub(id: string): Stub {
  const made: Stub = {
    id,
    value: '',
    textContent: '',
    hidden: false,
    disabled: false,
    open: false,
    className: '',
    dataset: {},
    modals: 0,
    focused: 0,
    showModal: () => {
      made.open = true
      made.modals += 1
    },
    close: () => {
      made.open = false
    },
    focus: () => {
      made.focused += 1
    },
    setAttribute: () => undefined,
    addEventListener: () => undefined,
    querySelector: () => null,
    querySelectorAll: () => []
  }
  return made
}

interface Mounted {
  sheet: Stub
  assigned: string[]
  asked: { path: string; body: Record<string, unknown> }[]
  hashchange: (hash: string) => void
}

/** A device this browser already holds: what IndexedDB would hand back. */
let held: Record<string, unknown> | null = null
async function heldDevice(): Promise<Record<string, unknown>> {
  if (held !== null) return held
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify'])
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey)
  held = {
    id: '0b6c2f0e-1d2a-8c3b-9d4e-5f6a7b8c9d0e',
    kind: 'browser',
    name: 'Chrome on macOS',
    jwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y },
    pair
  }
  return held
}

/** IndexedDB, reduced to the one read the device takes. */
function deviceDb(device: Record<string, unknown>): unknown {
  const later = (fn: () => void): void => void setTimeout(fn, 0)
  return {
    open: () => {
      const request: Record<string, unknown> = { onupgradeneeded: null, onsuccess: null, onerror: null }
      const db = {
        close: () => undefined,
        transaction: () => {
          const tx: Record<string, unknown> = { oncomplete: null }
          tx.objectStore = () => ({
            get: () => {
              const read: Record<string, unknown> = { result: device, onsuccess: null }
              later(() => (read.onsuccess as (() => void) | null)?.())
              return read
            }
          })
          return tx
        }
      }
      request.result = db
      later(() => (request.onsuccess as (() => void) | null)?.())
      return request
    }
  }
}

/**
 * `signedIn` decides what /v2/me answers; `authSite` whether this registry
 * serves the one sign-in page — off, it answers /v2/auth the way an older
 * registry does.
 */
function mount(hash: string, signedIn: boolean, authSite = false, device: Record<string, unknown> | null = null): Mounted {
  const nodes = new Map<string, Stub>()
  const byId = (id: string): Stub => {
    const held = nodes.get(id)
    if (held) return held
    const made = stub(id)
    nodes.set(id, made)
    return made
  }
  // The crew builder belongs to /start; absent here, or the script builds it.
  // Pages the sheet is tested on carry neither the crew builder nor the join
  // card; the stub answers every other id, so an element that is absent in the
  // real page has to be named absent here.
  const missing = new Set(['crew-builder', 'join-card'])
  const assigned: string[] = []
  const listeners = new Map<string, (event: unknown) => void>()

  const asked: { path: string; body: Record<string, unknown> }[] = []
  const fetchStub = async (address: string, init?: { body?: string }): Promise<unknown> => {
    if (address.startsWith('/v2/auth/')) {
      asked.push({ path: address, body: init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : {} })
      if (!authSite) return { ok: false, status: 404, json: async () => ({ error: 'not_found' }) }
      if (address === '/v2/auth/requests') {
        return {
          ok: true,
          status: 201,
          json: async () => ({ request: 'r1', transcript: 'cookrew-auth/device-transaction/v1', authorizeUrl: 'https://auth.cookrew.dev/?request=r1' })
        }
      }
      return { ok: true, status: 204, json: async () => ({}) }
    }
    return {
      ok: true,
      status: address.includes('/v2/me') && signedIn ? 200 : 401,
      json: async () => (signedIn ? { username: 'mira' } : { error: 'unauthenticated' })
    }
  }

  const sandbox: Record<string, unknown> = {
    fetch: fetchStub,
    setTimeout,
    clearTimeout,
    btoa: globalThis.btoa,
    atob: globalThis.atob,
    crypto: globalThis.crypto,
    TextEncoder,
    TextDecoder,
    URL,
    URLSearchParams,
    navigator: { userAgent: 'Mozilla/5.0 (Macintosh) Chrome/140' },
    sessionStorage: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined },
    // Never opened: every path here reaches the sheet or /me before a key is
    // needed, and a request that hangs is a promise nobody awaits.
    indexedDB: device === null ? { open: () => ({ onupgradeneeded: null, onsuccess: null, onerror: null }) } : deviceDb(device),
    location: {
      get hash() {
        return hash
      },
      origin: 'https://cookrew.dev',
      hostname: 'cookrew.dev',
      pathname: '/market',
      protocol: 'https:',
      search: '',
      assign: (url: string) => assigned.push(url),
      reload: () => undefined
    },
    addEventListener: (type: string, handler: (event: unknown) => void) => {
      listeners.set(type, handler)
    },
    document: {
      cookie: '',
      visibilityState: 'visible',
      getElementById: (id: string) => (missing.has(id) ? null : byId(id)),
      addEventListener: () => undefined,
      createElement: (tag: string) => stub(tag),
      body: { appendChild: () => undefined }
    }
  }
  sandbox.globalThis = sandbox
  sandbox.window = sandbox
  vm.runInNewContext(source, sandbox)

  return {
    sheet: byId('account-sheet'),
    assigned,
    asked,
    hashchange: (next: string) => {
      hash = next
      listeners.get('hashchange')?.({})
    }
  }
}

const settle = async (turns = 8): Promise<void> => {
  for (let at = 0; at < turns; at += 1) await new Promise((resolve) => setTimeout(resolve, 1))
}

describe('the sign-in hash', () => {
  it('opens the v2 sheet on #account when the registry has no sign-in page', async () => {
    const page = mount('#account', false, false, await heldDevice())
    await settle()
    expect(page.asked.map((a) => a.path)).toEqual(['/v2/auth/requests'])
    expect(page.sheet.open).toBe(true)
  })

  it('opens it on #signin too, because that is the other name for the same door', async () => {
    const page = mount('#signin', false, false, await heldDevice())
    await settle()
    expect(page.sheet.open).toBe(true)
  })

  it('goes to the one sign-in page when the registry serves it, the key proven first', async () => {
    const device = await heldDevice()
    const page = mount('#account', false, true, device)
    await settle(16)
    expect(page.sheet.open).toBe(false)
    expect(page.asked.map((a) => a.path)).toEqual(['/v2/auth/requests', '/v2/auth/requests/r1/proof'])
    expect(page.asked[0].body).toEqual({
      client: 'web',
      intent: 'sign-in',
      device: { id: device.id, kind: 'browser', name: 'Chrome on macOS', jwk: device.jwk },
      return: '/market'
    })
    // A raw r‖s P-256 signature: 64 bytes, base64url.
    expect(String(page.asked[1].body.signature)).toMatch(/^[A-Za-z0-9_-]{86}$/)
    expect(page.assigned).toEqual(['https://auth.cookrew.dev/?request=r1'])
  })

  it('#create asks the page for its create-account screen', async () => {
    const page = mount('#create', false, true, await heldDevice())
    await settle(16)
    expect(page.asked[0].body.intent).toBe('create')
    expect(page.assigned).toEqual(['https://auth.cookrew.dev/?request=r1'])
  })

  it('leaves an ordinary page alone', async () => {
    const page = mount('', false)
    await settle()
    expect(page.sheet.open).toBe(false)
    expect(page.assigned).toHaveLength(0)
  })

  it('does not ask a signed-in reader to sign in again — that link means /me', async () => {
    const page = mount('#account', true)
    await settle()
    expect(page.sheet.open).toBe(false)
    expect(page.assigned).toContain('/me')
  })

  it('answers a second click on the same link, which changes no URL', async () => {
    const page = mount('', false, false, await heldDevice())
    await settle()
    expect(page.sheet.open).toBe(false)
    page.hashchange('#account')
    await settle()
    expect(page.sheet.open).toBe(true)
    // Already open: showModal a second time is a DOM exception, not a no-op.
    page.hashchange('#account')
    await settle()
    expect(page.sheet.modals).toBe(1)
  })
})
