import { describe, expect, it } from 'vitest'
import type { CanvasNode, Connection } from '../src/shared/model'
import { attachmentIndex, sameAttachmentIndex, stripItems } from '../src/renderer/src/terminal-attachments'

const term = (id: string): CanvasNode => ({ kind: 'terminal', id, name: id, preset: 'Shell', command: '', cwd: '~', orch: false, role: null, position: { x: 0, y: 0 }, size: { width: 100, height: 100 } })
const note = (id: string, content = ''): CanvasNode => ({ kind: 'note', id, name: id, customName: null, content, locked: false, position: { x: 0, y: 0 }, size: { width: 100, height: 100 } })
const browser = (id: string, url = 'https://example.com'): CanvasNode => ({ kind: 'browser', id, name: id, url, position: { x: 0, y: 0 }, size: { width: 100, height: 100 } })
const wire = (a: string, b: string, i: number): Connection => ({ id: `c${i}`, a, b })

describe('attachmentIndex', () => {
  const nodes = [term('t1'), term('t2'), note('n1'), browser('b1'), browser('b2')]
  it('lists a terminal\'s wired browsers and notes, newest wire first, whichever end the terminal is on', () => {
    const idx = attachmentIndex(nodes, [wire('t1', 'n1', 1), wire('b1', 't1', 2), wire('t1', 'b2', 3)])
    expect(idx.get('t1')?.map((a) => `${a.kind}:${a.node.id}`)).toEqual(['browser:b2', 'browser:b1', 'note:n1'])
  })
  it('ignores terminal-to-terminal wires and wires to nodes that are gone', () => {
    const idx = attachmentIndex(nodes, [wire('t1', 't2', 1), wire('t1', 'ghost', 2)])
    expect(idx.get('t1')).toBeUndefined()
    expect(idx.get('t2')).toBeUndefined()
  })
  it('a shared note shows on every terminal it is wired to, once each', () => {
    const idx = attachmentIndex(nodes, [wire('t1', 'n1', 1), wire('t2', 'n1', 2), wire('n1', 't1', 3)])
    expect(idx.get('t1')?.map((a) => a.node.id)).toEqual(['n1'])
    expect(idx.get('t2')?.map((a) => a.node.id)).toEqual(['n1'])
  })
  it('stays the same while nothing a card shows changes, and differs when a note body or a url does', () => {
    const conns = [wire('t1', 'n1', 1), wire('t1', 'b1', 2)]
    const a = attachmentIndex(nodes, conns)
    const moved = nodes.map((n) => ({ ...n, position: { x: 50, y: 50 } }))
    expect(sameAttachmentIndex(a, attachmentIndex(moved, conns))).toBe(true)
    expect(sameAttachmentIndex(a, attachmentIndex([...nodes.filter((n) => n.id !== 'n1'), note('n1', 'edited')], conns))).toBe(false)
    expect(sameAttachmentIndex(a, attachmentIndex([...nodes.filter((n) => n.id !== 'b1'), browser('b1', 'https://other.example')], conns))).toBe(false)
  })
})

describe('stripItems', () => {
  const many = attachmentIndex(
    [term('t1'), ...Array.from({ length: 12 }, (_, i) => browser(`b${i}`, `https://site${i}.example`))],
    Array.from({ length: 12 }, (_, i) => wire('t1', `b${i}`, i))
  ).get('t1')!
  it('folds past the limit and counts what is hidden', () => {
    const { shown, hidden } = stripItems(many, null, null)
    expect(shown.map((a) => a.node.id)).toEqual(['b11', 'b10', 'b9', 'b8', 'b7', 'b6', 'b5', 'b4'])
    expect(hidden).toBe(4)
  })
  it('an open item behind the fold still shows', () => {
    const { shown, hidden } = stripItems(many, 'b0', null)
    expect(shown.map((a) => a.node.id)).toContain('b0')
    expect(shown).toHaveLength(8)
    expect(hidden).toBe(4)
  })
  it('a query shows every match, by name or address', () => {
    expect(stripItems(many, null, '').shown).toHaveLength(12)
    expect(stripItems(many, null, 'site3').shown.map((a) => a.node.id)).toEqual(['b3'])
  })
})
