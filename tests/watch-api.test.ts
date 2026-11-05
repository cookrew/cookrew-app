import { readFileSync, writeFileSync, existsSync, mkdtempSync } from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { handleMobileApi, type MobileApiDeps } from '../src/main/mobile-api'
import { CHECKPOINT_MEMO_MS, cardCheckpoint, checkpointsOf, setWatchHost, watchRouteAllowed, browserInputOf, type WatchHost } from '../src/main/watch-routes'
import { WatchPairing } from '../src/main/watch-pairing'
import { watchBases } from '../src/main/watch-bases'
import { cardRows, itemsOfAgent, watchCards } from '../src/main/watch-cards'
import type { BoardRow, BoardPhase } from '../src/shared/board'
import type { TerminalActivity } from '../src/shared/turn'
import type { CanvasNode } from '../src/shared/model'
import { inkStatusOfRow, statusWord } from '../src/renderer/src/zoom/ink-status'

/**
 * THE WRIST'S ROUTES, THROUGH THE REAL GATE. A watch token is a real HTTP
 * credential here: every answer below came out of handleMobileApi.
 */

const NOW = 1_800_000_000_000
const PAIRING = 'pairing-token-for-tests-0123456789'
const WALL = 'wall-token-for-tests-0123456789'

const row = (id: string, phase: BoardPhase, over: Partial<BoardRow> = {}): BoardRow =>
  ({
    terminalId: id,
    agent: { name: id, preset: 'Claude Code', role: null, orch: false },
    workspace: { id: 'ws', name: 'Cookrew Dev', active: true },
    cwd: '/tmp',
    task: { title: `about ${id}`, summary: null, turnIndex: 1, startedAt: NOW, endedAt: null },
    phase,
    source: 'live',
    lastActivityAt: NOW,
    turnCount: 1,
    ...over
  }) as BoardRow

const activity = (id: string, over: Partial<TerminalActivity>): TerminalActivity =>
  ({ terminalId: id, agent: true, phase: 'idle', prompt: 'go', dispatchId: null, pendingInput: null, lines: [], reply: null, glance: null, title: null, turnCount: 1, turnStartLine: null, scrollRow: null, tailLines: null, scrollBase: null, turnStartedAt: null, updatedAt: NOW, ...over }) as TerminalActivity

const MENU = {
  kind: 'menu' as const,
  question: 'Allow this edit?',
  sub: 'Edit · a.ts · +1 −1',
  options: [
    { key: '1', label: 'Yes', detail: null },
    { key: '2', label: 'Yes, and allow all edits', detail: null },
    { key: '3', label: 'No, tell Claude what to do differently', detail: null }
  ],
  cursor: 0,
  escIndex: 2
}

const ROWS: BoardRow[] = [
  row('resting', 'offline', { lastActivityAt: NOW - 50 }),
  row('working', 'working', { lastActivityAt: NOW - 40 }),
  row('asking', 'waiting', { lastActivityAt: NOW - 90, agent: { name: 'Fresco', preset: 'Codex', role: null, orch: true } }),
  row('replied', 'unread', { lastActivityAt: NOW - 30 }),
  row('asleep', 'offline', { lastActivityAt: NOW - 10 })
]
const ACTIVITIES = [
  activity('asking', { phase: 'waiting', waitChoice: MENU, glance: { message: 'Allow this edit?' } as TerminalActivity['glance'] }),
  activity('replied', { phase: 'replied', reply: 'Merged.\n\nThe tests pass and the app restarted.' }),
  activity('working', { phase: 'thinking', glance: { status: 'Reading files (esc to interrupt)' } as TerminalActivity['glance'] })
]
const NODES = [
  { kind: 'browser', id: 'b1', name: 'Report', url: 'https://example.com/a/b', tabs: [{ id: 't', url: 'https://example.com/a/b', title: 'The report' }], activeTabId: 't' },
  { kind: 'note', id: 'n1', name: 'plan', content: 'first line\nsecond line' },
  { kind: 'terminal', id: 'replied', name: 'replied' }
] as unknown as CanvasNode[]
const CONNECTIONS = [
  { id: 'c1', a: 'replied', b: 'n1' },
  { id: 'c2', a: 'b1', b: 'replied' },
  { id: 'c3', a: 'replied', b: 'working' }
]

