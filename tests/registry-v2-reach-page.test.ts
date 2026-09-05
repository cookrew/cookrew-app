import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { randomUUID } from 'node:crypto'
import { desktopsSection } from '../registry/src/site-reach'

/**
 * THE PICKER, WITH THE RELAY IN IT (identity v2, phase 3).
 *
 * `reach.js` is the only place that knows which path this phone actually has
 * to a Mac, and it is a browser file with no build step — so it is LOADED AND
 * RUN here against a hand-made document rather than described in a test that
 * agrees with a copy of it. Everything asserted is what a reader sees: which
 * badge is lit, what was remembered, and where OPEN sends them.
 *
 * The three states this phase adds: RELAY when no direct path answered and
 * cookrew.dev is holding a line for that Mac, OFFLINE when it is not, and the
 * remembered path that fills the badge before the race has finished.
 */

const source = readFileSync(path.join(__dirname, '..', 'registry', 'assets', 'reach.js'), 'utf8')

const BADGES = ['probing', 'lan', 'tailnet', 'relay', 'offline', 'pairing']

// ── a document, reduced to what the picker touches ────────────────────────

interface Node {
  tag: string
  cls: string
  dataset: Record<string, string>
  hidden: boolean
  children: Node[]
  querySelectorAll(selector: string): Node[]
  querySelector(selector: string): Node | null
  closest(selector: string): Node | null
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

function node(tag: string, cls = '', dataset: Record<string, string> = {}): Node {
  const made: Node = {
    tag,
    cls,
    dataset,
    hidden: false,
    children: [],
    querySelectorAll: (selector) => made.children.filter((child) => matches(child, selector)),
    querySelector: (selector) => made.children.find((child) => matches(child, selector)) ?? null,
    closest: (selector) => (matches(made, selector) ? made : null),
    addEventListener: (type, handler) => {
      handlers.set(`${tag}:${type}`, handler)
    }
  }
  return made
}

const handlers = new Map<string, (event: unknown) => void>()

interface Scene {
  /** Does a LAN address answer /api/hello with this desktop's signature? */
  lanAnswers?: boolean
  /** Does the desktop's card claim a relay at all? */
  relayInCard?: boolean
  /** Is cookrew.dev holding a line for it? */
  relayLive?: boolean
  /** Probes that never answer, for the case where the memory is what shows. */
  hangProbes?: boolean
  /** What is already in localStorage under cr_path:<id>. */
  remembered?: { kind: string; url: string | null; at: number }
}

interface Mounted {
  deviceId: string
  badge: () => string
  stored: (key: string) => string | null
  assigned: string[]
  asked: string[]
  fire: (type: 'window:online' | 'document:visibilitychange') => void
  openDesktop: () => void
}

function mount(scene: Scene): Mounted {
  handlers.clear()
  const deviceId = randomUUID()
  const username = 'owner'
  const reach = {
    lan: [{ url: 'https://192.168.1.24:8643', certFp: 'a'.repeat(64) }],
    tailnet: null,
    relay: scene.relayInCard !== false,
    at: new Date().toISOString()
  }
  const row = node('li', 'desktop', { desktop: deviceId, reach: JSON.stringify(reach) })
  for (const state of BADGES) row.children.push(node('span', 'chip', { badge: state }))
  const openButton = node('button', 'btn', { openDesktop: deviceId })
  row.children.push(openButton, node('button', 'btn', { forgetPair: deviceId }))
  row.children.push(node('span', 'meta', { pairNote: '' }), node('button', 'btn', { typeKey: deviceId }))
  row.children.push(node('button', 'btn', { scan: deviceId }))
  const list = node('ul', 'doors')
  list.children.push(row)
  const me = node('div', '', { username })

  const store = new Map<string, string>([[`cr_pair:${deviceId}`, 'A2B3C4']])
  if (scene.remembered) store.set(`cr_path:${deviceId}`, JSON.stringify(scene.remembered))
  const assigned: string[] = []
  const asked: string[] = []

  const answer = (status: number, body: unknown): unknown => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
  })
  const fetchStub = async (address: string): Promise<unknown> => {
    asked.push(address)
    if (address.includes('/api/hello')) {
      if (scene.hangProbes === true) return new Promise(() => undefined)
      if (scene.lanAnswers !== true) throw new Error('not this path')
      const nonce = new URL(address).searchParams.get('nonce')
      return answer(200, { deviceId, nonce, sig: 'signed' })
    }
    if (address.includes('/v2/verify-hello')) return answer(200, { ok: true })
    if (address.includes('/relay-status')) return answer(200, { live: scene.relayLive === true })
    if (address.includes('/open')) return answer(201, { token: 'CANVAS-TOKEN' })
    return answer(404, {})
  }

  const sandbox: Record<string, unknown> = {
    crypto: globalThis.crypto,
    btoa: globalThis.btoa,
    AbortSignal,
    URL,
    URLSearchParams,
    TextDecoder,
    setTimeout,
    clearTimeout,
    // The picker's own re-probe timer is recorded rather than scheduled: a
    // test must not be at the mercy of a minute passing.
    setInterval: () => 0,
    clearInterval: () => undefined,
    fetch: fetchStub,
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
      removeItem: (key: string) => store.delete(key)
    },
    location: { search: '', assign: (url: string) => assigned.push(url) },
    navigator: {},
    addEventListener: (type: string, handler: (event: unknown) => void) => {
      handlers.set(`window:${type}`, handler)
    },
    document: {
      hidden: false,
      getElementById: (id: string) => (id === 'me-desktops' ? list : id === 'me' ? me : null),
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
    stored: (key) => store.get(key) ?? null,
    assigned,
    asked,
    fire: (type) => handlers.get(type)?.({}),
    openDesktop: () =>
      handlers.get('ul:click')?.({ target: openButton, preventDefault: () => undefined })
  }
}

