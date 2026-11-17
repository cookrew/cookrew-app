// BACK FROM A FULL VIEW GOES WHERE YOU CAME FROM (owner, 2026-11-17): an
// agent's or an artifact's full view opened from a bar group, a pet, a toast
// or the other kind's full view returns there, not to its own card or
// thumbnails; agent ↔ artifact unwinds the way it was walked
// (renderer zoom/full-return.ts, zoom-store.ts · back).
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bareWindow } from './support/memory-storage'
import {
  TRAIL_MAX,
  backFrom,
  fullOf,
  placeKind,
  placeWords,
  pruneTrail,
  pushReturn,
  restingSpot,
  type ZoomReturn,
  type ZoomSpot
} from '../src/renderer/src/zoom/full-return'
import type { NavEvent } from '../src/renderer/src/nav-events'
import { cardsSeenOf, goneCards } from '../src/renderer/src/zoom/full-back-cards'

const spot = (dir: ZoomSpot['dir'], v: number, agent: string | null = null, item: string | null = null): ZoomSpot => ({ dir, v, agent, item })
const CREW = spot('agents', 1)
const DEVICES = spot('agents', -2)
const CARD_A = spot('agents', 2, 'A')
const FULL_A = spot('agents', 3, 'A')
const FULL_X = spot('items', 1, null, 'X')
const THUMBS = spot('items', 0)

describe('the trail, pure', () => {
  it('names a full view by its side and focus, and nothing short of it', () => {
    expect(fullOf(FULL_A)).toEqual({ kind: 'agent', id: 'A' })
    expect(fullOf(FULL_X)).toEqual({ kind: 'item', id: 'X' })
    expect(fullOf(CARD_A)).toBeNull()
    expect(fullOf(THUMBS)).toBeNull()
  })

  it('remembers where a full view was opened from, never a full view opened from itself', () => {
    const one = pushReturn([], CREW, { kind: 'agent', id: 'A' })
    expect(one).toEqual([{ from: CREW, to: { kind: 'agent', id: 'A' } }])
    expect(pushReturn(one, FULL_A, { kind: 'agent', id: 'A' })).toBe(one)
  })

  it('keeps the newest TRAIL_MAX steps of a long walk', () => {
    let trail: readonly ZoomReturn[] = []
    for (let i = 0; i < TRAIL_MAX + 5; i += 1) trail = pushReturn(trail, spot('agents', 3, `a${i}`), { kind: 'agent', id: `a${i + 1}` })
    expect(trail).toHaveLength(TRAIL_MAX)
    expect(trail[TRAIL_MAX - 1].to.id).toBe(`a${TRAIL_MAX + 5}`)
  })

  it('goes back to the page the full view in view was opened from', () => {
    const trail = pushReturn(pushReturn([], DEVICES, { kind: 'agent', id: 'A' }), FULL_A, { kind: 'item', id: 'X' })
    expect(backFrom(trail, FULL_X)).toEqual({ to: FULL_A, trail: trail.slice(0, 1), previous: true })
    expect(backFrom(trail.slice(0, 1), FULL_A)).toEqual({ to: DEVICES, trail: [], previous: true })
  })

  it('is one stop out when the trail is not this full view’s, and forgets the stale trail', () => {
    const trail = pushReturn([], CREW, { kind: 'agent', id: 'B' })
    expect(backFrom(trail, FULL_A)).toEqual({ to: CARD_A, trail: [], previous: false })
    // One stop out keeps who holds the focus: the card or thumbnail folds back into its place.
    expect(backFrom([], FULL_X)).toEqual({ to: { ...THUMBS, item: 'X' }, trail: [], previous: false })
    expect(backFrom([], CARD_A)?.to).toEqual({ ...CREW, agent: 'A' })
    expect(backFrom([], spot('agents', -2))).toBeNull()
  })

  it('takes cards that are gone out: a gone agent’s card is its crew, a gone full view drops out of the walk', () => {
    const known = (_kind: string, id: string): boolean => id !== 'A'
    const fromCard = pushReturn([], CARD_A, { kind: 'agent', id: 'B' })
    expect(pruneTrail(fromCard, known)).toEqual([{ from: { ...CARD_A, v: 1 }, to: { kind: 'agent', id: 'B' } }])
    // crew → A → X: with A gone, back from X goes to the crew.
    const walk = pushReturn(pushReturn([], CREW, { kind: 'agent', id: 'A' }), FULL_A, { kind: 'item', id: 'X' })
    expect(pruneTrail(walk, known)).toEqual([{ from: CREW, to: { kind: 'item', id: 'X' } }])
    // Nothing gone: the same trail, so the store does not tell anyone.
    expect(pruneTrail(walk, () => true)).toBe(walk)
  })

  it('remembers a pinch’s in-between value as the stop it rests nearest, short of the full view', () => {
    expect(restingSpot(spot('agents', 2.7, 'A'))).toEqual(CARD_A)
    expect(restingSpot(spot('items', 0.8))).toEqual(THUMBS)
    expect(restingSpot(spot('agents', 0.4))).toEqual(CREW)
    expect(restingSpot(FULL_A)).toBe(FULL_A)
    expect(pushReturn([], spot('agents', 2.7, 'A'), { kind: 'agent', id: 'A' })[0].from).toEqual(CARD_A)
    expect(placeKind(spot('agents', 2.7, 'A'))).toBe('card')
    expect(placeKind(spot('items', 0.8))).toBe('artifacts')
  })

  it('names where back goes in the bar’s words, a full view by its name', () => {
    const names = (kind: string, id: string): string | null => (kind === 'agent' && id === 'A' ? 'Velvet' : kind === 'item' && id === 'X' ? 'Grafana' : null)
    expect(placeWords(DEVICES, names)).toBe('devices')
    expect(placeWords(spot('items', -1), names)).toBe('workspaces')
    expect(placeWords(CREW, names)).toBe('agents')
    expect(placeWords(CARD_A, names)).toBe('agents')
    expect(placeWords(THUMBS, names)).toBe('artifacts')
    expect(placeWords(FULL_A, names)).toBe('Velvet')
    expect(placeWords(FULL_X, names)).toBe('Grafana')
    expect(placeWords(spot('agents', 3, 'gone'), names)).toBe('agent')
    expect(placeWords(spot('items', 1, null, 'gone'), names)).toBe('artifact')
    expect(placeKind(spot('items', -0.4))).toBe('artifacts')
  })
})