function host(pairing: WatchPairing, over: Partial<WatchHost> = {}): WatchHost {
  return {
    pairing,
    desktopName: () => 'Test Mac',
    bases: () => [{ kind: 'lan', url: 'http://192.168.2.40:8639' }],
    canvas: () => ({ nodes: NODES, connections: CONNECTIONS }),
    frame: async (id) => (id === 'b1' ? { type: 'image/jpeg', data: Buffer.from([0xff, 0xd8, 1]) } : null),
    browser: async () => null,
    note: (id) => (id === 'n1' ? { name: 'plan', content: 'first line\nsecond line' } : null),
    makeAgent: async () => 'new-agent',
    stop: async (id) => id === 'working',
    speaksTo: (id) => id !== 'shell',
    menuOnScreen: (id) => id === 'unparsed-menu',
    ...over
  }
}

describe('watchRouteAllowed: the list, and only the list', () => {
  it('opens what a card offers', () => {
    for (const [method, route] of [
      ['GET', '/api/watch/cards'],
      ['GET', '/api/watch/me'],
      ['GET', '/api/watch/item/b1'],
      ['GET', '/api/watch/item/b1/frame'],
      ['POST', '/api/watch/item/b1/input'],
      ['POST', '/api/watch/card/a/stop'],
      ['POST', '/api/watch/new'],
      ['POST', '/api/watch/unpair'],
      ['POST', '/api/terminal/a/input'],
      ['POST', '/api/terminal/a/menu'],
      ['POST', '/api/terminal/a/seen']
    ]) expect(watchRouteAllowed(method, route), `${method} ${route}`).toBe(true)
  })
  it('never the terminal, the workspace, the secrets or its own pairing', () => {
    for (const [method, route] of [
      ['POST', '/api/terminal/a/raw'],
      ['POST', '/api/terminal/a/ask'],
      ['GET', '/api/terminal/a/stream'],
      ['GET', '/api/workspace'],
      ['GET', '/api/board'],
      ['GET', '/api/secrets'],
      ['POST', '/api/watch/code'],
      ['GET', '/api/watch/pairing'],
      ['DELETE', '/api/watch/cards'],
      ['POST', '/api/watch/cards'],
      ['POST', '/api/terminals']
    ]) expect(watchRouteAllowed(method, route), `${method} ${route}`).toBe(false)
  })
})

