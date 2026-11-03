import { describe, expect, it } from 'vitest'
import { matchSibling, shortId, siblingSlugs, slugify } from '../src/strata/url/slug'
import { formatStrataUrl, parseStrataUrl, resolveStrataUrl, type UrlMachine } from '../src/strata/url/strata-url'
import { ancestry, depthOf, planMove } from '../src/strata/url/history'

const node = (id: string, name: string) => ({ id, name })

const fleet: UrlMachine[] = [
  {
    id: 'm1',
    name: 'Studio',
    link: 'live',
    levels: {
      workspaces: [
        { id: 'w1', name: 'Monorepo', agents: [node('a1', 'Ada'), node('a2', 'Basil'), node('a3', 'Ada'), node('a4', 'Ada')] },
        { id: 'w2', name: 'Paper Notes', agents: [node('a5', 'Cleo')] }
      ]
    }
  },
  { id: 'm2', name: 'Studio', link: 'live', levels: { workspaces: [] } },
  { id: 'm3', name: 'account', link: 'live', levels: { workspaces: [] } },
  { id: 'm4', name: 'batch-pool', link: 'connecting', levels: null },
  { id: 'm5', name: 'old-thinkpad', link: 'offline', levels: null }
]

describe('slugify', () => {
  it('lower-cases, folds accents and joins words with dashes', () => {
    expect(slugify('Paper Notes')).toBe('paper-notes')
    expect(slugify('  Café — Déjà vu!! ')).toBe('cafe-deja-vu')
    expect(slugify('CI/Night_Shift 2')).toBe('ci-night-shift-2')
  })

  it('keeps letters of any script readable', () => {
    expect(slugify('Заметки Notes')).toBe('заметки-notes')
  })

  it('caps the length at 40 without a trailing dash, and never returns empty', () => {
    const slug = slugify('a'.repeat(39) + ' bcd')
    expect(slug.length).toBeLessThanOrEqual(40)
    expect(slug.endsWith('-')).toBe(false)
    expect(slugify('!!!')).toBe('x')
    expect(slugify('')).toBe('x')
  })
})

describe('sibling slugs', () => {
  it('keeps the bare slug when names are unique', () => {
    const slugs = siblingSlugs([node('w1', 'Monorepo'), node('w2', 'Paper Notes')])
    expect(slugs.get('w1')).toBe('monorepo')
    expect(slugs.get('w2')).toBe('paper-notes')
  })

  it('gives later namesakes a short id suffix; the oldest keeps the bare slug', () => {
    const slugs = siblingSlugs(fleet[0].levels!.workspaces[0].agents)
    expect(slugs.get('a1')).toBe('ada')
    expect(slugs.get('a3')).toBe(`ada-${shortId('a3')}`)
    expect(slugs.get('a4')).toBe(`ada-${shortId('a4')}`)
    expect(new Set(slugs.values()).size).toBe(4)
  })

  it('lengthens the suffix when a name already looks like a suffixed slug', () => {
    const tricky = [node('x1', 'Ada'), node('x2', 'Ada'), node('x3', `ada-${shortId('x2')}`)]
    const slugs = siblingSlugs(tricky)
    expect(new Set(slugs.values()).size).toBe(3)
    expect(slugs.get('x3')).toBe(`ada-${shortId('x2')}`)
  })

  it('never hands out a reserved slug', () => {
    const slugs = siblingSlugs([node('m3', 'Account')], new Set(['account']))
    expect(slugs.get('m3')).toBe(`account-${shortId('m3')}`)
  })

  it('is deterministic', () => {
    const list = fleet[0].levels!.workspaces[0].agents
    expect([...siblingSlugs(list)]).toEqual([...siblingSlugs(list)])
  })

  it('short ids are short, lower-case base36 and stable', () => {
    expect(shortId('a3')).toMatch(/^[0-9a-z]{4}$/)
    expect(shortId('a3')).toBe(shortId('a3'))
    expect(shortId('a3', 8)).toMatch(/^[0-9a-z]{8}$/)
  })
})

