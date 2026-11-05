// THE MENU REACHES THE BOX (owner, 2026-11-04: an agent waited on a question and
// no rows showed). The tracker reads it off the whole screen, a mirrorless card
// gets it from its pane, and what stays on the screen stays open.
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { MENU_GONE_SETTLE_MS, TurnTracker } from '../src/main/turn-tracker'
import type { PtySession } from '../src/main/pty'
import { createBackendPhaseGate } from '../src/main/backend-phase-gate'
import { mergeActivity } from '../src/renderer/src/turn-view-model'
import { answerView, keyAction } from '../src/renderer/src/prompt/wait-answer'
import { createMenuAnswerer, parseMenuRequest, setMenuAnswerer } from '../src/main/menu-answer'
import { handleMobileApi, type MobileApiDeps } from '../src/main/mobile-api'
import { answerKeys, choiceId, choiceSig, hasWordsRow, menuHeldOnScreen, staysOpen, waitChoiceOfScreen, type WaitChoice } from '../src/shared/wait-choice'
import type { TerminalActivity } from '../src/shared/turn'

// herdr's word on the pane, which often lags the screen.
const herdr = vi.hoisted(() => ({ status: null as string | null }))
vi.mock('../src/main/herdr-agent-status', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/main/herdr-agent-status')>()),
  agentStatus: () => herdr.status
}))

const pick = (key: string, label: string): WaitChoice['options'][number] => ({ key, label, detail: null })
const menu = (over: Partial<WaitChoice> = {}): WaitChoice => ({
  kind: 'menu',
  question: 'Which?',
  sub: null,
  options: [pick('1', 'A'), pick('2', 'B'), { ...pick('3', 'Type something.'), role: 'type' }, { ...pick('4', 'Chat about this'), role: 'chat' }],
  cursor: 0,
  escIndex: null,
  ...over
})

const PANE = readFileSync(join(__dirname, 'fixtures', 'wait-choice', 'claude-ask-multi-narrow-zh.txt'), 'utf8')

class PaneSession extends EventEmitter {
  constructor(public terminalId: string, public sessionName = `cookrew_${terminalId}`) {
    super()
  }
  fullText = (): string => PANE
  viewportText = (): string => PANE
  idleFor = (): number => 60_000
}

describe('a menu read before the screen caught up', () => {
  it('is read again once xterm has parsed', () => {
    let text = PANE
    class Late extends PaneSession {
      viewportText = (): string => text
    }
    const session = new Late('t1')
    const turns = new TurnTracker(async () => null)
    turns.track(session as unknown as PtySession, true)
    turns.observeBackendPhase('t1', 'waiting')
    const read = (): string | undefined => turns.list().find((a) => a.terminalId === 't1')?.waitChoice?.question
    const before = read()
    expect(before).toContain('怎么修')
    text = readFileSync(join(__dirname, 'fixtures', 'wait-choice', 'claude-tabs-q2.txt'), 'utf8')
    // Cached until told: the bytes were announced before xterm drew them.
    expect(read()).toBe(before)
    session.emit('parsed')
    expect(read()).toBe('Which scope should this cover?')
  })
})