describe('the zoom store', () => {
  let store: typeof import('../src/renderer/src/zoom/zoom-store').zoomStore
  let events: NavEvent[]

  beforeEach(async () => {
    vi.resetModules()
    const page = bareWindow('http://127.0.0.1:5173/')
    vi.stubGlobal('window', page)
    vi.stubGlobal('localStorage', page.localStorage)
    store = (await import('../src/renderer/src/zoom/zoom-store')).zoomStore
    const nav = await import('../src/renderer/src/nav-events')
    events = []
    nav.subscribeNav((e) => events.push(e))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  const at = (): Pick<ReturnType<typeof store.get>, 'dir' | 'v' | 'agent' | 'item' | 'full'> => {
    const { dir, v, agent, item, full } = store.get()
    return { dir, v, agent, item, full }
  }

  it('from the crew, a bar group’s agent full view goes back to the crew, its card folding there', () => {
    store.go(1, 'agents')
    store.jumpTo('agent', 'A')
    expect(store.back('button')).toBe(true)
    expect(at()).toMatchObject({ dir: 'agents', v: 1, agent: 'A' })
    expect(store.get().trail).toEqual([])
  })

  it('from the devices, an artifact’s full view goes back to the devices, zooming out on its own side', () => {
    store.go(-2, 'agents')
    store.jumpTo('item', 'X')
    const jump = store.get().jump
    store.back('esc')
    expect(at()).toMatchObject({ dir: 'items', v: -2 })
    expect(store.get().jump).toBe(jump)
  })

  it('agent → artifact → agent: each back is the full view before it, then where the walk began', () => {
    store.go(1, 'agents')
    store.focusAgent('A')
    store.go(2)
    store.go(3)
    store.jumpTo('item', 'X')
    store.jumpTo('agent', 'B')
    const j = store.get().jump
    store.back('button')
    expect(at()).toEqual({ dir: 'items', v: 1, agent: 'B', item: 'X', full: 'item' })
    expect(store.get().jump).toBe(j + 1)
    store.back('button')
    expect(at()).toEqual({ dir: 'agents', v: 3, agent: 'A', item: 'X', full: 'agent' })
    store.back('button')
    expect(at()).toMatchObject({ dir: 'agents', v: 2, agent: 'A' })
    // Off the full views it is one stop out again.
    store.back('button')
    expect(at()).toMatchObject({ dir: 'agents', v: 1 })
  })

  it('artifact → agent and back: the artifact, then its thumbnails', () => {
    store.go(0, 'items')
    store.focusItem('X')
    store.go(1, 'items')
    store.jumpTo('agent', 'A')
    store.back('system')
    expect(at()).toMatchObject({ dir: 'items', v: 1, item: 'X', full: 'item' })
    store.back('system')
    expect(at()).toMatchObject({ dir: 'items', v: 0 })
  })

  it('back and forth between the two: back walks it the way it went', () => {
    store.go(1, 'agents')
    store.jumpTo('agent', 'A')
    store.jumpTo('item', 'X')
    store.jumpTo('agent', 'A')
    store.back('button')
    expect(at()).toMatchObject({ dir: 'items', item: 'X', full: 'item' })
    store.back('button')
    expect(at()).toMatchObject({ dir: 'agents', v: 3, agent: 'A', full: 'agent' })
    store.back('button')
    expect(at()).toMatchObject({ dir: 'agents', v: 1 })
  })

  it('a full view left by a stop leaves no way back into it', () => {
    store.go(1, 'agents')
    store.jumpTo('agent', 'A')
    store.go(-1)
    expect(store.get().trail).toEqual([])
    store.jumpTo('card', 'B')
    store.go(3)
    store.back('button')
    expect(at()).toMatchObject({ dir: 'agents', v: 2, agent: 'B' })
  })

  it('another card taken into focus at its kind’s full view is a full view opened from this one', () => {
    store.go(-1, 'agents')
    store.jumpTo('item', 'X')
    // A bar group's second artifact, from the first one's full view (use-zoom-motion.ts · item: focus, then v 1 again).
    store.focusItem('Y')
    store.go(1, 'items')
    expect(at()).toMatchObject({ dir: 'items', v: 1, item: 'Y' })
    store.back('button')
    expect(at()).toMatchObject({ dir: 'items', v: 1, item: 'X', full: 'item' })
    store.back('button')
    expect(at()).toMatchObject({ v: -1 })
    expect(events.filter((e) => e.name === 'full_open')).toEqual([
      { name: 'full_open', kind: 'item', from: 'workspaces' },
      { name: 'full_open', kind: 'item', from: 'item-full' }
    ])
  })

  it('a focus that moves off a full view’s kind leaves its trail alone', () => {
    store.go(1, 'agents')
    store.jumpTo('agent', 'A')
    store.focusItem('X')
    store.back('button')
    expect(at()).toMatchObject({ dir: 'agents', v: 1, agent: 'A' })
  })

  it('names no way back once the target has left the full view, though the view is still on its way out', () => {
    store.go(1, 'agents')
    store.jumpTo('agent', 'A')
    expect(store.backTarget()).toMatchObject({ v: 1 })
    store.back('button')
    // `full` is the view's to clear when the eye gets there; the words go now.
    expect(store.get().full).toBe('agent')
    expect(store.backTarget()).toBeNull()
  })

  it('tells the counts after the view has moved, so a listener reads where it is', async () => {
    const nav = await import('../src/renderer/src/nav-events')
    const seen: (number | 'agent' | 'item' | null)[] = []
    nav.subscribeNav(() => seen.push(store.get().v, store.get().full))
    store.go(1, 'agents')
    store.jumpTo('agent', 'A')
    store.back('button')
    expect(seen).toEqual([3, 'agent', 1, 'agent'])
  })

  it('a gone agent’s full view drops out: back from the artifact opened from it goes where it was opened from', () => {
    store.go(-1, 'agents')
    store.jumpTo('agent', 'A')
    store.jumpTo('item', 'X')
    store.prune((_kind, id) => id !== 'A')
    expect(store.backTarget()).toMatchObject({ v: -1 })
    store.back('button')
    expect(at()).toMatchObject({ v: -1 })
  })

  it('says whether back would do anything, and where it goes', () => {
    store.go(-2, 'agents')
    expect(store.canBack()).toBe(false)
    expect(store.back('esc')).toBe(false)
    store.jumpTo('item', 'X')
    expect(store.canBack()).toBe(true)
    expect(store.backTarget()).toMatchObject({ v: -2 })
  })

  it('counts where full views open from, where back takes them, and how they are left', () => {
    store.go(2, 'agents')
    store.go(3)
    store.jumpTo('item', 'X')
    store.back('esc')
    store.go(1)
    expect(events).toEqual([
      { name: 'full_open', kind: 'agent', from: 'card' },
      { name: 'full_open', kind: 'item', from: 'agent-full' },
      { name: 'full_back', kind: 'item', to: 'agent-full', by: 'esc', previous: true },
      { name: 'full_leave', kind: 'agent', to: 'agents' }
    ])
  })

  it('counts no back off a full view, and no open of the full view already in view', () => {
    store.go(1, 'agents')
    store.back('button')
    store.jumpTo('agent', 'A')
    store.jumpTo('agent', 'A')
    expect(events).toEqual([{ name: 'full_open', kind: 'agent', from: 'workspaces' }])
  })

  it('forgets the trail with the machine it belongs to', () => {
    const source = readFileSync('src/renderer/src/zoom/zoom-store.ts', 'utf8')
    const scope = source.slice(source.indexOf("registerScopeState('zoom focus'"))
    expect(scope).toContain('trail: []')
  })
})

describe('the cards that were closed', () => {
  const nodes = (...ids: string[]) => ids.map((id) => ({ id }) as never)

  it('are the ones gone between two looks at the same workspace', () => {
    expect([...goneCards(cardsSeenOf('w1', nodes('A', 'B', 'X')), cardsSeenOf('w1', nodes('A', 'X')))]).toEqual(['B'])
  })

  it('are none on a switch, and none on the first look: another workspace’s card is not closed', () => {
    expect(goneCards(cardsSeenOf('w1', nodes('A', 'B')), cardsSeenOf('w2', nodes('C'))).size).toBe(0)
    expect(goneCards(null, cardsSeenOf('w1', nodes('A'))).size).toBe(0)
  })
})

describe('every way back from a full view takes the trail', () => {
  const read = (file: string): string => readFileSync(`src/renderer/src/${file}`, 'utf8')

  it('the bar’s ‹, Esc, the phone’s back and the background', () => {
    const view = read('zoom/ZoomView.tsx')
    expect(view).toContain("return zoomStore.back(by)")
    expect(view).toContain("onClick={() => stepBack('button')}")
    expect(view).toContain("takeBack(() => stepBack('esc'))")
    expect(view).toContain("takeBack(() => backSteps.current.stepBack('system'))")
    expect(view).toContain('zoomStore.canBack()')
    expect(view).not.toMatch(/\bstepOut\(z\.dir/)
  })

  it('the page’s own Back and ✕, the phone bar’s ‹, a remote screen’s end', () => {
    const stage = read('stage/StageView.tsx')
    expect(stage).toContain("zoomStore.back('pane')")
    // Landing on another full view keeps its card on the stage.
    expect(stage).toContain('if (zoomStore.get().full === null) stageSelect.clear()')
    expect(read('HeaderRoute.tsx')).toContain("zoomStore.back('route')")
    expect(read('MobileBrowserFrame.tsx')).toContain("zoomStore.back('pane')")
  })
})
