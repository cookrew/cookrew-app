import { describe, expect, it } from 'vitest'
import { addDir, planRecruitTarget, removeDir, resolveDirOwner, setPrimary } from '../src/shared/workspace-dirs'

describe('addDir', () => {
  it('appends a new directory, preserving order', () => {
    expect(addDir(['/a'], '/b')).toEqual(['/a', '/b'])
  })

  it('is idempotent for an existing directory', () => {
    expect(addDir(['/a', '/b'], '/a')).toEqual(['/a', '/b'])
  })

  it('trims and rejects empty input', () => {
    expect(addDir(['/a'], '  /b ')).toEqual(['/a', '/b'])
    expect(() => addDir(['/a'], '   ')).toThrow(/must not be empty/)
  })
})

describe('removeDir', () => {
  it('removes a directory, keeping the rest ordered', () => {
    expect(removeDir(['/a', '/b', '/c'], '/b', false)).toEqual(['/a', '/c'])
  })

  it('refuses to remove the last directory', () => {
    expect(() => removeDir(['/a'], '/a', false)).toThrow(/last directory/)
  })

  it('refuses to remove a directory in use by a live terminal', () => {
    expect(() => removeDir(['/a', '/b'], '/a', true)).toThrow(/live terminal/)
  })

  it('refuses to remove a non-member directory', () => {
    expect(() => removeDir(['/a', '/b'], '/z', false)).toThrow(/not a directory/)
  })
})

describe('setPrimary', () => {
  it('moves the chosen directory to the front', () => {
    expect(setPrimary(['/a', '/b', '/c'], '/c')).toEqual(['/c', '/a', '/b'])
  })

  it('is a no-op when already primary', () => {
    expect(setPrimary(['/a', '/b'], '/a')).toEqual(['/a', '/b'])
  })

  it('rejects a non-member directory', () => {
    expect(() => setPrimary(['/a'], '/z')).toThrow(/not a directory/)
  })
})

describe('resolveDirOwner / planRecruitTarget (recruit --dir routing)', () => {
  const candidates = [
    { id: 'home', dirs: ['/work/alpha'] },
    { id: 'beta', dirs: ['/work/beta', '/work/beta-tools'] },
    { id: 'deep', dirs: ['/work/beta/packages/core'] }
  ]

  it('routes an exact dir match to its owner', () => {
    expect(resolveDirOwner(candidates, '/work/beta')).toBe('beta')
  })

  it('routes a subdirectory to the owning workspace', () => {
    expect(resolveDirOwner(candidates, '/work/beta/src/ui')).toBe('beta')
  })

  it('prefers the LONGEST matching prefix over a shallower owner', () => {
    expect(resolveDirOwner(candidates, '/work/beta/packages/core/lib')).toBe('deep')
  })

  it('does not treat sibling prefixes as parents', () => {
    expect(resolveDirOwner(candidates, '/work/beta-extras')).toBeNull()
  })

  it('ignores trailing slashes on both sides', () => {
    expect(resolveDirOwner(candidates, '/work/beta/')).toBe('beta')
    expect(resolveDirOwner([{ id: 'x', dirs: ['/work/x/'] }], '/work/x/sub')).toBe('x')
  })

  it('plans: owned dir -> owner workspace, no auto-add', () => {
    expect(planRecruitTarget(candidates, 'home', '/work/beta/src')).toEqual({
      workspaceId: 'beta',
      autoAddDir: null
    })
  })

  it('plans: unowned dir -> orch home with auto-add', () => {
    expect(planRecruitTarget(candidates, 'home', '/elsewhere/repo')).toEqual({
      workspaceId: 'home',
      autoAddDir: '/elsewhere/repo'
    })
  })

  it('plans: no --dir -> orch home, no auto-add', () => {
    expect(planRecruitTarget(candidates, 'home', null)).toEqual({
      workspaceId: 'home',
      autoAddDir: null
    })
  })
})