describe('a menu on the screen is a wait, whatever the pane does to its words', () => {
  // Footer wrapped at 43 columns: "Esc to / cancel", and no "Enter to select" among the attention words.
  const NARROW = readFileSync(join(__dirname, 'fixtures', 'wait-choice', 'claude-tabs-multi.txt'), 'utf8')
  // A question, then the owner's own pasted list: a cursor row under a "?", and no footer.
  const ECHO = 'Which should go first?\n\n❯ 1. rename foo\n  2. rename bar\n\n⏺ Done.\n'
  type Inner = { tracked: Map<string, { turnStartedAt: number; answeredAt: number }>; poll: (t: unknown) => void }
  /** A poll of a turn long past its grace. */
  const quietPoll = (turns: TurnTracker): void => {
    const inner = turns as unknown as Inner
    const t = inner.tracked.get('t1')
    if (!t) throw new Error('not tracked')
    t.turnStartedAt = 1
    inner.poll(t)
  }
  class Quiet extends PaneSession {
    text = NARROW
    viewportText = (): string => this.text
    fullText = (): string => this.text
  }
  const held = (text = NARROW): { turns: TurnTracker; session: Quiet; phase: () => string | undefined } => {
    const session = new Quiet('t1')
    session.text = text
    const turns = new TurnTracker(async () => null)
    turns.track(session as unknown as PtySession, true)
    turns.observeBackendPhase('t1', 'waiting')
    return { turns, session, phase: () => turns.list().find((a) => a.terminalId === 't1')?.phase }
  }
  it('a tick repaints the menu: the wait holds and the rows stay (herdr silent)', () => {
    const { session, phase, turns } = held()
    session.emit('data', 'repaint')
    session.emit('parsed')
    expect(phase()).toBe('waiting')
    expect(turns.list()[0].waitChoice?.options.length).toBe(6)
  })
  it('the menu gone from the screen ends the wait, once it has stayed gone', () => {
    vi.useFakeTimers()
    try {
      const { session, phase } = held()
      session.emit('data', 'answer')
      session.text = '⏺ Thanks.\n'
      session.emit('parsed')
      expect(phase()).toBe('waiting')
      vi.advanceTimersByTime(MENU_GONE_SETTLE_MS)
      expect(phase()).toBe('thinking')
    } finally {
      vi.useRealTimers()
    }
  })
  // F2 (Menu QA, 2026-11-04): Submit to Review redraws through a frame with no
  // menu. The tracker took it for the menu's going, and on a pane herdr reads
  // as done it took up to 2.9 s to come back.
  it('a frame with no menu between two is not its going: the wait and the rows hold', () => {
    vi.useFakeTimers()
    try {
      const { session, phase, turns } = held()
      const REVIEW = readFileSync(join(__dirname, 'fixtures', 'wait-choice', 'claude-tabs-review.txt'), 'utf8')
      session.emit('data', 'submit')
      session.text = '\n'
      session.emit('parsed')
      session.emit('data', 'redraw')
      expect(phase()).toBe('waiting')
      expect(turns.list()[0].waitChoice?.options.length).toBe(6)
      session.text = REVIEW
      session.emit('parsed')
      vi.advanceTimersByTime(MENU_GONE_SETTLE_MS * 2)
      expect(phase()).toBe('waiting')
      expect(turns.list()[0].waitChoice?.review).toBeDefined()
    } finally {
      vi.useRealTimers()
    }
  })
  type Live = { tracked: Map<string, { prompt: string | null; menuShown: boolean }>; pendingDispatch: Map<string, unknown>; preemptOnOwnerSubmit: (id: string) => string }
  it('Enter at the menu takes the mark with it: the next wait starts clean', () => {
    const { session, turns } = held()
    const t = (turns as unknown as Live).tracked.get('t1')
    if (!t) throw new Error('not tracked')
    t.prompt = 'the turn'
    session.emit('data', 'repaint')
    expect(t.menuShown).toBe(true)
    session.emit('input', '\r')
    expect(t.menuShown).toBe(false)
  })
  it('a wait with no menu on the screen raises with no mark', () => {
    const { session, turns, phase } = held()
    const t = (turns as unknown as Live).tracked.get('t1')
    if (!t) throw new Error('not tracked')
    session.emit('data', '✻ Thinking… (esc to interrupt)')
    t.menuShown = true
    session.text = 'Do you want to proceed?\n'
    herdr.status = 'blocked'
    try {
      quietPoll(turns)
    } finally {
      herdr.status = null
    }
    expect(phase()).toBe('waiting')
    expect(t.menuShown).toBe(false)
  })
  it('words sent while a menu settles are a new prompt, not an answer to it', () => {
    vi.useFakeTimers()
    try {
      const { session, turns, phase } = held()
      const live = turns as unknown as Live
      const t = live.tracked.get('t1')
      if (!t) throw new Error('not tracked')
      t.prompt = 'the turn'
      session.emit('data', 'esc')
      session.text = '\n'
      session.emit('parsed')
      live.pendingDispatch.set('t1', { id: 'd', prompt: 'x', armedAt: 0 })
      let preempted = 0
      live.preemptOnOwnerSubmit = () => {
        preempted += 1
        return 'ok'
      }
      turns.guardOwnerInput('t1', 'hello\r')
      expect(preempted).toBe(1)
      session.emit('input', 'hello\r')
      expect(t.prompt).toBe('hello')
      expect(phase()).toBe('thinking')
      vi.advanceTimersByTime(MENU_GONE_SETTLE_MS)
      expect(phase()).toBe('thinking')
    } finally {
      vi.useRealTimers()
    }
  })
  // Measured 2026-11-04: a menu up at 43 columns, herdr reading idle, a mirror
  // attached after a restart: the card read replied, no rows, for good. A TUI
  // at a menu prints nothing more, and herdr never said blocked.
  const atRest = (text: string): { session: Quiet; phase: () => string | undefined; turns: TurnTracker } => {
    const session = new Quiet('t1')
    session.text = text
    const turns = new TurnTracker(async () => null)
    turns.track(session as unknown as PtySession, true)
    return { session, turns, phase: () => turns.list().find((a) => a.terminalId === 't1')?.phase }
  }
  it('a menu found on a screen at rest is a wait, rows and all', () => {
    const { session, phase, turns } = atRest(NARROW)
    expect(phase()).toBe('idle')
    session.emit('parsed')
    expect(phase()).toBe('waiting')
    expect(turns.list()[0].waitChoice?.options.length).toBe(6)
  })
  it('an earlier question\'s record over the menu is no spinner (a real pane, 43 columns)', () => {
    const screen = readFileSync(join(__dirname, 'fixtures', 'wait-choice', 'claude-answered-above-menu.txt'), 'utf8')
    const { session, phase, turns } = atRest(screen)
    session.emit('parsed')
    expect(phase()).toBe('waiting')
    expect(turns.list()[0].waitChoice?.question).toBe('Which colour?')
  })
  it("the owner's own picker is not: it reads as a menu, and no one is waiting on them", () => {
    // The real shape (ui-command-open.test.ts): a rule between the echo and its rows.
    const picker = `⏺ DONE\n\n❯ /model\n${'─'.repeat(60)}\n  Select model\n  ❯ 1. Default\n    2. Opus\n  Enter to set as default · Esc to cancel\n`
    expect(menuHeldOnScreen(picker)).toBe(true)
    const { session, phase } = atRest(picker)
    session.emit('parsed')
    expect(phase()).toBe('idle')
  })
  it('a picker nothing names is not either: a wait would reopen a finished turn', () => {
    const picker = `⏺ DONE\n\n${'─'.repeat(60)}\n  Select model\n  ❯ 1. Default\n    2. Opus\n  Enter to set as default · Esc to cancel\n`
    const { session, phase } = atRest(picker)
    session.emit('parsed')
    expect(phase()).toBe('idle')
  })
  it('nor is a plain screen at rest', () => {
    const { session, phase } = atRest('⏺ Done.\n')
    session.emit('parsed')
    expect(phase()).toBe('idle')
  })
  it('a spinner in that beat ends the wait at once', () => {
    vi.useFakeTimers()
    try {
      const { session, phase } = held()
      session.emit('data', 'answer')
      session.text = '\n'
      session.emit('parsed')
      session.emit('data', '✻ Thinking… (esc to interrupt)')
      expect(phase()).toBe('thinking')
    } finally {
      vi.useRealTimers()
    }
  })
  it('a menu coming up mid-turn waits at the next poll, with no quiet to sit out', () => {
    const { session, turns, phase } = held()
    session.emit('data', '✻ Thinking… (esc to interrupt)')
    session.idleFor = (): number => 0
    quietPoll(turns)
    expect(phase()).toBe('waiting')
  })
  it('a menu gone ends the wait even under a stale blocked: that edge fires only once', () => {
    vi.useFakeTimers()
    const { session, phase } = held()
    herdr.status = 'blocked'
    try {
      session.emit('data', 'esc')
      session.text = '⏺ Thanks.\n'
      session.emit('parsed')
      vi.advanceTimersByTime(MENU_GONE_SETTLE_MS)
      expect(phase()).toBe('thinking')
    } finally {
      herdr.status = null
      vi.useRealTimers()
    }
  })
  it('a digit pressed at the menu leaves nothing in the box: the agent is not "composing" (F11)', () => {
    const { session, turns } = held()
    session.emit('input', '2')
    expect((turns as unknown as { tracked: Map<string, { promptBuffer: string }> }).tracked.get('t1')?.promptBuffer).toBe('')
    expect(turns.ownerComposing('t1')).toBe(false)
  })
  it('the same digit with no menu up is the owner typing, as ever', () => {
    const { session, turns } = held()
    session.text = 'Which file should I open?\n'
    session.emit('input', '2')
    expect(turns.ownerComposing('t1')).toBe(true)
  })
  it('a free question still resumes on output, as ever', () => {
    const { session, phase } = held('Which file should I open?\n')
    session.emit('data', 'more')
    expect(phase()).toBe('thinking')
  })
  it('a spinner ends the wait at once, menu or no menu', () => {
    const { session, phase } = held()
    session.emit('data', '✻ Thinking… (esc to interrupt)')
    expect(phase()).toBe('thinking')
  })
  it('a turn going quiet with a menu up waits, it does not read as a reply', () => {
    const { session, turns, phase } = held()
    session.emit('data', '✻ Thinking… (esc to interrupt)')
    expect(phase()).toBe('thinking')
    quietPoll(turns)
    expect(phase()).toBe('waiting')
  })
  it('a finished reply that only looks like a menu ends as a reply, it never waits', () => {
    const { session, turns, phase } = held()
    session.emit('data', '✻ Thinking… (esc to interrupt)')
    session.text = ECHO
    quietPoll(turns)
    // No prompt was seen, so the turn is dropped rather than recorded: at rest.
    expect(phase()).toBe('idle')
  })
  it('an answer by the menu road is noted: a stale blocked is not believed past it', () => {
    const { turns, session } = held()
    const before = Date.now()
    turns.noteMenuAnswer('t1')
    expect((turns as unknown as Inner).tracked.get('t1')?.answeredAt).toBeGreaterThanOrEqual(before)
    expect(session.text).toBe(NARROW)
  })
})

