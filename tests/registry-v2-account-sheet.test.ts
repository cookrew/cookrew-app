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
  hashchange: (hash: string) => void
}

/** `signedIn` decides what /v2/me answers, which is the whole branch here. */
function mount(hash: string, signedIn: boolean): Mounted {
  const nodes = new Map<string, Stub>()
  const byId = (id: string): Stub => {
    const held = nodes.get(id)
    if (held) return held
    const made = stub(id)
    nodes.set(id, made)
    return made
  }
  // The crew builder belongs to /start; absent here, or the script builds it.
  const missing = new Set(['crew-builder'])
  const assigned: string[] = []
  const listeners = new Map<string, (event: unknown) => void>()

  const fetchStub = async (address: string): Promise<unknown> => ({
    ok: true,
    status: address.includes('/v2/me') && signedIn ? 200 : 401,
    json: async () => (signedIn ? { username: 'mira' } : { error: 'unauthenticated' })
  })

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
    indexedDB: { open: () => ({ onupgradeneeded: null, onsuccess: null, onerror: null }) },
    location: {
      get hash() {
        return hash
      },
      origin: 'https://cookrew.dev',
      hostname: 'cookrew.dev',
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
  it('opens the v2 sheet on #account, which is where the front page sends people', async () => {
    const page = mount('#account', false)
    await settle()
    expect(page.sheet.open).toBe(true)
  })

  it('opens it on #signin too, because that is the other name for the same door', async () => {
    const page = mount('#signin', false)
    await settle()
    expect(page.sheet.open).toBe(true)
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
    const page = mount('', false)
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