/** Let the picker's own promises settle, without waiting on a clock. */
const settle = async (turns = 12): Promise<void> => {
  for (let at = 0; at < turns; at += 1) await new Promise((resolve) => setTimeout(resolve, 1))
}

// ── the badge ────────────────────────────────────────────────────────────

describe('the path badge', () => {
  it('lights LAN when an address answers, and never asks about the relay', async () => {
    const picker = mount({ lanAnswers: true, relayInCard: true, relayLive: true })
    await settle()
    expect(picker.badge()).toBe('lan')
    expect(picker.asked.some((address) => address.includes('relay-status'))).toBe(false)
  })

  it('lights RELAY when nothing direct answers and cookrew.dev is holding a line', async () => {
    const picker = mount({ lanAnswers: false, relayInCard: true, relayLive: true })
    await settle()
    expect(picker.badge()).toBe('relay')
    expect(picker.asked.some((address) => address.includes(`/v2/me/desktops/${picker.deviceId}/relay-status`))).toBe(
      true
    )
  })

  it('lights OFFLINE when the Mac is holding no line', async () => {
    const picker = mount({ lanAnswers: false, relayInCard: true, relayLive: false })
    await settle()
    expect(picker.badge()).toBe('offline')
  })

  it('does not ask about a relay the card never claimed', async () => {
    const picker = mount({ lanAnswers: false, relayInCard: false })
    await settle()
    expect(picker.badge()).toBe('offline')
    expect(picker.asked.some((address) => address.includes('relay-status'))).toBe(false)
  })
})

// ── the memory ───────────────────────────────────────────────────────────

describe('the path this browser last got through on', () => {
  it('remembers the winner, its kind and its address', async () => {
    const picker = mount({ lanAnswers: true })
    await settle()
    const held = JSON.parse(picker.stored(`cr_path:${picker.deviceId}`) ?? 'null') as {
      kind: string
      url: string
      at: number
    }
    expect(held.kind).toBe('lan')
    expect(held.url).toBe('https://192.168.1.24:8643')
    expect(held.at).toBeGreaterThan(Date.now() - 10_000)
  })

  it('remembers the relay path as an address on cookrew.dev', async () => {
    const picker = mount({ lanAnswers: false, relayLive: true })
    await settle()
    const held = JSON.parse(picker.stored(`cr_path:${picker.deviceId}`) ?? 'null') as { kind: string; url: string }
    expect(held.kind).toBe('relay')
    expect(held.url).toBe(`/relay/@owner/desktop/${picker.deviceId}/`)
  })

  it('fills the badge from the memory while the race is still running', async () => {
    const picker = mount({
      hangProbes: true,
      remembered: { kind: 'tailnet', url: 'https://mac.tail1234.ts.net:8643', at: Date.now() }
    })
    await settle(4)
    expect(picker.badge()).toBe('tailnet')
  })

  it('ignores a memory too old to mean anything about this network', async () => {
    const picker = mount({
      hangProbes: true,
      remembered: { kind: 'lan', url: 'https://192.168.1.24:8643', at: Date.now() - 60 * 60 * 1000 }
    })
    await settle(4)
    expect(picker.badge()).toBe('probing')
  })
})

// ── re-probing ───────────────────────────────────────────────────────────

describe('re-probing, because the network moves under the page', () => {
  it('races again when the browser comes back online', async () => {
    const picker = mount({ lanAnswers: false, relayLive: false })
    await settle()
    const before = picker.asked.length
    picker.fire('window:online')
    await settle()
    expect(picker.asked.length).toBeGreaterThan(before)
  })

  it('races again when the tab comes forward', async () => {
    const picker = mount({ lanAnswers: false, relayLive: false })
    await settle()
    const before = picker.asked.length
    picker.fire('document:visibilitychange')
    await settle()
    expect(picker.asked.length).toBeGreaterThan(before)
  })
})

// ── opening ──────────────────────────────────────────────────────────────

describe('OPEN', () => {
  it('sends a direct path the admission on the query', async () => {
    const picker = mount({ lanAnswers: true })
    await settle()
    picker.openDesktop()
    await settle()
    expect(picker.assigned).toHaveLength(1)
    expect(picker.assigned[0]).toBe(
      `https://192.168.1.24:8643/?open=CANVAS-TOKEN&key=A2B3C4&device=${picker.deviceId}`
    )
  })

  it('sends the relay path the SAME admission, unchanged, on cookrew.dev', async () => {
    const picker = mount({ lanAnswers: false, relayLive: true })
    await settle()
    picker.openDesktop()
    await settle()
    expect(picker.assigned[0]).toBe(
      `/relay/@owner/desktop/${picker.deviceId}/?open=CANVAS-TOKEN&key=A2B3C4&device=${picker.deviceId}`
    )
  })

  it('goes nowhere at all when the Mac answered on no path', async () => {
    const picker = mount({ lanAnswers: false, relayLive: false })
    await settle()
    picker.openDesktop()
    await settle()
    expect(picker.assigned).toHaveLength(0)
  })
})

// ── the markup the states live in ────────────────────────────────────────

describe('the server-rendered states', () => {
  it('ships a chip for every state the script can reach, RELAY and OFFLINE among them', () => {
    const html = desktopsSection([
      {
        deviceId: '11111111-2222-3333-4444-555555555555',
        name: 'This Mac',
        workspaces: [{ id: 'w1', name: 'Cookrew Dev' }],
        reach: null,
        updatedAt: Date.now()
      }
    ])
    for (const state of BADGES) expect(html).toContain(`data-badge="${state}"`)
    expect(html).toContain('RELAY')
    expect(html).toContain('OFFLINE')
  })
})
