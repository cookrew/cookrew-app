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

  it('a lock heard while a read is in flight is not cached over by that older answer', async () => {
    let now = 0
    let release: (facts: typeof facts0) => void = () => undefined
    const facts0 = { locked: false, displayAsleep: false, grant: false }
    const read = vi.fn(() => new Promise<typeof facts0>((resolve) => { release = resolve }))
    const reader = createSessionReader({ read, now: () => now })
    const first = reader.read()
    reader.invalidate()
    release(facts0)
    await first
    void reader.read()
    expect(read).toHaveBeenCalledTimes(2)
    now += 1
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

  it('is empty when there is no file, and a good write reads back', () => {
    const at = file()
    const settings = remoteSettingsFile(at)
    expect(settings.read()).toEqual({ waiting: null, holdUntil: 0 })
    settings.write({ waiting: 'screen', holdUntil: 5 })
    expect(settings.read()).toEqual({ waiting: 'screen', holdUntil: 5 })
  })

  it('the machine switch is not in it, whatever is written there', () => {
    const at = file()
    writeFileSync(at, '{"on":true,"switch":true}')
    expect(remoteSettingsFile(at).read()).toEqual({ waiting: null, holdUntil: 0 })
  })

  it('only the owner can read or write it', () => {
    const at = file()
    remoteSettingsFile(at).write({ waiting: null, holdUntil: 1 })
    expect(statSync(at).mode & 0o777).toBe(0o600)
  })

  it('anything malformed is nothing', () => {
    const at = file()
    for (const text of ['garbage', '[]', 'null', '{"waiting":"root","holdUntil":"x"}']) {
      writeFileSync(at, text)
      expect(remoteSettingsFile(at).read()).toEqual({ waiting: null, holdUntil: 0 })
    }
    expect(readFileSync(at, 'utf8')).toContain('root')
  })
})
