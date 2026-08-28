import { describe, expect, it } from 'vitest'
import { derivedTeamName, uniqueTeamName } from '../src/shared/team-actions'
import type { WorkspaceState } from '../src/shared/model'

/**
 * SAVE ASKS NOTHING, AND MUST NOT DESTROY ANYTHING (R29).
 *
 * The gesture is the clipboard's — instant, private, no sheet. A name prompt is
 * a question, so the name is derived; but "asks nothing" must not quietly mean
 * "overwrote the one you saved yesterday", so a derived collision takes a
 * suffix rather than a confirmation. The author did not choose this name, so
 * they cannot be asked to defend it.
 */

const ws = (names: string[], name = 'Research'): WorkspaceState =>
  ({
    name,
    nodes: names.map((n, i) => ({ kind: 'terminal', id: `t${i}`, name: n })),
    connections: []
  }) as unknown as WorkspaceState

const ids = (n: number): string[] => Array.from({ length: n }, (_, i) => `t${i}`)

describe('the name a question-free save uses', () => {
  it('is the agent for one, and first +N for several — the demo\'s own chip', () => {
    expect(derivedTeamName(ws(['Scout']), ids(1))).toBe('Scout')
    expect(derivedTeamName(ws(['Scout', 'Digger', 'Librarian']), ids(3))).toBe('Scout +2')
  })

  it('names after the AGENTS, not the workspace', () => {
    // The workspace name is identical for every save made in it, so a second
    // save would collide with the first — and a collision is exactly the
    // question this derivation exists to avoid asking.
    expect(derivedTeamName(ws(['Scout', 'Digger'], 'Research'), ids(2))).not.toBe('Research')
  })

  it('falls back to the workspace only when nothing is nameable', () => {
    const notesOnly = { name: 'Research', nodes: [], connections: [] } as unknown as WorkspaceState
    expect(derivedTeamName(notesOnly, [])).toBe('Research')
  })

  it('ignores blank agent names rather than producing " +2"', () => {
    expect(derivedTeamName(ws(['', '  ', 'Editor']), ids(3))).toBe('Editor')
  })
})

describe('a derived collision takes a suffix, never a confirmation', () => {
  it('leaves an unused name alone', () => {
    expect(uniqueTeamName('Scout +2', ['Reviewer'])).toBe('Scout +2')
  })

  it('suffixes rather than overwriting', () => {
    expect(uniqueTeamName('Scout +2', ['Scout +2'])).toBe('Scout +2 2')
    expect(uniqueTeamName('Scout +2', ['Scout +2', 'Scout +2 2'])).toBe('Scout +2 3')
  })

  it('collides the way the STORE collides — by file slug, not by string', () => {
    // Team files are keyed by fileSlug, so "Kitchen Copy" and "kitchen-copy"
    // are the same file. A uniqueness check on the raw string would hand back a
    // name that still overwrites.
    expect(uniqueTeamName('Kitchen Copy', ['kitchen-copy'])).toBe('Kitchen Copy 2')
  })
})