describe('keys into a held menu, against the input box guards', () => {
  const guarded = (holder: string | null, stranded = false): TurnTracker => {
    const turns = new TurnTracker(async () => null)
    ;(turns as unknown as { lease: unknown }).lease = { holderOf: () => holder, isContaminated: () => true, hasStrandedPaste: () => stranded }
    return turns
  }
  it("a dispatched turn's residue refuses the box its Enter, and not the menu", () => {
    const turns = guarded(null)
    expect(turns.guardOwnerInput('t1', '\r')).toBe('refused')
    expect(turns.guardMenuKeys('t1', '\r')).toBe('allow')
  })
  it('a delivery mid-paste stops them too', () => {
    expect(guarded('dispatch').guardMenuKeys('t1', '1')).toBe('refused')
  })
  it('a paste known stranded stops an Enter, not a digit: the screen may trail the pane', () => {
    const turns = guarded(null, true)
    expect(turns.guardMenuKeys('t1', '\r')).toBe('refused')
    expect(turns.guardMenuKeys('t1', '2')).toBe('allow')
  })
})

describe('the phone answers a menu in a dispatched turn', () => {
  const route = async (path: string, body: unknown, armed = true): Promise<{ status: number; body: unknown }> => {
    const deps = { pairingToken: 'pairing-token-invented', hasArmedDispatch: () => armed, ptys: { get: () => undefined }, holdInput: () => true } as unknown as MobileApiDeps
    const server = http.createServer((request, response) => {
      const url = new URL(request.url ?? '/', `http://${request.headers.host}`)
      void handleMobileApi(request, response, url, deps).then((handled) => {
        if (!handled) response.writeHead(404).end()
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const { port } = server.address() as AddressInfo
      const reply = await fetch(`http://127.0.0.1:${port}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer pairing-token-invented' },
        body: JSON.stringify(body)
      })
      return { status: reply.status, body: await reply.json() }
    } finally {
      server.close()
    }
  }
  it('the answer goes through: it is what the armed turn waits for', async () => {
    const answered: string[] = []
    setMenuAnswerer(async (id) => {
      answered.push(id)
      return { ok: true }
    })
    const reply = await route('/api/terminal/t1/menu', { menu: 'm', act: { kind: 'row', index: 0 } })
    expect(reply).toEqual({ status: 200, body: { ok: true } })
    expect(answered).toEqual(['t1'])
  })
  it("the tray's Esc and arrows go the same way; anything else is not a menu key", async () => {
    setMenuAnswerer(async () => ({ ok: true }))
    expect((await route('/api/terminal/t1/menu', { menu: 'm', act: { kind: 'key', seq: '\x1b' } })).status).toBe(200)
    for (const seq of ['\r', 'rm -rf x\r', '\x1b[200~', '']) {
      expect((await route('/api/terminal/t1/menu', { menu: 'm', act: { kind: 'key', seq } })).status).toBe(400)
    }
  })
  it("the owner's Esc interrupts a dispatched turn from the phone, as the keyboard does", async () => {
    for (const data of ['\x1b', '\x1b\x1b']) {
      expect(await route('/api/terminal/t1/raw', { data })).toEqual({ status: 200, body: { ok: true } })
    }
  })
  it('a batch already typed answers as typed when it comes again under a new dispatch', async () => {
    const batch = { data: 'hello', id: 'page.retry1' }
    expect((await route('/api/terminal/t9/raw', batch, false)).status).toBe(200)
    expect((await route('/api/terminal/t9/raw', batch, true)).status).toBe(200)
  })
  it("a long block for an agent reaches the pane as a paste; a shell's as typed", async () => {
    const words = 'x'.repeat(1500)
    const held: string[] = []
    const post = async (command: string): Promise<void> => {
      const deps = {
        pairingToken: 'pairing-token-invented',
        hasArmedDispatch: () => false,
        ptys: { get: () => undefined },
        holdInput: (_id: string, data: string) => {
          held.push(data)
          return true
        },
        store: { nodeAcrossWorkspaces: () => ({ node: { kind: 'terminal', command } }) }
      } as unknown as MobileApiDeps
      const server = http.createServer((request, response) => {
        const url = new URL(request.url ?? '/', `http://${request.headers.host}`)
        void handleMobileApi(request, response, url, deps).then((handled) => {
          if (!handled) response.writeHead(404).end()
        })
      })
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      const { port } = server.address() as AddressInfo
      await fetch(`http://127.0.0.1:${port}/api/terminal/t1/raw`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer pairing-token-invented' },
        body: JSON.stringify({ data: words })
      })
      server.close()
    }
    await post('claude')
    await post('')
    expect(held).toEqual([`\x1b[200~${words}\x1b[201~`, words])
  })
  it('nothing else rides /raw past the dispatch', async () => {
    for (const data of ['hello', '\r', '\x1b[A', '\x1b\r', 'x\x1b', '']) {
      expect((await route('/api/terminal/t1/raw', { data })).status).toBe(409)
    }
    expect((await route('/api/terminal/t1/raw', {})).status).toBe(409)
  })
  it('a new prompt is still held back by the same dispatch', async () => {
    const reply = await route('/api/terminal/t1/input', { data: 'hello' })
    expect(reply.status).toBe(409)
  })
})

