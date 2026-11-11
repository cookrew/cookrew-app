import { describe, expect, it } from 'vitest'
import { artifactsOf, crumbsOf, menuCall, parseRemoteCards, remoteAgentView, replyCall, sendRefusal, stopCall, tileView } from '../src/renderer/src/zoom/remote-machine'

/**
 * ANOTHER MACHINE INSIDE THIS ONE'S ZOOM VIEW (owner 2026-11-10, design B): the
 * pure half. Its own cards (the watch's compact API, main/watch-routes.ts) as
 * the zoom's own views, and the breadcrumb that always says whose they are.
 */

const card = (over: Record<string, unknown> = {}) => ({
  id: 't-1',
  name: 'Herdr Env',
  preset: 'claude',
  orch: false,
  workspace: { id: 'w-1', name: 'Box Lab', active: true },
  status: 'waiting',
  word: 'needs you',
  words: { text: 'All checks pass.', tone: 'done', full: 'All checks pass.\nThe GPU lane is next.' },
  about: 'Box tests',
  choice: null,
  items: [{ id: 'b-1', kind: 'browser', title: 'Box', host: 'localhost:8643', tint: '#456', initial: 'B' }],
  browsers: 1,
  notes: 0,
  at: 5,
  ...over
})

const answer = (over: Record<string, unknown> = {}) => ({
  cards: [card()],
  activeWorkspaceId: 'w-1',
  platform: 'linux',
  workspaces: [
    { id: 'w-1', name: 'Box Lab', active: true, agents: 3, waiting: 1, working: 1, done: 0 },
    { id: 'w-2', name: 'Gauge', active: false, agents: 2, waiting: 0, working: 0, done: 0 }
  ],
  ...over
})

describe('parseRemoteCards', () => {
  it('reads the answer whole', () => {
    const read = parseRemoteCards(answer())
    expect(read?.platform).toBe('linux')
    expect(read?.workspaces.map((w) => w.name)).toEqual(['Box Lab', 'Gauge'])
    expect(read?.cards[0]).toMatchObject({ id: 't-1', name: 'Herdr Env', status: 'waiting', items: [{ id: 'b-1', kind: 'browser' }] })
  })

  it('drops a card or a workspace it cannot use, keeps the rest', () => {
    const read = parseRemoteCards(answer({ cards: [card(), { id: 5 }, card({ id: 't-2', status: 'exploded' }), card({ id: 't-3', items: [{ id: 'x', kind: 'shell' }] })], workspaces: [{ id: 'w-1', name: 'Box Lab' }, null] }))
    expect(read?.cards.map((c) => c.id)).toEqual(['t-1', 't-3'])
    expect(read?.cards[1]?.items).toEqual([])
    expect(read?.workspaces.map((w) => w.id)).toEqual(['w-1'])
    expect(read?.workspaces[0]).toMatchObject({ agents: 0, waiting: 0 })
  })

  it('a device card says what it is; anything else is not a kind', () => {
    const items = [{ id: 's-1', kind: 'browser', title: 'Screen', host: '', tint: '', initial: 'S', use: 'computer' }, { id: 'b-2', kind: 'browser', title: 'Page', use: 'rocket' }]
    expect(parseRemoteCards(answer({ cards: [card({ items })] }))?.cards[0]?.items.map((i) => i.use)).toEqual(['computer', undefined])
  })

  it('a tint is a colour or nothing: it is written into a style', () => {
    const items = [{ id: 'a', kind: 'browser', title: 'A', tint: 'url(https://x.io/b)' }, { id: 'b', kind: 'browser', title: 'B', tint: '#4a6' }]
    expect(parseRemoteCards(answer({ cards: [card({ items })] }))?.cards[0]?.items.map((i) => i.tint)).toEqual(['', '#4a6'])
  })

  it('a menu comes with its id and rows, or not at all', () => {
    const choice = { id: 'm-1', kind: 'menu', question: 'Allow?', sub: null, options: [{ key: '1', label: 'Yes', detail: null }], cursor: 0, escIndex: null }
    expect(parseRemoteCards(answer({ cards: [card({ choice })] }))?.cards[0]?.choice).toMatchObject({ id: 'm-1', options: [{ label: 'Yes' }] })
    expect(parseRemoteCards(answer({ cards: [card({ choice: { ...choice, options: 'no' } })] }))?.cards[0]?.choice).toBeNull()
  })

  it('not an answer at all is null', () => {
    for (const body of [null, 'x', [], { cards: 'no' }, { cards: [], workspaces: 3 }]) expect(parseRemoteCards(body)).toBeNull()
  })
})

describe('remoteAgentView', () => {
  it('is the zoom card’s own view: status, word, latest words in full', () => {
    const view = remoteAgentView(parseRemoteCards(answer())!.cards[0]!)
    expect(view).toMatchObject({ id: 't-1', name: 'Herdr Env', preset: 'claude', status: 'waiting', word: 'needs you', browsers: 1, notes: 0, line: 'Box tests' })
    expect(view.turn?.latest).toEqual({ text: 'All checks pass.', tone: 'done', full: 'All checks pass.\nThe GPU lane is next.' })
    expect(view.turn?.title).toBe('Box tests')
  })

  it('no words: no latest, the line falls back on what it is about', () => {
    const view = remoteAgentView(parseRemoteCards(answer({ cards: [card({ words: null, status: 'idle', word: 'resting' })] }))!.cards[0]!)
    expect(view.turn?.latest).toBeNull()
    expect(view.status).toBe('idle')
  })
})

