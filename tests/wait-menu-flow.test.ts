// THE MENU REACHES THE BOX (owner, 2026-11-04: an agent waited on a question and
// no rows showed). The tracker reads it off the whole screen, a mirrorless card
// gets it from its pane, and what stays on the screen stays open.
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { TurnTracker } from '../src/main/turn-tracker'
import type { PtySession } from '../src/main/pty'
import { createBackendPhaseGate } from '../src/main/backend-phase-gate'
import { mergeActivity } from '../src/renderer/src/turn-view-model'
import { answerView, keyAction } from '../src/renderer/src/prompt/wait-answer'
import { createMenuAnswerer, parseMenuRequest } from '../src/main/menu-answer'
import { answerKeys, choiceId, choiceSig, hasWordsRow, staysOpen, waitChoiceOfScreen, type WaitChoice } from '../src/shared/wait-choice'
import type { TerminalActivity } from '../src/shared/turn'

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
