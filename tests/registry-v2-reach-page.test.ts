import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { randomUUID } from 'node:crypto'
import { desktopsSection, relayPrefix } from '../registry/src/site-reach'

/**
 * THE DESKTOPS ROW (reach v2.1).
 *
 * `reach.js` is a browser file with no build step, so it is LOADED AND RUN
 * here against a hand-made document rather than described in a test that
 * agrees with a copy of it. Everything asserted is what a reader sees: which
 * badge is lit, what was asked to light it, and where OPEN points.
 *
 * The whole ceremony this file used to describe — the six characters, the QR,
 * the remembered path, the two refusal sentences — is gone. A phone is paired
 * on the phone, and cookrew.dev's row makes one claim it can actually stand
 * behind: is that Mac holding its line here right now?
 */

const source = readFileSync(path.join(__dirname, '..', 'registry', 'assets', 'reach.js'), 'utf8')

const BADGES = ['probing', 'online', 'offline']

// ── a document, reduced to what the row touches ───────────────────────────

interface Node {
  tag: string
  cls: string
  dataset: Record<string, string>
  hidden: boolean
  children: Node[]
  querySelectorAll(selector: string): Node[]
  querySelector(selector: string): Node | null
  addEventListener(type: string, handler: (event: unknown) => void): void
}

const camel = (name: string): string => name.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase())

function matches(node: Node, selector: string): boolean {
  return selector
    .split(',')
    .map((one) => one.trim())
    .some((one) => {
      const attribute = /^\[data-([a-z-]+)\]$/.exec(one)
      if (attribute) return node.dataset[camel(attribute[1])] !== undefined
      const [tag, ...classes] = one.split('.')
      if (tag.length > 0 && tag !== node.tag) return false
      return classes.every((cls) => node.cls.split(' ').includes(cls))
    })
}

const handlers = new Map<string, (event: unknown) => void>()

function node(tag: string, cls = '', dataset: Record<string, string> = {}): Node {
  const made: Node = {
    tag,
    cls,
    dataset,
    hidden: false,
    children: [],
    querySelectorAll: (selector) => made.children.filter((child) => matches(child, selector)),
    querySelector: (selector) => made.children.find((child) => matches(child, selector)) ?? null,
    addEventListener: (type, handler) => {
      handlers.set(`${tag}:${type}`, handler)
    }
  }
  return made
}

interface Scene {
  /** Is cookrew.dev holding a line for that Mac? */
  live?: boolean
  /** relay-status never answers, for the badge a reader meets while asking. */
  hang?: boolean
  /** The registry refuses the question outright. */
  status?: number
}

interface Mounted {
  deviceId: string
  badge: () => string
  asked: string[]
  fire: (type: 'window:online' | 'document:visibilitychange') => void
  /** Anything the row put in this browser's store, which should be nothing. */
  stored: () => string[]
}

function mount(scene: Scene): Mounted {
  handlers.clear()
  const deviceId = randomUUID()
  const row = node('li', 'desktop', { desktop: deviceId })
  for (const state of BADGES) {
    const chip = node('span', 'chip', { badge: state })
    chip.hidden = state !== 'probing'
    row.children.push(chip)
  }
  const list = node('ul', 'doors')
  list.children.push(row)

  const store = new Map<string, string>()
  const asked: string[] = []
  const fetchStub = async (address: string): Promise<unknown> => {
    asked.push(address)
    if (scene.hang === true) return new Promise(() => undefined)
    const status = scene.status ?? 200
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => ({ live: scene.live === true })
    }
  }

  const byId = new Map<string, Node>([['me-desktops', list]])
  const sandbox: Record<string, unknown> = {
    URL,
    URLSearchParams,
    setTimeout,
    clearTimeout,
    // The row's own re-ask timer is recorded rather than scheduled: a test
    // must not be at the mercy of a minute passing.
    setInterval: () => 0,
    clearInterval: () => undefined,
    fetch: fetchStub,
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
      removeItem: (key: string) => store.delete(key)
    },
    location: { search: '', assign: () => undefined },
    navigator: {},
    addEventListener: (type: string, handler: (event: unknown) => void) => {
      handlers.set(`window:${type}`, handler)
    },
    document: {
      hidden: false,
      getElementById: (id: string) => byId.get(id) ?? null,
      addEventListener: (type: string, handler: (event: unknown) => void) => {
        handlers.set(`document:${type}`, handler)
      },
      createElement: (tag: string) => node(tag),
      body: { appendChild: () => undefined }
    }
  }
  sandbox.globalThis = sandbox
  sandbox.window = sandbox
  vm.runInNewContext(source, sandbox)

  return {
    deviceId,
    badge: () => row.querySelectorAll('[data-badge]').find((chip) => !chip.hidden)?.dataset.badge ?? 'none',
    asked,
    fire: (type) => handlers.get(type)?.({}),
    stored: () => [...store.keys()]
  }
}