describe('the tracker reads the whole screen, not the summary tail', () => {
  it("an agent waiting on the owner's 30-line menu carries all its rows", () => {
    const turns = new TurnTracker(async () => null)
    turns.track(new PaneSession('t1') as unknown as PtySession, true)
    turns.observeBackendPhase('t1', 'waiting')
    const activity = turns.list().find((a) => a.terminalId === 't1')
    expect(activity?.phase).toBe('waiting')
    expect(activity?.waitChoice?.options.length).toBe(6)
    expect(activity?.lines.length).toBeLessThanOrEqual(14)
  })
  it('no menu while it does not wait', () => {
    const turns = new TurnTracker(async () => null)
    turns.track(new PaneSession('t1') as unknown as PtySession, true)
    expect(turns.list().find((a) => a.terminalId === 't1')?.waitChoice).toBeNull()
  })
  it('a card with no mirror carries the menu read from its pane, and loses it with the word', () => {
    const turns = new TurnTracker(async () => null)
    const seen: Array<TerminalActivity> = []
    turns.on('activity', (a: TerminalActivity) => seen.push(a))
    turns.observeBackendPhase('t2', 'waiting')
    turns.observeBackendChoice('t2', menu())
    expect(seen.at(-1)?.waitChoice?.question).toBe('Which?')
    expect(turns.list().find((a) => a.terminalId === 't2')?.waitChoice?.question).toBe('Which?')
    turns.observeBackendPhase('t2', null)
    expect(seen.at(-1)?.waitChoice ?? null).toBeNull()
  })
})

