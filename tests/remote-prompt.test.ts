import { describe, expect, it } from 'vitest'
import { parseRemoteCards, type RemoteCard } from '../src/renderer/src/zoom/remote-machine'
import type { RemotePlace } from '../src/renderer/src/zoom/remote-machine-store'
import { remoteBoxCall, remoteBoxDraftKey, remoteBoxPlaceholder, remoteBoxShut, remoteBoxTarget } from '../src/renderer/src/zoom/remote-prompt'

/**
 * THE BAR'S BOX INSIDE ANOTHER MACHINE (owner 2026-11-12): the one box at the
 * bar's end talks to that machine, as this machine's box talks to this one.
 * No box of its own on the stage.
 */

const SOLIS = { id: 'solis', name: 'Solis-Core', os: 'linux' }
const OUT: RemotePlace = { machine: null, workspace: null, agent: null, item: null, side: 'agents' }
const at = (over: Partial<RemotePlace>): RemotePlace => ({ ...OUT, machine: SOLIS, ...over })

const cardsOf = (...cards: Record<string, unknown>[]): readonly RemoteCard[] =>
  parseRemoteCards({
    workspaces: [],
    cards: cards.map((over) => ({ id: 't-1', name: 'Herdr Env', preset: 'claude', status: 'idle', workspace: { id: 'w-1', name: 'Box Lab' }, choice: null, items: [], ...over }))
  })!.cards

const menu = (rows: { key: string; label: string; role?: 'type' }[]) => ({ id: 'm-1', kind: 'menu', question: 'Allow?', sub: null, options: rows.map((r) => ({ detail: null, ...r })), cursor: 0, escIndex: null })

describe('who the box talks to inside another machine', () => {
  it('outside every machine: nobody (this machine’s own box is in the bar then)', () => {
    expect(remoteBoxTarget(OUT, null, null)).toEqual({ kind: 'none' })
  })

  it('in a workspace: a new agent there; at its workspaces: one in the workspace in front there', () => {
    const ws = { id: 'w-1', name: 'Box Lab' }
    expect(remoteBoxTarget(at({ workspace: ws }), null, [])).toEqual({ kind: 'new', workspace: ws })
    expect(remoteBoxTarget(at({}), { id: 'w-2', name: 'Infra' }, null)).toEqual({ kind: 'new', workspace: { id: 'w-2', name: 'Infra' } })
    // Nothing read yet, nothing in front: the box waits.
    expect(remoteBoxTarget(at({}), null, null)).toEqual({ kind: 'none' })
  })

  it('an agent’s card open, or one of its items: that agent, as last read', () => {
    const cards = cardsOf({})
    const place = at({ workspace: { id: 'w-1', name: 'Box Lab' }, agent: { id: 't-1', name: 'Herdr Env' } })
    expect(remoteBoxTarget(place, null, cards)).toMatchObject({ kind: 'agent', card: { id: 't-1' } })
    expect(remoteBoxTarget({ ...place, item: { id: 'b-1', title: 'Box', kind: 'browser' } }, null, cards)).toMatchObject({ kind: 'agent', card: { id: 't-1' } })
    // Its card not read (yet, or no longer there): nobody, never a new agent by mistake.
    expect(remoteBoxTarget(place, null, [])).toEqual({ kind: 'none' })
  })

  it('keeps the words typed before by the same keys the stage’s boxes used', () => {
    expect(remoteBoxDraftKey({ kind: 'new', workspace: { id: 'w-1', name: 'Box Lab' } })).toBe('new:w-1')
    expect(remoteBoxDraftKey({ kind: 'agent', card: cardsOf({})[0]! })).toBe('t-1')
    expect(remoteBoxDraftKey({ kind: 'none' })).toBeNull()
  })
})

describe('what the words do there', () => {
  it('a new agent is started in that workspace on that machine', () => {
    expect(remoteBoxCall({ kind: 'new', workspace: { id: 'w 1', name: 'Box Lab' } }, '  fix the build ')).toEqual({ route: 'api/watch/new?seat=w%201', body: { text: 'fix the build' } })
    expect(remoteBoxCall({ kind: 'new', workspace: { id: 'w-1', name: 'Box Lab' } }, '   ')).toBeNull()
  })

  it('an agent gets them on its input; with a menu up, only through its row for words', () => {
    const plain = { kind: 'agent', card: cardsOf({})[0]! } as const
    expect(remoteBoxCall(plain, 'hello')).toEqual({ route: 'api/terminal/t-1/input', body: { text: 'hello' } })
    const shut = { kind: 'agent', card: cardsOf({ status: 'waiting', choice: menu([{ key: '1', label: 'Yes' }]) })[0]! } as const
    expect(remoteBoxShut(shut)).toBe(true)
    expect(remoteBoxCall(shut, 'no')).toBeNull()
    const typed = { kind: 'agent', card: cardsOf({ status: 'waiting', choice: menu([{ key: '1', label: 'Yes' }, { key: '2', label: 'Type', role: 'type' }]) })[0]! } as const
    expect(remoteBoxShut(typed)).toBe(false)
    expect(remoteBoxCall(typed, 'use main')).toMatchObject({ route: 'api/terminal/t-1/menu', body: { act: { kind: 'words', text: 'use main' } } })
    expect(remoteBoxCall({ kind: 'none' }, 'hello')).toBeNull()
  })

  it('says where the words go, naming the machine', () => {
    expect(remoteBoxPlaceholder({ kind: 'new', workspace: { id: 'w-1', name: 'Box Lab' } }, 'Solis-Core')).toBe('Start a new agent in Box Lab on Solis-Core…')
    expect(remoteBoxPlaceholder({ kind: 'agent', card: cardsOf({})[0]! }, 'Solis-Core')).toBe('Reply to Herdr Env on Solis-Core…')
    expect(remoteBoxPlaceholder({ kind: 'agent', card: cardsOf({ status: 'waiting', choice: menu([{ key: '1', label: 'Yes' }]) })[0]! }, 'Solis-Core')).toBe('Answer Herdr Env’s menu on the card first')
  })
})