describe('matchSibling', () => {
  const agents = fleet[0].levels!.workspaces[0].agents

  it('finds the formatted slug', () => {
    expect(matchSibling(agents, `ada-${shortId('a3')}`)?.id).toBe('a3')
    expect(matchSibling(agents, 'basil')?.id).toBe('a2')
  })

  it('takes a bare namesake to the oldest one', () => {
    expect(matchSibling(agents, 'ada')?.id).toBe('a1')
    expect(matchSibling(agents, 'ADA')?.id).toBe('a1')
  })

  it('survives a rename through the id suffix', () => {
    const renamed = agents.map((a) => (a.id === 'a3' ? { ...a, name: 'Ava' } : a))
    expect(matchSibling(renamed, `ada-${shortId('a3')}`)?.id).toBe('a3')
  })

  it('returns null for an unknown slug', () => {
    expect(matchSibling(agents, 'nobody')).toBeNull()
  })
})

describe('parseStrataUrl', () => {
  it('reads the four levels', () => {
    expect(parseStrataUrl('/me')).toEqual({ kind: 'levels', slugs: [] })
    expect(parseStrataUrl('/me/')).toEqual({ kind: 'levels', slugs: [] })
    expect(parseStrataUrl('/me/studio')).toEqual({ kind: 'levels', slugs: ['studio'] })
    expect(parseStrataUrl('/me/studio/monorepo/ada')).toEqual({ kind: 'levels', slugs: ['studio', 'monorepo', 'ada'] })
  })

  it('decodes percent-encoded slugs', () => {
    expect(parseStrataUrl(`/me/${encodeURIComponent('Заметки')}`)).toEqual({ kind: 'levels', slugs: ['Заметки'] })
  })

  it('keeps /me/account for the account page and ignores other paths', () => {
    expect(parseStrataUrl('/me/account')).toEqual({ kind: 'reserved', name: 'account' })
    expect(parseStrataUrl('/pricing')).toEqual({ kind: 'other' })
    expect(parseStrataUrl('/meadow')).toEqual({ kind: 'other' })
  })

  it('drops segments past the agent', () => {
    expect(parseStrataUrl('/me/a/b/c/d/e')).toEqual({ kind: 'levels', slugs: ['a', 'b', 'c'] })
  })

  it('survives a malformed escape', () => {
    expect(parseStrataUrl('/me/%E0%A4%A')).toEqual({ kind: 'levels', slugs: ['%E0%A4%A'] })
  })
})

describe('formatStrataUrl', () => {
  it('formats each level with readable slugs', () => {
    expect(formatStrataUrl({}, fleet)).toBe('/me')
    expect(formatStrataUrl({ machine: 'm1' }, fleet)).toBe('/me/studio')
    expect(formatStrataUrl({ machine: 'm1', workspace: 'w2' }, fleet)).toBe('/me/studio/paper-notes')
    expect(formatStrataUrl({ machine: 'm1', workspace: 'w1', agent: 'a2' }, fleet)).toBe('/me/studio/monorepo/basil')
  })

  it('suffixes colliding machines and the reserved "account"', () => {
    expect(formatStrataUrl({ machine: 'm2' }, fleet)).toBe(`/me/studio-${shortId('m2')}`)
    expect(formatStrataUrl({ machine: 'm3' }, fleet)).toBe(`/me/account-${shortId('m3')}`)
  })

  it('percent-encodes non-ASCII slugs', () => {
    const intl: UrlMachine[] = [{ id: 'k', name: 'Заметки', link: 'live', levels: { workspaces: [] } }]
    expect(formatStrataUrl({ machine: 'k' }, intl)).toBe(`/me/${encodeURIComponent('заметки')}`)
  })

  it('stops at the deepest part it can name', () => {
    expect(formatStrataUrl({ machine: 'm1', workspace: 'nope', agent: 'a1' }, fleet)).toBe('/me/studio')
    expect(formatStrataUrl({ machine: 'nope' }, fleet)).toBe('/me')
  })

  it('round-trips every agent through parse and resolve', () => {
    for (const m of fleet) {
      for (const w of m.levels?.workspaces ?? []) {
        for (const a of w.agents) {
          const path = { machine: m.id, workspace: w.id, agent: a.id }
          const parsed = parseStrataUrl(formatStrataUrl(path, fleet))
          expect(parsed.kind).toBe('levels')
          if (parsed.kind !== 'levels') return
          expect(resolveStrataUrl(parsed.slugs, fleet, { loaded: true })).toMatchObject({ path, exact: true, missing: null })
        }
      }
    }
  })
})