describe('a mirrorless card keeps the menu its pane showed', () => {
  it('takes the incoming menu over the words it keeps', () => {
    const known = { terminalId: 't', phase: 'idle', lines: ['x'], reply: 'said' } as unknown as TerminalActivity
    const next = mergeActivity(known, { terminalId: 't', phase: 'waiting', mirrorless: true, waitChoice: menu(), updatedAt: 2 } as unknown as TerminalActivity)
    expect(next.waitChoice?.question).toBe('Which?')
    expect(next.reply).toBe('said')
  })
})

describe('the gate asks for the menu of a waiting pane', () => {
  it('at once, then again while the word holds', async () => {
    let reads = 0
    const timers: Array<() => void> = []
    const gate = createBackendPhaseGate({
      read: async () => 'screen',
      current: () => 'waiting',
      apply: () => undefined,
      menu: async () => {
        reads += 1
      },
      schedule: (fn) => timers.push(fn),
      cancel: () => undefined
    })
    gate.observe('t', 'waiting', true)
    await vi.waitFor(() => expect(reads).toBe(1))
    expect(timers.length).toBe(1)
    timers[0]()
    await vi.waitFor(() => expect(reads).toBe(2))
    await vi.waitFor(() => expect(timers.length).toBe(2))
  })
  it('a read in flight across a retraction hands nothing on', async () => {
    let release: (s: string) => void = () => undefined
    const menus: string[] = []
    const gate = createBackendPhaseGate({
      read: () => new Promise((r) => (release = r)),
      current: () => 'waiting',
      apply: () => undefined,
      menu: async (id) => void menus.push(id),
      schedule: () => 0,
      cancel: () => undefined
    })
    gate.observe('t', 'waiting', true)
    gate.observe('t', null, true)
    gate.observe('t', 'waiting', true)
    const first = release
    first('old')
    await Promise.resolve()
    expect(menus).toEqual(['t'])
  })
})

