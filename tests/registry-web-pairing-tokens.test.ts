// BOX ROUND 3, BUG 4. A browser keeps `cr_token:<device>` for each Mac it
// reaches. After the account is deleted that key names a device that is gone,
// so it goes: at once when this browser did the delete, and on the next page
// when the delete happened somewhere else, read from the public revoked list.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'

const source = readFileSync(path.join(__dirname, '..', 'registry', 'assets', 'site.js'), 'utf8')

const GONE = '11111111-1111-4111-8111-111111111111'
const LIVE = '22222222-2222-4222-8222-222222222222'

function memoryStorage(seed: Record<string, string>) {
  const held = new Map(Object.entries(seed))
  return {
    get length() {
      return held.size
    },
    key: (at: number) => [...held.keys()][at] ?? null,
    getItem: (key: string) => held.get(key) ?? null,
    setItem: (key: string, value: string) => void held.set(key, value),
    removeItem: (key: string) => void held.delete(key),
    keys: () => [...held.keys()]
  }
}

interface Page {
  storage: ReturnType<typeof memoryStorage>
  asked: string[]
  click: (el: unknown) => void
}

function page(options: { me: number; revoked?: unknown; keysStatus?: number; onMe?: boolean; seed: Record<string, string> }): Page {
  const storage = memoryStorage(options.seed)
  const asked: string[] = []
  const nodes = new Map<string, Record<string, unknown>>()
  const missing = new Set(['crew-builder', 'join-card', ...(options.onMe ? [] : ['me'])])
  const stub = (id: string): Record<string, unknown> => {
    const held = nodes.get(id)
    if (held) return held
    const made = {
      id, value: id === 'me-delete-name' ? 'mira' : '', textContent: '', dataset: {}, hidden: false,
      showModal: () => undefined, close: () => undefined, focus: () => undefined, setAttribute: () => undefined,
      addEventListener: () => undefined, querySelector: () => null, querySelectorAll: () => []
    }
    nodes.set(id, made)
    return made
  }
  const clicks: Array<(event: unknown) => void> = []
  const fetchStub = async (address: string, init?: { method?: string }): Promise<unknown> => {
    const method = init?.method ?? 'GET'
    asked.push(`${method} ${address}`)
    if (address === '/v2/keys') {
      const status = options.keysStatus ?? 200
      return { status, json: async () => ({ jwk: {}, revoked: options.revoked }) }
    }
    if (address === '/v2/me' && method === 'DELETE') return { status: 204, json: async () => ({}) }
    return { status: options.me, json: async () => (options.me === 200 ? { username: 'mira' } : { error: 'unauthenticated' }) }
  }
  const sandbox: Record<string, unknown> = {
    fetch: fetchStub, setTimeout, clearTimeout, setInterval: () => 0, btoa: globalThis.btoa, atob: globalThis.atob,
    crypto: globalThis.crypto, TextEncoder, TextDecoder, URL, URLSearchParams,
    navigator: { userAgent: 'Mozilla/5.0 (Macintosh) Chrome/140' },
    localStorage: storage,
    sessionStorage: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined },
    indexedDB: {
      open: () => ({ onupgradeneeded: null, onsuccess: null, onerror: null }),
      deleteDatabase: () => {
        const request: { onsuccess: null | (() => void) } = { onsuccess: null }
        setTimeout(() => request.onsuccess?.(), 0)
        return request
      }
    },
    location: {
      hash: '', origin: 'https://cookrew.dev', hostname: 'cookrew.dev', protocol: 'https:', search: '',
      assign: () => undefined, reload: () => undefined
    },
    addEventListener: () => undefined,
    document: {
      cookie: '', visibilityState: 'visible',
      getElementById: (id: string) => (missing.has(id) ? null : stub(id)),
      addEventListener: (type: string, handler: (event: unknown) => void) => {
        if (type === 'click') clicks.push(handler)
      },
      createElement: (tag: string) => stub(tag),
      body: { appendChild: () => undefined }
    }
  }
  sandbox.globalThis = sandbox
  sandbox.window = sandbox
  vm.runInNewContext(source, sandbox)
  return {
    storage,
    asked,
    click: (el) => {
      for (const handler of clicks) handler({ target: { closest: () => el }, preventDefault: () => undefined })
    }
  }
}

const settle = async (): Promise<void> => {
  for (let at = 0; at < 10; at += 1) await new Promise((resolve) => setTimeout(resolve, 1))
}

const tokens = { [`cr_token:${GONE}`]: 'aaaaaaaaaaaaaaaaaaaaaaaa', [`cr_token:${LIVE}`]: 'bbbbbbbbbbbbbbbbbbbbbbbb' }

describe('a browser signed out, holding pairing tokens', () => {
  it('drops the token of a device the registry has taken back, and keeps the rest', async () => {
    const { storage } = page({ me: 401, revoked: [GONE], seed: { ...tokens, theme: 'ink' } })
    await settle()
    expect(storage.keys().sort()).toEqual([`cr_token:${LIVE}`, 'theme'])
  })

  it('reads the id whatever its case', async () => {
    const { storage } = page({ me: 401, revoked: [GONE.toUpperCase()], seed: tokens })
    await settle()
    expect(storage.keys()).toEqual([`cr_token:${LIVE}`])
  })

  it('keeps everything when the list cannot be read', async () => {
    for (const answer of [{ keysStatus: 503 }, { revoked: 'nonsense' }]) {
      const { storage } = page({ me: 401, seed: tokens, ...answer })
      await settle()
      expect(storage.keys()).toHaveLength(2)
    }
  })

  it('asks nothing when it holds no token', async () => {
    const { asked } = page({ me: 401, revoked: [GONE], seed: { theme: 'ink' } })
    await settle()
    expect(asked).not.toContain('GET /v2/keys')
  })
})

describe('a browser signed in', () => {
  it('leaves its tokens alone and asks nothing', async () => {
    const { storage, asked } = page({ me: 200, revoked: [GONE], seed: tokens })
    await settle()
    expect(storage.keys()).toHaveLength(2)
    expect(asked).not.toContain('GET /v2/keys')
  })
})

describe('deleting the account from this browser', () => {
  it('takes this account’s tokens, and leaves another account’s pairing in the same browser', async () => {
    const { storage, click } = page({ me: 200, onMe: true, revoked: [GONE], seed: { ...tokens, theme: 'ink' } })
    await settle()
    click({ dataset: { deleteAccount: '' } })
    await settle()
    expect(storage.keys().sort()).toEqual([`cr_token:${LIVE}`, 'theme'])
  })
})
