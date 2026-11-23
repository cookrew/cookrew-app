import { describe, expect, it } from 'vitest'
import { inside, parseSharedRoots, safeRelative, sharedRoots } from '../src/shared/shared-roots'

describe('the owner’s shared folders', () => {
  it('are absolute paths, once each, and nothing else', () => {
    expect(parseSharedRoots({ roots: ['/Users/x/Documents', '/Users/x/Documents', 'relative', '', 7, null, '/Users/x/Media'] }))
      .toEqual(['/Users/x/Documents', '/Users/x/Media'])
    expect(parseSharedRoots({ roots: 'nope' })).toEqual([])
    expect(parseSharedRoots(null)).toEqual([])
  })

  it('include the workspace’s own directories first', () => {
    expect(sharedRoots(['/w/one', '/w/two'], ['/Users/x/Documents', '/w/one']))
      .toEqual(['/w/one', '/w/two', '/Users/x/Documents'])
  })
})

describe('a path a device asks for', () => {
  it('is relative, with . and empty parts dropped', () => {
    expect(safeRelative('a/b.txt')).toBe('a/b.txt')
    expect(safeRelative('/a//b/./c.txt')).toBe('a/b/c.txt')
    expect(safeRelative('')).toBe('')
  })

  it('is refused when it could leave the root', () => {
    expect(safeRelative('../etc/passwd')).toBeNull()
    expect(safeRelative('a/../../etc/passwd')).toBeNull()
    expect(safeRelative('a\0b')).toBeNull()
  })

  it('is checked against the resolved root', () => {
    expect(inside('/Users/x/Documents', '/Users/x/Documents/a.txt')).toBe(true)
    expect(inside('/Users/x/Documents', '/Users/x/Documents')).toBe(true)
    expect(inside('/Users/x/Documents', '/Users/x/Documentsx')).toBe(false)
    expect(inside('/Users/x/Documents', '/Users/x/Other/a.txt')).toBe(false)
  })
})