/** Let the row's own promises settle, without waiting on a clock. */
const settle = async (turns = 8): Promise<void> => {
  for (let at = 0; at < turns; at += 1) await new Promise((resolve) => setTimeout(resolve, 1))
}

// ── the badge ────────────────────────────────────────────────────────────

describe('the one badge', () => {
  it('lights ONLINE when cookrew.dev is holding a line for that Mac', async () => {
    const row = mount({ live: true })
    await settle()
    expect(row.badge()).toBe('online')
    expect(row.asked).toEqual([`/v2/me/desktops/${row.deviceId}/relay-status`])
  })

  it('lights OFFLINE when it is not', async () => {
    const row = mount({ live: false })
    await settle()
    expect(row.badge()).toBe('offline')
  })

  it('stays PROBING while the question is still out', async () => {
    const row = mount({ hang: true })
    await settle(3)
    expect(row.badge()).toBe('probing')
  })

  /**
   * A REFUSAL IS NOT AN "ONLINE". A badge that lights green on a request that
   * failed sends a reader to a dead page; one that says OFFLINE about a Mac
   * that is fine sends them to look at the Mac. The second is the cheaper
   * mistake, so every kind of no is the same no.
   */
  it('reads any refusal as OFFLINE rather than guessing', async () => {
    for (const status of [401, 404, 500, 503]) {
      const row = mount({ live: true, status })
      await settle()
      expect(row.badge(), String(status)).toBe('offline')
    }
  })

  it('never probes a Mac directly, and never asks for an open token', async () => {
    const row = mount({ live: false })
    await settle()
    expect(row.asked.some((address) => address.includes('/api/hello'))).toBe(false)
    expect(row.asked.some((address) => address.includes('/open'))).toBe(false)
    expect(row.asked.some((address) => address.includes('verify-hello'))).toBe(false)
  })

  it('keeps nothing in this browser — no key, no remembered path', async () => {
    const row = mount({ live: true })
    await settle()
    expect(row.stored()).toEqual([])
  })
})

// ── asking again ─────────────────────────────────────────────────────────

describe('asking again, because a Mac sleeps under the page', () => {
  it('asks again when the browser comes back online', async () => {
    const row = mount({ live: false })
    await settle()
    const before = row.asked.length
    row.fire('window:online')
    await settle()
    expect(row.asked.length).toBeGreaterThan(before)
  })

  it('asks again when the tab comes forward', async () => {
    const row = mount({ live: false })
    await settle()
    const before = row.asked.length
    row.fire('document:visibilitychange')
    await settle()
    expect(row.asked.length).toBeGreaterThan(before)
  })

  it('does not send a second question while the first is still out', async () => {
    const row = mount({ hang: true })
    await settle(2)
    row.fire('window:online')
    row.fire('document:visibilitychange')
    await settle(2)
    expect(row.asked).toHaveLength(1)
  })
})

// ── the markup the states live in ────────────────────────────────────────

const oneDesktop = (deviceId: string): string =>
  desktopsSection('owner', [
    {
      deviceId,
      name: 'This Mac',
      workspaces: [{ id: 'w1', name: 'Cookrew Dev' }],
      reach: null,
      updatedAt: Date.now()
    }
  ])

describe('the server-rendered row', () => {
  it('ships a chip for every state the script can reach, and only those', () => {
    const html = oneDesktop('11111111-2222-3333-4444-555555555555')
    for (const state of BADGES) expect(html).toContain(`data-badge="${state}"`)
    expect(html).toContain('PROBING')
    expect(html).toContain('ONLINE')
    expect(html).toContain('OFFLINE')
  })

  it('is name, workspaces, one badge and OPEN — nothing that pairs a phone', () => {
    const html = oneDesktop('11111111-2222-3333-4444-555555555555')
    expect(html).toContain('This Mac')
    expect(html).toContain('Cookrew Dev')
    for (const gone of ['SCAN QR', 'TYPE KEY', 'FORGET KEY', 'LINK', 'data-key-input', 'data-scan', 'NEEDS PAIRING']) {
      expect(html, gone).not.toContain(gone)
    }
  })

  /**
   * OPEN IS AN href, so it works with this script broken, disabled or still
   * loading — and it names cookrew.dev's own prefix, with nothing on the query.
   */
  it('points OPEN at the relay prefix, same tab, no query at all', () => {
    const deviceId = '11111111-2222-3333-4444-555555555555'
    const html = oneDesktop(deviceId)
    expect(html).toContain(`href="/relay/@owner/desktop/${deviceId}/">OPEN</a>`)
    expect(relayPrefix('owner', deviceId)).toBe(`/relay/@owner/desktop/${deviceId}/`)
    expect(html).not.toContain('?')
    expect(html).not.toContain('target=')
  })

  it('says what the badge means, in the section’s own sentence', () => {
    const html = oneDesktop('11111111-2222-3333-4444-555555555555')
    expect(html).toContain('holding its line at cookrew.dev')
  })

  it('tells a reader with no desktop why the list is empty', () => {
    expect(desktopsSection('owner', [])).toContain('No desktop has registered its workspaces yet')
  })
})
