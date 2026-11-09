// #ARTIFACT IN THE PROMPT, AS @AGENT IS (owner, 2026-11-01).
import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { agentRefs, artifactRefs, cardCommand, expandRefs, pendingName, suggestionsFor, type PromptArtifact } from '../src/renderer/src/prompt/artifact-refs'

vi.mock('../src/renderer/src/api', () => ({ cookrew: () => ({ ptyInput: () => undefined }) }))
const { lineTextFor } = await import('../src/renderer/src/prompt/live-line')

const art = (name: string, kind: 'note' | 'browser' = 'note', owners: string[] = []): PromptArtifact => ({ id: name.toLowerCase().replace(/\s/g, '-'), name, kind, owners })
const ARTS = [art('Route plan'), art('Route'), art('localhost:5173', 'browser'), art('Retry notes')]

describe('artifactRefs', () => {
  it('finds a name with spaces in it, the longest that fits', () => {
    const refs = artifactRefs('read #Route plan, then fix it', ARTS)
    expect(refs.map((r) => [r.artifact.name, r.start, r.end])).toEqual([['Route plan', 5, 16]])
    expect(artifactRefs('#route only', ARTS).map((r) => r.artifact.name)).toEqual(['Route'])
  })

  it('needs the name whole, and a "#" at a word start', () => {
    expect(artifactRefs('#Routeplan', ARTS)).toEqual([])
    expect(artifactRefs('issue#Route', ARTS)).toEqual([])
    expect(artifactRefs('#42 is a bug', ARTS)).toEqual([])
  })

  it('finds several', () => {
    expect(artifactRefs('#Retry notes and #localhost:5173.', ARTS).map((r) => r.artifact.kind)).toEqual(['note', 'browser'])
  })
})

describe('expandRefs', () => {
  const AGENTS = [{ id: 'f1', name: 'Forge' }, { id: 'f2', name: 'Forge two' }]

  it('says each one as the command that reaches it (owner, 2026-11-09)', () => {
    const text = 'compare #Route plan with #localhost:5173'
    expect(expandRefs(text, artifactRefs(text, ARTS))).toBe('compare cookrew note "Route plan" with cookrew browser "localhost:5173"')
  })

  it('says a teammate named among the words as the ask that reaches them', () => {
    const text = 'put #Route plan in front of @Forge two, then @forge.'
    expect(agentRefs(text, AGENTS).map((r) => r.agent.id)).toEqual(['f2', 'f1'])
    expect(expandRefs(text, artifactRefs(text, ARTS), agentRefs(text, AGENTS))).toBe(
      'put cookrew note "Route plan" in front of cookrew ask "Forge two", then cookrew ask "Forge".'
    )
    expect(agentRefs('mail me@Forge', AGENTS)).toEqual([])
  })

  it('says a name inside another name once', () => {
    const notes = [art('ping @Forge')]
    const text = 'read #ping @Forge'
    expect(expandRefs(text, artifactRefs(text, notes), agentRefs(text, AGENTS))).toBe('read cookrew note "ping @Forge"')
  })

  it('quotes a name the shell would read into', () => {
    expect(cardCommand('note', 'cost $5')).toBe(`cookrew note 'cost $5'`)
    expect(cardCommand('note', `it's "done"`)).toBe(`cookrew note 'it'\\''s "done"'`)
    expect(cardCommand('ask', 'Forge')).toBe('cookrew ask "Forge"')
  })
})

describe('pendingName', () => {
  const names = { '@': ['Forge', 'Fresco'], '#': ARTS.map((a) => a.name) }
  it('a "#" or "@" on its way to a name', () => {
    expect(pendingName('look at #Ro', names)).toEqual({ sigil: '#', start: 8, query: 'Ro' })
    expect(pendingName('look at #Route p', names)).toEqual({ sigil: '#', start: 8, query: 'Route p' })
    expect(pendingName('@Fr', names)).toEqual({ sigil: '@', start: 0, query: 'Fr' })
    expect(pendingName('#', names)).toEqual({ sigil: '#', start: 0, query: '' })
  })

  it('nothing once the name is whole and a space follows, or when nothing could match', () => {
    expect(pendingName('look at #Route plan ', names)).toBeNull()
    expect(pendingName('#zzz', names)).toBeNull()
    expect(pendingName('mail me@Fr', names)).toBeNull()
  })

  it('one word typed also matches inside a name', () => {
    expect(pendingName('#plan', names)?.query).toBe('plan')
    expect(suggestionsFor('plan', ARTS).map((a) => a.name)).toEqual(['Route plan'])
    expect(suggestionsFor('ro', ARTS).map((a) => a.name)).toEqual(['Route plan', 'Route'])
  })
})

describe("the agent's line", () => {
  it('takes a whole reference as what it is, and waits for one being typed', () => {
    expect(lineTextFor('read #Route plan now', 'a1', null, [], ARTS)).toBe('read cookrew note "Route plan" now')
    expect(lineTextFor('read #Rou', 'a1', null, [], ARTS)).toBe('read ')
    // Never a raw "#" at the line's start: Claude Code reads one as its own command.
    expect(lineTextFor('#Ret', 'a1', null, [], ARTS)).toBe('')
  })
})

describe('the box', () => {
  const box = readFileSync('src/renderer/src/prompt/GlobalPrompt.tsx', 'utf8')
  it('sends a reference as what it is and wires it to the agent it goes to', () => {
    expect(box).toMatch(/submitLine\(plan\.id, out\.words\.trim\(\) \? out\.words : ''\)\s+wireRefs\(plan\.id, out\.refs\)/)
    expect(box).toMatch(/sendToAgent\(plan\.id, out\.words\)\s+wireRefs\(plan\.id, out\.refs\)/)
    expect(box).toMatch(/if \(made\.id\) \{\s+wireRefs\(made\.id, refs\)/)
    expect(box).toMatch(/artifact\.owners\.includes\(agentId\)\) continue/)
  })

  it('offers the names while "@" or "#" is typed, picked with the arrows and Enter or Tab', () => {
    expect(box).toMatch(/role="listbox"/)
    expect(box).toMatch(/e\.key === 'Enter' \|\| e\.key === 'Tab'/)
  })
})