describe('what stays on the screen stays open', () => {
  it('a tick and a move to the words row keep the menu; a pick does not', () => {
    expect(staysOpen({ ...pick('1', 'A'), role: 'toggle' })).toBe(true)
    expect(staysOpen({ ...pick('3', 'Type'), role: 'type' })).toBe(true)
    expect(staysOpen(pick('1', 'A'))).toBe(false)
  })
  it('on the words row a digit is a word; Esc still cancels', () => {
    const view = answerView(menu({ cursor: 2 }), null, 0)
    expect(keyAction(view, '1')).toBeNull()
    expect(keyAction(view, 'Escape')).toEqual({ index: -1, keys: '\x1b' })
  })
  it('off it, a digit answers', () => {
    expect(keyAction(answerView(menu(), null, 0), '2')).toEqual({ index: 1, keys: '2' })
  })
})

describe('the keys, as measured on the live TUI', () => {
  const DOWN = '\x1b[B'
  const UP = '\x1b[A'
  const multi = menu({ options: [{ ...pick('1', 'A'), role: 'toggle', checked: false }, { ...pick('2', 'Type something'), role: 'type', checked: false }, { key: '', label: 'Submit', detail: null, role: 'submit' }, { ...pick('3', 'Chat about this'), role: 'chat' }] })
  it('a single pick: the digit; words: digit, words, Enter, each a write of its own', () => {
    expect(answerKeys(menu(), { kind: 'row', index: 1 })).toEqual(['2'])
    expect(answerKeys(menu(), { kind: 'words', text: 'my own' })).toEqual(['3', 'my own', '\r'])
  })
  it('on the words row a digit would be a word: arrows and Enter pick another row', () => {
    expect(answerKeys(menu({ cursor: 2 }), { kind: 'row', index: 0 })).toEqual([UP + UP, '\r'])
    expect(answerKeys(menu({ cursor: 2 }), { kind: 'row', index: 2 })).toEqual([])
  })
  it('a row already holding words is emptied first; there, no move', () => {
    const held = menu({ cursor: 2, options: menu().options.map((o) => (o.role === 'type' ? { ...o, label: 'old words' } : o)) })
    expect(answerKeys(held, { kind: 'words', text: 'new' })).toEqual(['\x05\x15', 'new', '\r'])
  })
  it('a multi-select: words take no Enter (it unticks), Submit is arrows, then Enter alone', () => {
    expect(answerKeys(multi, { kind: 'words', text: 'x' })).toEqual([DOWN, 'x'])
    expect(answerKeys(multi, { kind: 'row', index: 2 })).toEqual([DOWN + DOWN, '\r'])
  })
  it('another question: ← → unless on the words row, where they are the caret\'s', () => {
    expect(answerKeys(menu(), { kind: 'step', dir: 1 })).toEqual(['\x1b[C'])
    expect(answerKeys(menu({ cursor: 2 }), { kind: 'step', dir: -1 })).toEqual([UP, '\x1b[D'])
  })
  it('knows a menu with a row to type in', () => {
    expect(hasWordsRow(menu())).toBe(true)
    expect(hasWordsRow(menu({ options: [pick('1', 'Yes'), pick('2', 'No')] }))).toBe(false)
    expect(hasWordsRow(null)).toBe(false)
  })
})