describe('resolveStrataUrl', () => {
  it('opens a deep link straight at its level', () => {
    const r = resolveStrataUrl(['studio', 'monorepo', 'basil'], fleet, { loaded: true })
    expect(r).toEqual({ path: { machine: 'm1', workspace: 'w1', agent: 'a2' }, exact: true, missing: null, pending: false })
  })

  it('falls back to the nearest level that exists', () => {
    expect(resolveStrataUrl(['nope', 'x', 'y'], fleet, { loaded: true })).toMatchObject({ path: {}, missing: 'machine', missingSlug: 'nope', pending: false })
    expect(resolveStrataUrl(['studio', 'nope'], fleet, { loaded: true })).toMatchObject({ path: { machine: 'm1' }, missing: 'workspace' })
    expect(resolveStrataUrl(['studio', 'monorepo', 'nope'], fleet, { loaded: true })).toMatchObject({
      path: { machine: 'm1', workspace: 'w1' },
      missing: 'agent'
    })
  })

  it('waits instead of falling back while the fleet or the machine is still loading', () => {
    expect(resolveStrataUrl(['studio', 'monorepo'], [], { loaded: false })).toMatchObject({ path: {}, pending: true, missing: null })
    expect(resolveStrataUrl(['batch-pool', 'jobs'], fleet, { loaded: true })).toMatchObject({ path: { machine: 'm4' }, pending: true, missing: null })
  })

  it('waits for a machine still connecting even when it shows a cached snapshot', () => {
    const cached: UrlMachine[] = [{ ...fleet[0], link: 'connecting' }]
    expect(resolveStrataUrl(['studio', 'brand-new-ws'], cached, { loaded: true })).toMatchObject({ path: { machine: 'm1' }, pending: true, missing: null })
    expect(resolveStrataUrl(['studio', 'monorepo', 'new-agent'], cached, { loaded: true })).toMatchObject({ path: { machine: 'm1', workspace: 'w1' }, pending: true })
  })

  it('falls back from a machine that cannot answer', () => {
    expect(resolveStrataUrl(['old-thinkpad', 'thesis'], fleet, { loaded: true })).toMatchObject({ path: { machine: 'm5' }, pending: false, missing: 'workspace' })
  })

  it('marks a non-canonical but resolvable URL as inexact', () => {
    expect(resolveStrataUrl(['STUDIO', 'monorepo'], fleet, { loaded: true })).toMatchObject({ path: { machine: 'm1', workspace: 'w1' }, exact: false, missing: null })
  })
})

describe('history: one entry per level', () => {
  it('lists a path with every ancestor, root first', () => {
    expect(ancestry({ machine: 'm', workspace: 'w', agent: 'a' })).toEqual([{}, { machine: 'm' }, { machine: 'm', workspace: 'w' }, { machine: 'm', workspace: 'w', agent: 'a' }])
    expect(ancestry({})).toEqual([{}])
    expect(depthOf({ machine: 'm', workspace: 'w' })).toBe(2)
  })

  it('going in pushes one entry; going out goes back one', () => {
    expect(planMove({ machine: 'm' }, { machine: 'm', workspace: 'w' })).toEqual({ back: 0, push: [{ machine: 'm', workspace: 'w' }] })
    expect(planMove({ machine: 'm', workspace: 'w' }, { machine: 'm' })).toEqual({ back: 1, push: [] })
  })

  it('a dive from level 0 pushes every level it skips', () => {
    expect(planMove({}, { machine: 'm', workspace: 'w', agent: 'a' })).toEqual({
      back: 0,
      push: [{ machine: 'm' }, { machine: 'm', workspace: 'w' }, { machine: 'm', workspace: 'w', agent: 'a' }]
    })
  })

  it('a dive into another machine first steps back to the shared ancestor', () => {
    expect(planMove({ machine: 'm', workspace: 'w' }, { machine: 'n', workspace: 'v', agent: 'b' })).toEqual({
      back: 2,
      push: [{ machine: 'n' }, { machine: 'n', workspace: 'v' }, { machine: 'n', workspace: 'v', agent: 'b' }]
    })
  })

  it('moving to where you are is a no-op', () => {
    expect(planMove({ machine: 'm' }, { machine: 'm' })).toEqual({ back: 0, push: [] })
  })
})
