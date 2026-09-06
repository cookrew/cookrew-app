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
  disabled: boolean
  value: string
  focused: boolean
  focus(): void
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
    disabled: false,
    value: '',
    focused: false,
    focus: () => {
      made.focused = true
    },
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
  /** `?refused=…` on the way back from a desktop that would not take it. */
  refused?: string
  /** Leave `&desktop=` off, for the fallback the page still has to answer. */
  namesDesktop?: boolean
  /** No key held for this Mac: the NEEDS PAIRING row, with its field. */
  unpaired?: boolean
}

interface Mounted {
  deviceId: string
  /** The device READING the page — the phone, which is not the Mac. */
  phoneId: string
  badge: () => string
  stored: (key: string) => string | null
  assigned: string[]
  asked: string[]
  fire: (type: 'window:online' | 'document:visibilitychange') => void
  openDesktop: () => void
  /** The row's own six-character field, as a reader meets it. */
  keyField: () => Node
  keyNote: () => Node
  /** Which sentence sits under THIS row, if any. */
  rowRefusal: () => 'key' | 'device' | 'none'
  openButton: () => Node
  /** Put characters in the field the way a person does — one key at a time. */
  type: (text: string) => void
  keyForm: () => Node
  typeKeyButton: () => Node
  pressTypeKey: () => void
  pressLink: () => void
  pressEnter: () => void
  shown: (id: string) => boolean
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
  const typeKeyButton = node('button', 'btn', { typeKey: deviceId })
  row.children.push(node('span', 'meta', { pairNote: '' }), typeKeyButton)
  row.children.push(node('button', 'btn', { scan: deviceId }))
  // The six-character field, as site-reach.ts renders it: in the row, hidden.
  const keyForm = node('span', 'pair-key', { keyForm: deviceId })
  keyForm.hidden = true
  const keyInput = node('input', 'pair-input', { keyInput: deviceId })
  const linkButton = node('button', 'btn', { keyLink: deviceId })
  const keyNote = node('span', 'meta', { keyNote: '' })
  keyNote.hidden = true
  const refusedKeyNote = node('span', 'meta', { refusedKey: '' })
  refusedKeyNote.hidden = true
  const refusedDeviceNote = node('span', 'meta', { refusedDevice: '' })
  refusedDeviceNote.hidden = true
  row.children.push(keyForm, keyInput, linkButton, keyNote, refusedKeyNote, refusedDeviceNote)

  const list = node('ul', 'doors')
  list.children.push(row)
  const phoneId = randomUUID()
  const me = node('div', '', { username, device: phoneId, deviceName: 'iPhone' })

  const store = new Map<string, string>(scene.unpaired === true ? [] : [[`cr_pair:${deviceId}`, 'A2B3C4']])
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

  // The two refusal sentences the server renders once, above the list.
  const refusedKey = node('p', 'meta')
  refusedKey.hidden = true
  const refusedDevice = node('p', 'meta')
  refusedDevice.hidden = true
  const byId = new Map<string, Node>([
    ['me-desktops', list],
    ['me', me],
    ['reach-refused', refusedKey],
    ['reach-refused-device', refusedDevice]
  ])

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
    location: {
      search:
        scene.refused === undefined
          ? ''
          : `?refused=${scene.refused}${scene.namesDesktop === false ? '' : `&desktop=${deviceId}`}`,
      assign: (url: string) => assigned.push(url)
    },
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

  const click = (target: Node): void => {
    handlers.get('ul:click')?.({ target, preventDefault: () => undefined })
  }

