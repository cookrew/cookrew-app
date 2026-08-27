import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  browserProfilePath,
  reapOrphanBrowserProfiles,
  removeBrowserProfile
} from '../src/main/browser-profile-store'

describe('browser profile storage', () => {
  it('reaps only unowned direct child directories', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'cookrew-browser-profiles-'))
    const owned = path.join(root, 'owned')
    const orphan = path.join(root, 'orphan')
    mkdirSync(owned)
    mkdirSync(orphan)
    writeFileSync(path.join(owned, 'cookie'), 'keep')
    writeFileSync(path.join(orphan, 'cache'), 'drop')
    symlinkSync(orphan, path.join(root, 'profile-link'))

    expect(reapOrphanBrowserProfiles(root, ['owned'])).toEqual(['orphan'])
    expect(existsSync(owned)).toBe(true)
    expect(existsSync(orphan)).toBe(false)
    expect(lstatSync(path.join(root, 'profile-link')).isSymbolicLink()).toBe(true)
  })

  it('removes one retired profile without following paths outside the root', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'cookrew-browser-profiles-'))
    mkdirSync(path.join(root, 'browser-1'))
    expect(removeBrowserProfile(root, 'browser-1')).toBe(true)
    expect(removeBrowserProfile(root, 'browser-1')).toBe(false)
    expect(() => browserProfilePath(root, '../outside')).toThrow(/Invalid browser profile id/)
  })
})
