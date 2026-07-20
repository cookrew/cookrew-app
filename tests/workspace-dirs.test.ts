import { describe, expect, it } from 'vitest'
import { addDir, removeDir, setPrimary } from '../src/shared/workspace-dirs'

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