describe('the card on the wrist says what the card on the Mac says', () => {
  const cards = watchCards({
    rows: ROWS,
    activities: new Map(ACTIVITIES.map((a) => [a.terminalId, a])),
    checkpoints: new Map([['resting', { prompt: 'p', reply: 'An earlier answer', title: 'A title' }]]),
    active: (id) => id !== 'asleep',
    itemsOf: (id) => itemsOfAgent(id, { nodes: NODES, connections: CONNECTIONS })
  })
  const card = (id: string) => cards.find((c) => c.id === id)

  it('walks what needs the owner first', () => {
    expect(cards.map((c) => c.id)).toEqual(['asking', 'replied', 'working', 'resting', 'asleep'])
  })
  it('has the same state and word as the ink face (ink-status.ts)', () => {
    expect(card('working')?.status).toBe(inkStatusOfRow('working'))
    expect(card('asking')?.status).toBe(inkStatusOfRow('waiting'))
    expect(card('replied')?.status).toBe(inkStatusOfRow('done', true))
    expect(card('resting')?.status).toBe(inkStatusOfRow('done', false))
    expect(card('asleep')?.status).toBe(inkStatusOfRow('offline'))
    for (const c of cards) expect(c.word).toBe(statusWord(c.status))
  })
  it('asleep means closed; a resting agent with no pane attached here is resting', () => {
    expect(card('resting')).toMatchObject({ status: 'idle', word: 'resting' })
    expect(card('asleep')).toMatchObject({ status: 'offline', word: 'offline' })
  })
  it('its words are the card’s: a status while working, the reply when done, a checkpoint with no mirror', () => {
    expect(card('working')?.words).toEqual({ text: 'Reading files', tone: 'working' })
    expect(card('replied')?.words).toEqual({ text: 'Merged.', tone: 'done', full: 'Merged.\n\nThe tests pass and the app restarted.' })
    expect(card('resting')?.words).toEqual({ text: 'An earlier answer', tone: 'done' })
    expect(card('resting')?.about).toBe('A title')
  })
  it('a waiting agent brings its menu, with the id an answer must name', () => {
    expect(card('asking')?.choice?.question).toBe('Allow this edit?')
    expect(card('asking')?.choice?.id).toContain('Allow this edit?')
    expect(card('resting')?.choice).toBeNull()
  })
  it('its items are its cables, newest wire first, terminals left out', () => {
    expect(card('replied')?.items.map((i) => i.id)).toEqual(['b1', 'n1'])
    expect(card('replied')).toMatchObject({ browsers: 1, notes: 1 })
    expect(card('replied')?.items[0]).toMatchObject({ kind: 'browser', title: 'The report', host: 'example.com/a', initial: 'T' })
  })
  it('a crowd is cut after the ones that need the owner', () => {
    const many = Array.from({ length: 60 }, (_, i) => row(`r${i}`, 'done', { lastActivityAt: NOW - i }))
    const kept = cardRows([...many, row('late', 'waiting', { lastActivityAt: NOW - 1000 })])
    expect(kept).toHaveLength(40)
    expect(kept[0].terminalId).toBe('late')
  })
  it('the contract the Swift client decodes is this exact shape (watch/Fixtures/cards.json)', () => {
    const file = path.join(__dirname, '..', 'watch', 'Fixtures', 'cards.json')
    const body = `${JSON.stringify({ cards, activeWorkspaceId: 'ws' }, null, 2)}\n`
    if (!existsSync(file) || process.env.UPDATE_WATCH_FIXTURE === '1') writeFileSync(file, body)
    expect(readFileSync(file, 'utf8')).toBe(body)
  })
})

describe('the words a finished card says', () => {
  const block = { id: 'b', prompt: 'do it', reply: 'Let me look at the code.\n\nDone: it is merged.', activity: [{ at: 24 }] }
  const stream = {
    sourceOf: (id: string) => (id === 'known' ? ({} as never) : null),
    tailState: async () => ({ block }) as never,
    marks: () => new Map([['b', { title: 'Merge it' }]]) as never
  }
  const latest = async () => ({ prompt: 'p', reply: 'from the old reader' })

  it('are the turn’s closing message, not its opening narration', async () => {
    expect(await cardCheckpoint('known', stream, latest)).toEqual({ prompt: 'do it', reply: 'Done: it is merged.', title: 'Merge it' })
  })
  it('come from the old reader for a card the stream does not know', async () => {
    expect(await cardCheckpoint('unknown', stream, latest)).toEqual({ prompt: 'p', reply: 'from the old reader' })
    expect(await cardCheckpoint('unknown', undefined, undefined)).toBeNull()
  })
})