  return {
    deviceId,
    phoneId,
    badge: () => row.querySelectorAll('[data-badge]').find((chip) => !chip.hidden)?.dataset.badge ?? 'none',
    stored: (key) => store.get(key) ?? null,
    assigned,
    asked,
    fire: (type) => handlers.get(type)?.({}),
    openDesktop: () => click(openButton),
    keyField: () => keyInput,
    keyNote: () => keyNote,
    rowRefusal: () => (!refusedKeyNote.hidden ? 'key' : !refusedDeviceNote.hidden ? 'device' : 'none'),
    openButton: () => openButton,
    type: (text) => {
      keyInput.value = text
      handlers.get('ul:keydown')?.({ target: keyInput, key: 'A', preventDefault: () => undefined })
    },
    keyForm: () => keyForm,
    typeKeyButton: () => typeKeyButton,
    pressTypeKey: () => click(typeKeyButton),
    pressLink: () => click(linkButton),
    pressEnter: () =>
      handlers.get('ul:keydown')?.({ target: keyInput, key: 'Enter', preventDefault: () => undefined }),
    shown: (id) => byId.get(id)?.hidden === false
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
  /**
   * THE ONE THAT KILLED EVERY HAND-OFF. A canvas token names both ends, and
   * the desktop matches `device` on the query against the token's `dev`
   * claim — the DEVICE THAT ASKED, which is this phone. Naming the Mac there
   * is a hard 401 on a signature that was perfectly good, and it looks from
   * the outside like a pairing problem.
   */
  it('names the PHONE on the query, never the Mac', async () => {
    const picker = mount({ lanAnswers: true })
    await settle()
    picker.openDesktop()
    await settle()
    expect(picker.assigned).toHaveLength(1)
    expect(picker.assigned[0]).toBe(
      `https://192.168.1.24:8643/?open=CANVAS-TOKEN&key=A2B3C4&device=${picker.phoneId}&name=iPhone`
    )
    expect(picker.assigned[0]).not.toContain(picker.deviceId)
  })

  it('sends the relay path the SAME admission, unchanged, on cookrew.dev', async () => {
    const picker = mount({ lanAnswers: false, relayLive: true })
    await settle()
    picker.openDesktop()
    await settle()
    expect(picker.assigned[0]).toBe(
      `/relay/@owner/desktop/${picker.deviceId}/?open=CANVAS-TOKEN&key=A2B3C4&device=${picker.phoneId}&name=iPhone`
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

// ── coming back refused ──────────────────────────────────────────────────

describe('a desktop that would not take it', () => {
  /**
   * THE OWNER'S BUG. The sentence appeared and nothing else changed: the
   * refused six characters stayed in localStorage and the row went on
   * offering OPEN, which sent the same refused characters again. From the
   * outside the button had simply stopped working.
   */
  it('throws the refused key away and draws the row as NEEDS PAIRING', async () => {
    const picker = mount({ lanAnswers: true, refused: 'key' })
    await settle()
    expect(picker.stored(`cr_pair:${picker.deviceId}`)).toBeNull()
    expect(picker.badge()).toBe('pairing')
    expect(picker.openButton().hidden).toBe(true)
    expect(picker.openButton().disabled).toBe(true)
  })

  it('opens the field with the cursor in it and the reason under that row', async () => {
    const picker = mount({ lanAnswers: true, refused: 'key' })
    await settle()
    expect(picker.keyForm().hidden).toBe(false)
    expect(picker.keyField().focused).toBe(true)
    expect(picker.rowRefusal()).toBe('key')
    // Under the row, not at the top: a reader with three Macs must not have
    // to guess which one the line is about.
    expect(picker.shown('reach-refused')).toBe(false)
  })

  it('says the LINK named the Mac when it was the device', async () => {
    const picker = mount({ lanAnswers: true, refused: 'device' })
    await settle()
    expect(picker.rowRefusal()).toBe('device')
    expect(picker.stored(`cr_pair:${picker.deviceId}`)).toBeNull()
  })

  it('sends nothing at all while the refused key is gone', async () => {
    const picker = mount({ lanAnswers: true, refused: 'key' })
    await settle()
    picker.openDesktop()
    await settle()
    expect(picker.assigned).toHaveLength(0)
    expect(picker.asked.some((address) => address.includes('/open'))).toBe(false)
  })

  it('clears the sentence the moment new characters are typed', async () => {
    const picker = mount({ lanAnswers: true, refused: 'key' })
    await settle()
    expect(picker.rowRefusal()).toBe('key')
    picker.type('A')
    expect(picker.rowRefusal()).toBe('none')
  })

  it('takes a fresh key and goes back to offering OPEN', async () => {
    const picker = mount({ lanAnswers: true, refused: 'key' })
    await settle()
    picker.type('P7Q2M8')
    picker.pressLink()
    await settle()
    expect(picker.stored(`cr_pair:${picker.deviceId}`)).toBe('P7Q2M8')
    expect(picker.rowRefusal()).toBe('none')
    expect(picker.badge()).toBe('lan')
    expect(picker.openButton().hidden).toBe(false)
    expect(picker.openButton().disabled).toBe(false)
  })

  it('falls back to the page-level line when the refusal named no desktop', async () => {
    const picker = mount({ lanAnswers: true, refused: 'key', namesDesktop: false })
    await settle()
    expect(picker.shown('reach-refused')).toBe(true)
    expect(picker.rowRefusal()).toBe('none')
    // Nothing was named, so nothing is thrown away.
    expect(picker.stored(`cr_pair:${picker.deviceId}`)).toBe('A2B3C4')
  })

  it('says nothing at all on an ordinary visit', async () => {
    const picker = mount({ lanAnswers: true })
    await settle()
    expect(picker.shown('reach-refused')).toBe(false)
    expect(picker.shown('reach-refused-device')).toBe(false)
    expect(picker.rowRefusal()).toBe('none')
  })
})

describe('OPEN needs a key in hand', () => {
  it('is hidden and disabled on a Mac this browser has never paired with', async () => {
    const picker = mount({ unpaired: true, lanAnswers: true })
    await settle()
    expect(picker.openButton().hidden).toBe(true)
    expect(picker.openButton().disabled).toBe(true)
    picker.openDesktop()
    await settle()
    expect(picker.assigned).toHaveLength(0)
  })

  it('keeps the key where it is when the open succeeds and the page goes away', async () => {
    const picker = mount({ lanAnswers: true })
    await settle()
    expect(picker.openButton().disabled).toBe(false)
    picker.openDesktop()
    await settle()
    expect(picker.assigned).toHaveLength(1)
    // Nothing to undo: the navigation leaves, and the key is still here when
    // the reader comes back to /me.
    expect(picker.stored(`cr_pair:${picker.deviceId}`)).toBe('A2B3C4')
    expect(picker.rowRefusal()).toBe('none')
  })
})

// ── the six characters, in the page ──────────────────────────────────────

describe('TYPE KEY, which is a field and not a prompt', () => {
  it('opens the row\u2019s own field and puts the cursor in it', async () => {
    const picker = mount({ unpaired: true })
    await settle()
    expect(picker.badge()).toBe('pairing')
    expect(picker.keyForm().hidden).toBe(true)
    picker.pressTypeKey()
    expect(picker.keyForm().hidden).toBe(false)
    expect(picker.keyField().focused).toBe(true)
    expect(picker.typeKeyButton().hidden).toBe(true)
  })

  it('takes six characters from LINK, uppercased, and races the paths', async () => {
    const picker = mount({ unpaired: true, lanAnswers: true })
    await settle()
    picker.pressTypeKey()
    picker.keyField().value = ' a2b3c4 '
    picker.pressLink()
    await settle()
    expect(picker.stored(`cr_pair:${picker.deviceId}`)).toBe('A2B3C4')
    expect(picker.badge()).toBe('lan')
    expect(picker.keyField().value).toBe('')
  })

  it('takes them from ENTER as well', async () => {
    const picker = mount({ unpaired: true, lanAnswers: true })
    await settle()
    picker.pressTypeKey()
    picker.keyField().value = 'A2B3C4'
    picker.pressEnter()
    await settle()
    expect(picker.stored(`cr_pair:${picker.deviceId}`)).toBe('A2B3C4')
  })

  it('shows the page\u2019s own sentence for something that is not a key, and keeps nothing', async () => {
    const picker = mount({ unpaired: true })
    await settle()
    picker.pressTypeKey()
    picker.keyField().value = 'oops'
    picker.pressLink()
    await settle()
    expect(picker.keyNote().hidden).toBe(false)
    expect(picker.stored(`cr_pair:${picker.deviceId}`)).toBeNull()
    // The ambiguous characters are not in the alphabet the Mac draws from.
    picker.keyField().value = 'A2B3CO'
    picker.pressLink()
    await settle()
    expect(picker.stored(`cr_pair:${picker.deviceId}`)).toBeNull()
  })
})
