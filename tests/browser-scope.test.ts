import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { SHARED_INSTALLATION_DIRS, shareInstallationDirs } from '../src/main/browser-scope'

const roots = (): { profile: string; shared: string } => {
  const base = mkdtempSync(path.join(tmpdir(), 'cookrew-scope-'))
  const profile = path.join(base, 'profile')
  const shared = path.join(base, 'shared')
  mkdirSync(profile, { recursive: true })
  return { profile, shared }
}

describe('shareInstallationDirs — Chromium installation scope belongs to the installation', () => {
  it('links every installation-scope directory into one shared store', () => {
    const { profile, shared } = roots()
    shareInstallationDirs(profile, shared)
    for (const name of SHARED_INSTALLATION_DIRS) {
      const link = path.join(profile, name)
      expect(lstatSync(link).isSymbolicLink()).toBe(true)
      expect(readlinkSync(link)).toBe(path.join(shared, name))
    }
  })

  it('replaces a real directory that a previous run downloaded', () => {
    // Existing profiles already hold ~127MB of these. They are caches Chrome
    // rebuilds, so replacing them is a re-download at worst — and it is the
    // only way an existing card stops paying for its own copy.
    const { profile, shared } = roots()
    const victim = path.join(profile, SHARED_INSTALLATION_DIRS[0])
    mkdirSync(victim, { recursive: true })
    writeFileSync(path.join(victim, 'model.bin'), 'x')

    const freed = shareInstallationDirs(profile, shared)

    expect(lstatSync(victim).isSymbolicLink()).toBe(true)
    expect(freed).toBeGreaterThan(0)
  })

  it('is idempotent — a second call leaves the links alone', () => {
    const { profile, shared } = roots()
    shareInstallationDirs(profile, shared)
    expect(shareInstallationDirs(profile, shared)).toBe(0)
    for (const name of SHARED_INSTALLATION_DIRS) {
      expect(lstatSync(path.join(profile, name)).isSymbolicLink()).toBe(true)
    }
  })

  it('NEVER touches identity state', () => {
    // The whole point of a per-card profile is that a site stays logged in.
    // Sharing may cost a re-download; it may not cost a re-login.
    const { profile, shared } = roots()
    const cookies = path.join(profile, 'Default', 'Cookies')
    mkdirSync(path.dirname(cookies), { recursive: true })
    writeFileSync(cookies, 'secret')

    shareInstallationDirs(profile, shared)

    expect(readFileSync(cookies, 'utf8')).toBe('secret')
    expect(lstatSync(path.join(profile, 'Default')).isSymbolicLink()).toBe(false)
  })

  it('never lists an identity directory as shareable', () => {
    for (const name of SHARED_INSTALLATION_DIRS) {
      expect(name).not.toMatch(/Cookies|Local Storage|IndexedDB|Login Data|Preferences|^Default$/)
    }
  })

  it('creates the shared store on first use', () => {
    const { profile, shared } = roots()
    expect(existsSync(shared)).toBe(false)
    shareInstallationDirs(profile, shared)
    expect(existsSync(shared)).toBe(true)
  })

  it('survives a profile directory that does not exist yet', () => {
    const { shared } = roots()
    const missing = path.join(shared, '..', 'never-created')
    expect(() => shareInstallationDirs(missing, shared)).not.toThrow()
  })
})
