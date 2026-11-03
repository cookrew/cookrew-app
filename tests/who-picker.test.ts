// THE WHO-PICKER'S KEYS AND FILTER (design cut "Who-picker keyboard & filter",
// 2026-11-04): a 'Send to…' field at the list's top filters agents and
// harnesses by name; ↑ ↓ move, ⏎ picks, Esc closes. Pure rules here; the
// markup contract below.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { describe, expect, it } from 'vitest'
import { pickerRows, usersInView } from '../src/renderer/src/prompt/item-user'
import { agentKey, newKey, revealAt, whoFilter, whoKeys, whoMatch, whoStart, whoStep } from '../src/renderer/src/prompt/who-keys'
import { WhoPicker } from '../src/renderer/src/prompt/WhoPicker'
import type { FaceAgent } from '../src/renderer/src/prompt/PromptFace'

const read = (...p: string[]): string => readFileSync(join(__dirname, '../src/renderer/src', ...p), 'utf8')

describe('a name answers what was typed', () => {
  it('best at its start, then at a word, then inside it', () => {
    expect(whoMatch('Conductor', 'co')).toBe(0)
    expect(whoMatch('Rename Anyone', 'any')).toBe(1)
    expect(whoMatch('手机 inputbox 优化', 'inputbox')).toBe(1)
    expect(whoMatch('Fresco', 'co')).toBe(2)
    expect(whoMatch('交互优化', '优化')).toBe(2)
  })
  it('in any case, the typed spaces at its ends left out', () => {
    expect(whoMatch('CODEX', 'cod')).toBe(0)
    expect(whoMatch('codex', '  Cod ')).toBe(0)
  })
  it('nothing typed answers every name; a name without the words answers nothing', () => {
    expect(whoMatch('Velvet', '')).toBe(0)
    expect(whoMatch('Velvet', 'xyz')).toBeNull()
  })
})

describe('the filter', () => {
  it('keeps the rows that answer, best first, their order kept among equals', () => {
    const names = ['Fresco', 'Conductor', 'Velvet', 'Codex']
    expect(whoFilter(names, 'co', (n) => n)).toEqual(['Conductor', 'Codex', 'Fresco'])
  })
  it('nothing typed keeps every row in its order', () => {
    expect(whoFilter(['b', 'a'], '', (n) => n)).toEqual(['b', 'a'])
  })
})

describe('the who-picker rows', () => {
  const r = (id: string, status: string, at: number) => ({ id, name: id, status, lastActivityAt: at })
  const rows = [r('w', 'waiting', 1), r('x', 'idle', 50), r('y', 'working', 90), r('z', 'idle', 70), r('cur', 'idle', 99)]
  it('shows the one in the box where it stands (the design marks it there)', () => {
    expect(pickerRows(rows, { current: 'cur', recent: 2 }).recent.map((a) => a.id)).toEqual(['cur', 'y'])
  })
  it('keeps the one in the box in the recent row even when it is not among the latest', () => {
    expect(pickerRows(rows, { current: 'x', recent: 2 }).recent.map((a) => a.id)).toEqual(['cur', 'x'])
  })
  it('a typed name searches every agent, past the recent few', () => {
    expect(pickerRows(rows, { current: 'cur', recent: 1, query: 'x' }).recent.map((a) => a.id)).toEqual(['x'])
    expect(pickerRows(rows, { current: 'cur', query: 'w' }).waiting.map((a) => a.id)).toEqual(['w'])
    expect(pickerRows(rows, { current: 'cur', query: 'w' }).recent).toEqual([])
  })
})

describe('the users of the items in view lead the recent row', () => {
  const artifacts = [
    { id: 'n1', owners: ['a', 'b'] },
    { id: 'n2', owners: ['b', 'c'] },
    { id: 'n3', owners: [] }
  ]
  it("a browser's or a note's full view: its own users", () => {
    expect(usersInView({ dir: 'items', v: 1, full: 'item', item: 'n2', artifacts })).toEqual(['b', 'c'])
  })
  it('the artifacts stop: the users of every item there, once each', () => {
    expect(usersInView({ dir: 'items', v: 0, full: null, item: 'n2', artifacts })).toEqual(['a', 'b', 'c'])
  })
  it('nobody on the agents side, nor at the devices and workspaces stops', () => {
    expect(usersInView({ dir: 'agents', v: 1, full: null, item: 'n2', artifacts })).toEqual([])
    expect(usersInView({ dir: 'items', v: -1, full: null, item: null, artifacts })).toEqual([])
    expect(usersInView({ dir: 'items', v: -2, full: null, item: null, artifacts })).toEqual([])
  })
  it('and pickerRows puts them first', () => {
    const r = (id: string, at: number) => ({ id, name: id, status: 'idle', lastActivityAt: at })
    const first = usersInView({ dir: 'items', v: 0, full: null, item: null, artifacts })
    expect(pickerRows([r('a', 1), r('z', 99), r('c', 5)], { current: null, first, recent: 3 }).recent.map((a) => a.id)).toEqual(['c', 'a', 'z'])
  })
})

