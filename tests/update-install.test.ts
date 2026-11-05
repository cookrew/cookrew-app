// WHO MAY INSTALL ITS OWN UPDATE. A Mac only swaps in a build for a signed one,
// so an unsigned build must say so and keep to the release page.
import { describe, expect, it, vi } from 'vitest'
import { autoUpdaterOf, canUpdateItself, type InstallFacts } from '../src/main/update-install'

const facts = (over: Partial<InstallFacts>): InstallFacts => ({
  platform: 'darwin',
  env: {},
  execPath: '/Applications/Cookrew.app/Contents/MacOS/Cookrew',
  describeSignature: async () => 'Authority=Developer ID Application: Cookrew (ABCDE12345)\nTeamIdentifier=ABCDE12345',
  ...over
})

describe('canUpdateItself', () => {
  it('a Mac build signed with a real identity can', async () => {
    expect(await canUpdateItself(facts({}))).toBe(true)
  })

  it('an ad hoc Mac build cannot: Squirrel refuses it', async () => {
    expect(await canUpdateItself(facts({ describeSignature: async () => 'Signature=adhoc\nTeamIdentifier=not set' }))).toBe(false)
  })

  it('asks about the bundle, not the binary inside it', async () => {
    const describeSignature = vi.fn(async () => 'Authority=x')
    await canUpdateItself(facts({ describeSignature }))
    expect(describeSignature).toHaveBeenCalledWith('/Applications/Cookrew.app')
  })

  it('a signature it cannot read is no signature', async () => {
    expect(await canUpdateItself(facts({ describeSignature: async () => Promise.reject(new Error('codesign failed')) }))).toBe(false)
    expect(await canUpdateItself(facts({ execPath: '/usr/local/bin/cookrew' }))).toBe(false)
  })

  it('the Windows installer can, the portable exe cannot', async () => {
    expect(await canUpdateItself(facts({ platform: 'win32' }))).toBe(true)
    expect(await canUpdateItself(facts({ platform: 'win32', env: { PORTABLE_EXECUTABLE_DIR: 'C:\\apps' } }))).toBe(false)
  })

  it('Linux can only as an AppImage', async () => {
    expect(await canUpdateItself(facts({ platform: 'linux' }))).toBe(false)
    expect(await canUpdateItself(facts({ platform: 'linux', env: { APPIMAGE: '/opt/Cookrew.AppImage' } }))).toBe(true)
  })
})

describe('autoUpdaterOf', () => {
  const autoUpdater = {} as ReturnType<typeof autoUpdaterOf>

  it('finds it on default, where the packaged main process has it', () => {
    expect(autoUpdaterOf({ default: { autoUpdater } })).toBe(autoUpdater)
  })

  it('finds it by name too', () => {
    expect(autoUpdaterOf({ autoUpdater })).toBe(autoUpdater)
  })

  it('says so rather than failing on a property of undefined', () => {
    expect(() => autoUpdaterOf({})).toThrow('no autoUpdater')
  })
})
