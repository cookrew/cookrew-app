import { describe, expect, it } from 'vitest'
import { sameFields, sameProps } from '../src/renderer/src/zoom/same-props'

describe('sameProps (the zoom nodes skip a render only when nothing they draw changed)', () => {
  const view = (over: Record<string, unknown> = {}) => ({ id: 'a', name: 'Forge', owners: ['t1', 't2'], turn: null, ...over })
  const onOpen = () => undefined

  it('a rebuilt view with the same fields is the same', () => {
    expect(sameProps({ agent: view(), card: true, onOpen }, { agent: view(), card: true, onOpen })).toBe(true)
  })

  it('any field, any array element, any other prop or a new handler is a change', () => {
    expect(sameProps({ agent: view() }, { agent: view({ name: 'Forge2' }) })).toBe(false)
    expect(sameProps({ agent: view() }, { agent: view({ owners: ['t1'] }) })).toBe(false)
    expect(sameProps({ agent: view() }, { agent: view({ owners: ['t2', 't1'] }) })).toBe(false)
    expect(sameProps({ agent: view(), card: true }, { agent: view(), card: false })).toBe(false)
    expect(sameProps({ agent: view(), onOpen }, { agent: view(), onOpen: () => undefined })).toBe(false)
    expect(sameProps({ agent: view() }, { agent: view(), extra: 1 } as { agent: ReturnType<typeof view> })).toBe(false)
  })

  it('nested objects compare by identity (a turn is the row cache\'s own object)', () => {
    const turn = { title: 't' }
    expect(sameFields(view({ turn }), view({ turn }))).toBe(true)
    expect(sameFields(view({ turn }), view({ turn: { title: 't' } }))).toBe(false)
  })
})

describe('the zoom scene hands its memoised nodes stable handlers', () => {
  it('every node handler comes from stable(key, …), never an inline arrow', async () => {
    const { readFileSync } = await import('node:fs')
    const view = readFileSync(new URL('../src/renderer/src/zoom/ZoomView.tsx', import.meta.url), 'utf8')
    const scene = view.slice(view.indexOf('{model.marks.map((m) => <MarkNode'), view.indexOf('The seat for the agent that is not there yet'))
    // The memoised nodes only: plain buttons and divs may take arrows.
    expect(scene).not.toMatch(/<(MarkNode|LinkNode|ItemNode|AgentNode) [^\n]*on(Open|OpenItems|Click|Delete)=\{\(\) =>/)
    expect(scene).not.toMatch(/\? \(\) => onDelete\(/)
    // Seven: a mark opens by its agents and by its browsers (2026-11-02).
    expect((scene.match(/stable\(`/g) ?? []).length).toBe(7)
  })
})