describe('↑ ↓ move through one order', () => {
  const lists = { waiting: [{ id: 'w' }], recent: [{ id: 'cur' }, { id: 'y' }] }
  const keys = whoKeys(lists, ['claude', 'codex'])
  it('who waits, then the recent, then a new agent on each harness', () => {
    expect(keys).toEqual([agentKey('w'), agentKey('cur'), agentKey('y'), newKey('claude'), newKey('codex')])
  })
  it('starts on the first row that is not already in the box', () => {
    expect(whoStart(keys, agentKey('w'))).toBe(agentKey('cur'))
    expect(whoStart(keys, agentKey('y'))).toBe(agentKey('w'))
    expect(whoStart([agentKey('cur')], agentKey('cur'))).toBe(agentKey('cur'))
    expect(whoStart([], null)).toBeNull()
  })
  it('steps one row, round from the ends', () => {
    expect(whoStep(keys, agentKey('w'), 1)).toBe(agentKey('cur'))
    expect(whoStep(keys, newKey('codex'), 1)).toBe(agentKey('w'))
    expect(whoStep(keys, agentKey('w'), -1)).toBe(newKey('codex'))
    expect(whoStep(keys, null, 1)).toBe(agentKey('w'))
    expect(whoStep(keys, 'gone', -1)).toBe(newKey('codex'))
    expect(whoStep([], null, 1)).toBeNull()
  })
})

describe('the row moved to is scrolled into view, the least it takes', () => {
  it('stays put when the row already shows', () => {
    expect(revealAt(100, 200, 150, 38)).toBe(100)
  })
  it('brings a row above up to the top, a row below down to the foot', () => {
    expect(revealAt(100, 200, 40, 38)).toBe(40)
    expect(revealAt(100, 200, 290, 38)).toBe(128)
  })
})

describe('the markup contract', () => {
  const face = (id: string, status: FaceAgent['status'] = 'idle') => ({ id, name: id === 'cur' ? 'Conductor' : id, preset: 'claude', orch: false, status, lastActivityAt: 1 })
  const html = renderToStaticMarkup(
    createElement(WhoPicker, {
      rows: [face('cur'), face('w', 'waiting'), face('velvet')],
      first: [],
      recentTitle: 'recent',
      harnesses: ['claude', 'codex'],
      current: { id: 'cur', harness: 'claude' },
      onAgent: () => undefined,
      onNew: () => undefined,
      onClose: () => undefined
    })
  )
  const listbox = html.slice(html.indexOf('role="listbox"'))
  it("a 'Send to…' field at the top is the combobox over the list", () => {
    expect(html).toMatch(/<input[^>]*role="combobox"[^>]*>/)
    expect(html).toMatch(/placeholder="Send to…"/)
    expect(html).toMatch(/aria-activedescendant="[^"]+"/)
    expect(html.indexOf('role="combobox"')).toBeLessThan(html.indexOf('role="listbox"'))
  })
  it('one listbox, its groups labelled, no heading inside it', () => {
    expect(html.match(/role="listbox"/g)).toHaveLength(1)
    expect(listbox).not.toMatch(/<h[1-6]/)
    expect(listbox).toMatch(/role="group" aria-label="needs you"/)
  })
  it('the rows are options out of the tab order; the one in the box is marked current', () => {
    expect(listbox).toMatch(/role="option"[^>]*tabindex="-1"|tabindex="-1"[^>]*role="option"/)
    expect(listbox).toMatch(/aria-current="true"[^>]*>[\s\S]*?Conductor/)
  })
  it("the zoom's Esc lets the picker's field close the picker, over an open shelf card too", () => {
    expect(read('zoom', 'ZoomView.tsx')).toMatch(/closest\?\.\('\.cmd, \.cr-board-search, \.cr-board-pop, \.cr-name-input, \.pf-who'\)/)
  })
})