describe('tileView', () => {
  it('a workspace tile in the zoom’s own form, faces for its agents', () => {
    const tile = parseRemoteCards(answer())!.workspaces[0]!
    expect(tileView(tile)).toMatchObject({ id: 'w-1', name: 'Box Lab', waiting: true, waitingCount: 1, browsers: null, notes: null, deck: [] })
    expect(tileView(tile).presets).toHaveLength(3)
  })
})

describe('crumbsOf', () => {
  it('always says whose it is', () => {
    expect(crumbsOf({ name: 'Solis-Core' }, null, null, null).map((c) => c.label)).toEqual(['Devices', 'Solis-Core'])
    const deep = crumbsOf({ name: 'Solis-Core' }, { id: 'w-1', name: 'Box Lab' }, { id: 't-1', name: 'Herdr Env' }, { id: 'b-1', title: 'Box' })
    expect(deep.map((c) => c.label)).toEqual(['Devices', 'Solis-Core', 'Box Lab', 'Herdr Env', 'Box'])
    expect(deep.map((c) => c.depth)).toEqual([0, 1, 2, 3, 4])
    expect(deep.filter((c) => c.remote).map((c) => c.label)).toEqual(['Solis-Core', 'Box Lab', 'Herdr Env', 'Box'])
  })
})

describe('sendRefusal', () => {
  it('says why words did not go, in the machine’s name; null when they went', () => {
    expect(sendRefusal({ status: 200, body: { ok: true } }, 'Solis-Core')).toBeNull()
    expect(sendRefusal({ status: 0, body: null }, 'Solis-Core')).toBe('Solis-Core isn’t answering. Your words are still here.')
    expect(sendRefusal({ status: 409, body: { error: 'A menu is up: answer it on the PC.' } }, 'Solis-Core')).toBe('A menu is up: answer it on the PC.')
    expect(sendRefusal({ status: 200, body: { ok: false, reason: 'moved' } }, 'Solis-Core')).toBe('The menu moved on. Nothing was sent.')
    expect(sendRefusal({ status: 500, body: null }, 'Solis-Core')).toBe('Solis-Core did not take that. Try again.')
  })
})

describe('what a card sends', () => {
  const menu = (options: { key: string; label: string; detail: null; role?: 'type' }[]) =>
    parseRemoteCards(answer({ cards: [card({ choice: { id: 'm-1', kind: 'menu', question: 'Allow?', sub: null, options, cursor: 0, escIndex: null } })] }))!.cards[0]!

  it('words go to the agent’s input; blank words go nowhere', () => {
    const plain = parseRemoteCards(answer({ cards: [card({ status: 'idle' })] }))!.cards[0]!
    expect(replyCall(plain, '  hello ')).toEqual({ route: 'api/terminal/t-1/input', body: { text: 'hello' } })
    expect(replyCall(plain, '   ')).toBeNull()
  })

  it('with a menu up, words go only into its row to type in, never as keys onto the cursor', () => {
    expect(replyCall(menu([{ key: '1', label: 'Yes', detail: null }]), 'no')).toBeNull()
    const typed = menu([{ key: '1', label: 'Yes', detail: null }, { key: '2', label: 'Type something', detail: null, role: 'type' }])
    expect(replyCall(typed, 'use main')).toEqual({ route: 'api/terminal/t-1/menu', body: { menu: 'm-1', brief: '', act: { kind: 'words', text: 'use main' } } })
  })

  it('a row is named with the menu it was on; a stop is the card’s own', () => {
    const shown = menu([{ key: '1', label: 'Yes', detail: null }])
    expect(menuCall(shown, shown.choice!, { kind: 'row', index: 0 })).toEqual({ route: 'api/terminal/t-1/menu', body: { menu: 'm-1', brief: '', act: { kind: 'row', index: 0 } } })
    expect(stopCall({ id: 'a/b' })).toEqual({ route: 'api/watch/card/a%2Fb/stop' })
  })
})

// ARTIFACTS ON THE BAR, INSIDE ANOTHER MACHINE (owner 2026-11-11): a workspace's browsers and notes,
// each once, with the agent it is opened under.
describe('artifactsOf', () => {
  it('each item once, the first agent that wears it, in crew order', () => {
    const read = parseRemoteCards(answer({ cards: [card(), card({ id: 't-2', name: 'Box Test', items: [{ id: 'b-1', kind: 'browser', title: 'Box', host: 'h', tint: '#456', initial: 'B' }, { id: 'n-1', kind: 'note', title: 'plan' }] })] }))!
    expect(artifactsOf(read.cards).map((a) => [a.item.id, a.card.id])).toEqual([['b-1', 't-1'], ['n-1', 't-2']])
    expect(artifactsOf([])).toEqual([])
  })
})
