import { describe, expect, it } from 'vitest'
import { openToOthers } from '../src/main/file-privacy'

describe('openToOthers', () => {
  it('reads the group and other bits on a POSIX host', () => {
    expect(openToOthers(0o100600, 'darwin')).toBe(false)
    expect(openToOthers(0o100640, 'linux')).toBe(true)
    expect(openToOthers(0o100604, 'darwin')).toBe(true)
  })

  it('refuses nothing on Windows, where stat reports 0o666 for a file written 0600', () => {
    expect(openToOthers(0o100666, 'win32')).toBe(false)
  })
})