describe('how long a card’s last turn is believed', () => {
  const rows = [{ terminalId: 'a' }]
  it('a new reply shows within the memo, though the board’s row never moved', async () => {
    const memo = new Map()
    const read = vi.fn(async () => ({ prompt: 'p', reply: 'one' }))
    await checkpointsOf(rows, new Map(), read, 1000, memo)
    await checkpointsOf(rows, new Map(), read, 1000 + CHECKPOINT_MEMO_MS - 1, memo)
    expect(read).toHaveBeenCalledTimes(1)
    read.mockResolvedValue({ prompt: 'p', reply: 'two' })
    const later = await checkpointsOf(rows, new Map(), read, 1000 + CHECKPOINT_MEMO_MS, memo)
    expect(later.get('a')?.reply).toBe('two')
  })
  it('a live reply needs no read, and a failed read keeps what was known', async () => {
    const memo = new Map()
    const read = vi.fn(async () => ({ prompt: 'p', reply: 'one' }))
    expect((await checkpointsOf(rows, new Map([['a', activity('a', { reply: 'live' })]]), read, 0, memo)).size).toBe(0)
    expect(read).not.toHaveBeenCalled()
    await checkpointsOf(rows, new Map(), read, 0, memo)
    read.mockRejectedValue(new Error('gone'))
    expect((await checkpointsOf(rows, new Map(), read, CHECKPOINT_MEMO_MS, memo)).get('a')?.reply).toBe('one')
  })
})

describe('where a watch reaches this Mac', () => {
  it('a trusted name first, then the LAN, then the tailnet; never loopback, never a token', () => {
    const endpoint = (kind: string, host: string, trustedUrl?: string) => ({ url: `https://${host}:8643/?token=secret`, kind, host, label: '', ...(trustedUrl ? { trustedUrl } : {}) })
    const bases = watchBases(
      [endpoint('tailscale', '100.64.1.2'), endpoint('lan', '192.168.2.40', 'https://192-168-2-40.abc.d.cookrew.dev:8643/?token=secret'), endpoint('loopback', '127.0.0.1'), endpoint('lan', 'fe80::1')] as never,
      8639
    )
    expect(bases).toEqual([
      { kind: 'name', url: 'https://192-168-2-40.abc.d.cookrew.dev:8643' },
      { kind: 'lan', url: 'http://192.168.2.40:8639' },
      { kind: 'tailnet', url: 'http://100.64.1.2:8639' }
    ])
    expect(JSON.stringify(bases)).not.toContain('secret')
  })
})

describe('browser input from a wrist', () => {
  const viewport = { width: 800, height: 600 }
  it('points are fractions of the picture; anything outside it is refused', () => {
    expect(browserInputOf({ t: 'tap', x: 0.5, y: 0.25 }, viewport)).toEqual({ t: 'tap', x: 400, y: 150 })
    expect(browserInputOf({ t: 'tap', x: 1.2, y: 0.25 }, viewport)).toBeNull()
    expect(browserInputOf({ t: 'tap', x: 'a', y: 0 }, viewport)).toBeNull()
  })
  it('a crown turn is a wheel at the middle of the page; Enter is a key; nothing else passes', () => {
    expect(browserInputOf({ t: 'scroll', dy: 120 }, viewport)).toEqual({ t: 'wheel', x: 400, y: 300, dy: 120 })
    expect(browserInputOf({ t: 'enter' }, viewport)).toEqual({ t: 'key', key: 'Enter', code: 'Enter' })
    expect(browserInputOf({ t: 'evaluate', expression: '1' }, viewport)).toBeNull()
    expect(browserInputOf({ method: 'Runtime.evaluate' }, viewport)).toBeNull()
  })
})

