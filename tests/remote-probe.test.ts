// THE READERS BEHIND THE DESK: the lock and the display, cached and shared; a
// Linux session; what this build is called; the switch on disk.
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createSessionReader, linuxSession, remoteBuild, remoteSettingsFile, SESSION_FRESH_MS } from '../src/main/remote-probe'

describe('createSessionReader', () => {
  const facts = { locked: false, displayAsleep: false, grant: false }

  it('one read serves everyone for a moment: a card per frame must not be a process per frame', async () => {
    let now = 0
    const read = vi.fn(async () => facts)
    const reader = createSessionReader({ read, now: () => now })
    await Promise.all([reader.read(), reader.read()])
    await reader.read()
    expect(read).toHaveBeenCalledTimes(1)
    now += SESSION_FRESH_MS
    await reader.read()
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('a lock event throws the cache away at once', async () => {
    const read = vi.fn(async () => facts)
    const reader = createSessionReader({ read, now: () => 0 })
    await reader.read()
    reader.invalidate()
    await reader.read()
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('a failed read keeps the last answer: a busy Mac must not blank a live card', async () => {
    let now = 0
    const read = vi.fn<() => Promise<typeof facts>>().mockResolvedValueOnce({ ...facts, locked: true }).mockRejectedValue(new Error('osascript timed out'))
    const reader = createSessionReader({ read, now: () => now })
    await reader.read()
    now += SESSION_FRESH_MS
    expect((await reader.read()).locked).toBe(true)
  })

  it('with nothing known it claims nothing: no lock, and no grant', async () => {
    const reader = createSessionReader({ read: () => Promise.reject(new Error('no')), now: () => 0 })
    expect(await reader.read()).toEqual({ locked: false, displayAsleep: false, grant: null })
  })
})

describe('linuxSession', () => {
  const run = (answers: Record<string, string | Error>) => async (file: string): Promise<string> => {
    const answer = answers[file]
    if (answer === undefined || answer instanceof Error) throw answer ?? new Error('not installed')
    return answer
  }

  it('reads the lock from logind and the display from X', async () => {
    const session = await linuxSession({ XDG_SESSION_ID: '3' }, run({ loginctl: 'yes\n', xset: 'DPMS is Enabled\n  Monitor is Off\n' }))
    expect(session).toEqual({ locked: true, displayAsleep: true, grant: null })
  })

  it('a machine with neither tool is simply awake and unlocked as far as anyone can tell', async () => {
    expect(await linuxSession({ XDG_SESSION_ID: '3' }, run({}))).toEqual({ locked: false, displayAsleep: false, grant: null })
  })

  it('asks logind about no session when there is none to name', async () => {
    const spy = vi.fn(async () => 'no')
    await linuxSession({}, spy)
    expect(spy).not.toHaveBeenCalledWith('loginctl', expect.anything())
  })
})

describe('remoteBuild', () => {
  const source = '/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'
  const shipped = '/Applications/Cookrew.app/Contents/MacOS/Cookrew'

  it('a source build goes by the bundle it runs from, and cannot relaunch itself', () => {
    expect(remoteBuild({ execPath: source, packaged: false, persists: true, servedLive: false })).toEqual({ settingsName: 'Electron', sourceBuild: true, restart: 'by-hand', agents: 'keep' })
  })

  it('a shipped build is Cookrew, and can', () => {
    expect(remoteBuild({ execPath: shipped, packaged: true, persists: true, servedLive: false })).toEqual({ settingsName: 'Cookrew', sourceBuild: false, restart: 'self', agents: 'keep' })
  })

  it('says what a restart does to the agents on this host', () => {
    expect(remoteBuild({ execPath: shipped, packaged: true, persists: false, servedLive: false }).agents).toBe('stop')
    expect(remoteBuild({ execPath: shipped, packaged: true, persists: true, servedLive: true }).agents).toBe('keep-not-served')
  })

  it('a binary outside any bundle falls back on what it is', () => {
    expect(remoteBuild({ execPath: '/opt/cookrew/cookrew', packaged: true, persists: true, servedLive: false }).settingsName).toBe('Cookrew')
    expect(remoteBuild({ execPath: '/x/electron', packaged: false, persists: true, servedLive: false }).settingsName).toBe('Electron')
  })
})

describe('remoteSettingsFile', () => {
  const file = (): string => path.join(mkdtempSync(path.join(tmpdir(), 'remote-settings-')), 'remote-control.json')

  it('is off when there is no file, and a good write reads back', () => {
    const at = file()
    const settings = remoteSettingsFile(at)
    expect(settings.read()).toEqual({ on: false, waiting: null })
    settings.write({ on: true, waiting: 'screen' })
    expect(settings.read()).toEqual({ on: true, waiting: 'screen' })
  })

  it('only the owner can read or write it', () => {
    const at = file()
    remoteSettingsFile(at).write({ on: true, waiting: null })
    expect(statSync(at).mode & 0o777).toBe(0o600)
  })

  it('anything but a plain true is off', () => {
    const at = file()
    for (const text of ['{"on":"yes"}', '{"on":1}', 'garbage', '[]', 'null', '{"on":true,"waiting":"root"}']) {
      writeFileSync(at, text)
      const read = remoteSettingsFile(at).read()
      expect(read.waiting).toBeNull()
      if (text !== '{"on":true,"waiting":"root"}') expect(read.on).toBe(false)
    }
    expect(readFileSync(at, 'utf8')).toContain('root')
  })
})