describe('an answer is checked against the screen', () => {
  const SCREEN = readFileSync(join(__dirname, 'fixtures', 'wait-choice', 'claude-tabs-q2.txt'), 'utf8')
  const OTHER = readFileSync(join(__dirname, 'fixtures', 'wait-choice', 'claude-tabs-q1.txt'), 'utf8')
  const shown = waitChoiceOfScreen(SCREEN) as WaitChoice
  const setup = (screen: string | null, send = (): boolean => true): { sent: string[]; answer: ReturnType<typeof createMenuAnswerer> } => {
    const sent: string[] = []
    const answer = createMenuAnswerer({
      screen: async () => screen,
      send: (_id, keys) => {
        sent.push(keys)
        return send()
      },
      sleep: async () => undefined
    })
    return { sent, answer }
  }
  it('the same menu: the keys go, worked out from the cursor on the screen', async () => {
    const { sent, answer } = setup(SCREEN)
    expect(await answer('t', { menu: choiceId(shown), act: { kind: 'row', index: 1 } })).toEqual({ ok: true })
    expect(sent).toEqual(['2'])
  })
  it('the screen moved on to another question: nothing goes', async () => {
    const { sent, answer } = setup(OTHER)
    expect(await answer('t', { menu: choiceId(shown), act: { kind: 'row', index: 0 } })).toEqual({ ok: false, reason: 'moved' })
    expect(sent).toEqual([])
  })
  it('no menu, or an unreadable screen: nothing goes', async () => {
    for (const screen of ['⏺ Done.\n', null]) {
      const { sent, answer } = setup(screen)
      expect(await answer('t', { menu: choiceId(shown), act: { kind: 'row', index: 0 } })).toEqual({ ok: false, reason: 'moved' })
      expect(sent).toEqual([])
    }
  })
  it('a menu gone between two writes takes no more: the Enter never reaches the box', async () => {
    let screen = SCREEN
    const sent: string[] = []
    const answer = createMenuAnswerer({
      screen: async () => screen,
      send: (_id, keys) => {
        sent.push(keys)
        screen = '⏺ Thanks.\n'
        return true
      },
      sleep: async () => undefined
    })
    expect(await answer('t', { menu: choiceId(shown), act: { kind: 'words', text: 'x' } })).toEqual({ ok: false, reason: 'moved' })
    expect(sent.length).toBe(1)
  })
  it('says which road the keys take: a held menu, or rows and y/n lines the box guards still watch', async () => {
    const roads: boolean[] = []
    const yn = 'Proceed? (y/n)\n'
    const echo = 'Which should go first?\n\n❯ 1. rename foo\n  2. rename bar\n\n⏺ Done.\n'
    const answerOn = (screen: string): ReturnType<typeof createMenuAnswerer> =>
      createMenuAnswerer({
        screen: async () => screen,
        send: (_id, _keys, inMenu) => {
          roads.push(inMenu)
          return true
        },
        sleep: async () => undefined
      })
    await answerOn(SCREEN)('t', { menu: choiceId(shown), act: { kind: 'row', index: 1 } })
    await answerOn(yn)('t', { menu: choiceId(waitChoiceOfScreen(yn) as WaitChoice), act: { kind: 'row', index: 0 } })
    await answerOn(echo)('t', { menu: choiceId(waitChoiceOfScreen(echo) as WaitChoice), act: { kind: 'row', index: 0 } })
    expect(roads).toEqual([true, false, false])
  })
  it("a tray key reaches the menu as itself", async () => {
    const { sent, answer } = setup(SCREEN)
    expect(await answer('t', { menu: choiceId(shown), act: { kind: 'key', seq: '\x1b[B' } })).toEqual({ ok: true })
    expect(sent).toEqual(['\x1b[B'])
  })
  it('keys refused stop there', async () => {
    const { sent, answer } = setup(SCREEN, () => false)
    expect(await answer('t', { menu: choiceId(shown), act: { kind: 'words', text: 'x' } })).toEqual({ ok: false, reason: 'refused' })
    expect(sent.length).toBe(1)
  })
  it('answers to one terminal go one at a time, each reading the screen', async () => {
    let screen = SCREEN
    const sent: string[] = []
    const answer = createMenuAnswerer({
      screen: async () => screen,
      send: (_id, keys) => {
        sent.push(keys)
        screen = OTHER
        return true
      },
      sleep: async () => undefined
    })
    const both = await Promise.all([answer('t', { menu: choiceId(shown), act: { kind: 'row', index: 0 } }), answer('t', { menu: choiceId(shown), act: { kind: 'row', index: 0 } })])
    expect(both).toEqual([{ ok: true }, { ok: false, reason: 'moved' }])
    expect(sent).toEqual(['1'])
  })
  it('a tick is still the same menu; typed words are too', () => {
    const ticked: WaitChoice = menu({ options: [{ ...pick('1', 'A'), role: 'toggle', checked: true }, pick('2', 'B')] })
    const unticked: WaitChoice = { ...ticked, options: ticked.options.map((o) => ({ ...o, checked: false })) }
    expect(choiceId(ticked)).toBe(choiceId(unticked))
    expect(choiceSig(ticked)).not.toBe(choiceSig(unticked))
    const typed = menu({ options: menu().options.map((o) => (o.role === 'type' ? { ...o, label: 'mine' } : o)) })
    expect(choiceId(typed)).toBe(choiceId(menu()))
  })
  it('takes only what a client may ask', () => {
    expect(parseMenuRequest({ menu: 'm', act: { kind: 'row', index: 2 } })).toEqual({ menu: 'm', act: { kind: 'row', index: 2 } })
    expect(parseMenuRequest({ menu: 'm', act: { kind: 'words', text: 'a\u001b[Bb\r' } })).toEqual({ menu: 'm', act: { kind: 'words', text: 'a [Bb' } })
    for (const bad of [null, {}, { menu: 'm' }, { menu: '', act: { kind: 'esc' } }, { menu: 'm', act: { kind: 'row', index: -1 } }, { menu: 'm', act: { kind: 'step', dir: 2 } }, { menu: 'm', act: { kind: 'keys', data: 'rm' } }]) {
      expect(parseMenuRequest(bad)).toBeNull()
    }
  })
})