describe('through the real gate', () => {
  let server: http.Server
  let origin = ''
  let pairing: WatchPairing
  const seen = vi.fn()

  const deps = {
    pairingToken: PAIRING,
    wallToken: WALL,
    store: { focusedState: { nodes: [], connections: [] } },
    ptys: { get: () => undefined },
    turns: { list: () => ACTIVITIES, seen },
    agents: { list: () => [{ id: 'asleep', active: false }] },
    ops: {},
    presets: [],
    board: { activeWorkspaceId: () => 'ws', live: () => ACTIVITIES, ledger: () => new Map(), registry: () => [] },
    latestCheckpoint: async () => null
  } as unknown as MobileApiDeps

  vi.mock('../src/main/board-index', async (importActual) => {
    const actual = await importActual<typeof import('../src/main/board-index')>()
    return { ...actual, buildBoard: () => ({ rows: ROWS, summary: {}, activeWorkspaceId: 'ws' }) }
  })

  beforeAll(async () => {
    server = http.createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://localhost')
      void handleMobileApi(request, response, url, deps).then((handled) => {
        if (handled) return
        response.writeHead(404)
        response.end()
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterAll(async () => {
    setWatchHost(null)
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
  beforeEach(() => {
    pairing = new WatchPairing({ file: path.join(mkdtempSync(path.join(tmpdir(), 'watch-api-')), 'watch-token') })
    setWatchHost(host(pairing))
    seen.mockClear()
  })

  const call = (route: string, token: string | null, init: RequestInit = {}): Promise<Response> =>
    fetch(`${origin}${route}`, { ...init, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(init.body ? { 'content-type': 'application/json' } : {}), ...init.headers } })
  const post = (route: string, token: string | null, body: unknown = {}): Promise<Response> => call(route, token, { method: 'POST', body: JSON.stringify(body) })
  const paired = async (): Promise<string> => {
    const { code } = (await (await post('/api/watch/code', PAIRING)).json()) as { code: string }
    const claimed = (await (await post('/api/watch/claim', null, { code })).json()) as { token: string; desktop: string; bases: unknown[] }
    expect(claimed.desktop).toBe('Test Mac')
    expect(claimed.bases).toHaveLength(1)
    return claimed.token
  }

  it('a claim needs no token, gives one, and the wrong digits give nothing', async () => {
    await post('/api/watch/code', PAIRING)
    const refused = await post('/api/watch/claim', null, { code: 'nope' })
    expect(refused.status).toBe(403)
    expect(await refused.json()).toEqual({ ok: false, reason: 'wrong' })
    expect(await paired()).toMatch(/.{16,}/)
  })

  it('only the owner mints a code or asks after the pairing', async () => {
    const token = await paired()
    expect((await post('/api/watch/code', token)).status).toBe(401)
    expect((await post('/api/watch/code', null)).status).toBe(401)
    expect((await call('/api/watch/pairing', token)).status).toBe(401)
    expect(await (await call('/api/watch/pairing', PAIRING)).json()).toEqual({ paired: true, pending: null })
  })

  it('a watch token reads the cards; none, a junk one or the wall’s does not', async () => {
    const token = await paired()
    const cards = await call('/api/watch/cards', token)
    expect(cards.status).toBe(200)
    const body = (await cards.json()) as { cards: { id: string }[] }
    expect(body.cards[0].id).toBe('asking')
    expect((await call('/api/watch/cards', null)).status).toBe(401)
    expect((await call('/api/watch/cards', 'junk-junk-junk-junk')).status).toBe(401)
    expect((await call('/api/watch/cards', WALL)).status).toBe(401)
    expect((await call('/api/watch/item/n1', WALL)).status).toBe(401)
  })

  it('a watch token is nothing anywhere off its list', async () => {
    const token = await paired()
    expect((await call('/api/workspace', token)).status).toBe(401)
    expect((await call('/api/board', token)).status).toBe(401)
    expect((await post('/api/terminal/working/raw', token, { data: 'rm -rf\r' })).status).toBe(401)
    expect((await post('/api/terminals', token, { name: 'x', preset: 'y' })).status).toBe(401)
  })

  it('an unchanged crew costs a 304', async () => {
    const token = await paired()
    const first = await call('/api/watch/cards', token)
    const tag = first.headers.get('etag')
    expect(tag).toBeTruthy()
    const again = await call('/api/watch/cards', token, { headers: { 'if-none-match': tag as string } })
    expect(again.status).toBe(304)
  })

  it('stop, seen, a new agent, a note and a frame all answer the token', async () => {
    const token = await paired()
    expect((await post('/api/watch/card/working/stop', token)).status).toBe(200)
    expect((await post('/api/watch/card/asleep/stop', token)).status).toBe(404)
    expect((await post('/api/terminal/replied/seen', token)).status).toBe(200)
    expect(seen).toHaveBeenCalledWith('replied')
    expect(await (await post('/api/watch/new', token, { text: 'Fix the build' })).json()).toEqual({ ok: true, id: 'new-agent' })
    expect((await post('/api/watch/new', token, { text: '   ' })).status).toBe(400)
    expect(await (await call('/api/watch/item/n1', token)).json()).toEqual({ name: 'plan', content: 'first line\nsecond line' })
    const frame = await call('/api/watch/item/b1/frame', token)
    expect(frame.headers.get('content-type')).toBe('image/jpeg')
    expect((await call('/api/watch/item/b9/frame', token)).status).toBe(404)
  })

  it('a machine\'s screen is never driven from a wrist: refused out loud, and nothing reaches it', async () => {
    const dispatchInput = vi.fn(async () => undefined)
    const instance = { viewportState: { width: 800, height: 600, transitioning: false, agentHeld: false }, dispatchInput, needsViewer: true }
    setWatchHost(host(pairing, { browser: async () => instance as never }))
    const token = await paired()
    for (const body of [{ t: 'tap', x: 0.5, y: 0.5 }, { t: 'text', text: 'hunter2' }, { t: 'enter' }]) {
      expect((await post('/api/watch/item/b1/input', token, body)).status).toBe(409)
    }
    expect(dispatchInput).not.toHaveBeenCalled()
  })

  it('browser input goes through the closed vocabulary, and waits for a driving agent', async () => {
    const dispatchInput = vi.fn(async () => undefined)
    const paste = vi.fn(async () => undefined)
    const instance = { viewportState: { width: 800, height: 600, transitioning: false, agentHeld: false }, dispatchInput, paste }
    setWatchHost(host(pairing, { browser: async () => instance as never }))
    const token = await paired()
    expect((await post('/api/watch/item/b1/input', token, { t: 'tap', x: 0.5, y: 0.5 })).status).toBe(200)
    expect(dispatchInput).toHaveBeenCalledWith('Input.dispatchMouseEvent', expect.objectContaining({ type: 'mousePressed', x: 400, y: 300 }))
    expect((await post('/api/watch/item/b1/input', token, { t: 'text', text: '你好' })).status).toBe(200)
    expect(paste).toHaveBeenCalledWith('你好')
    expect((await post('/api/watch/item/b1/input', token, { t: 'evaluate' })).status).toBe(400)
    instance.viewportState.agentHeld = true
    expect((await post('/api/watch/item/b1/input', token, { t: 'tap', x: 0.1, y: 0.1 })).status).toBe(409)
  })

  it('a watch reaches no shell, and no input line with a menu up; the phone’s own use is untouched', async () => {
    const token = await paired()
    const shell = await post('/api/terminal/shell/input', token, { text: 'rm -rf ~' })
    expect(shell.status).toBe(403)
    expect((await post('/api/terminal/shell/menu', token, { menu: 'm', act: { kind: 'esc' } })).status).toBe(403)
    expect((await post('/api/watch/card/shell/stop', token)).status).toBe(403)
    expect((await post('/api/terminal/unparsed-menu/input', token, { text: 'No' })).status).toBe(409)
    // Not refused here (the fake has no /input below the gate): the owner passes straight through.
    expect((await post('/api/terminal/shell/input', PAIRING, { text: 'ls' })).status).not.toBe(403)
  })

  it('forgetting the watch ends its token, and a watch can forget itself', async () => {
    const token = await paired()
    expect((await post('/api/watch/unpair', token)).status).toBe(200)
    expect((await call('/api/watch/cards', token)).status).toBe(401)
  })
})
