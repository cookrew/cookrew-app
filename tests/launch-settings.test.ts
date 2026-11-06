// LAUNCH SETTINGS: the four things a launch line used to say, kept in a file the
// app reads at start. The default is that line; an explicit variable still wins.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { bootLaunchSettings, createLaunchSettings, launchEnvOf, launchSettingsPath, readLaunchChoices } from '../src/main/launch-settings'
import { LAUNCH_DEFAULTS, parseLaunchChoices, registryValue } from '../src/shared/launch-settings'

let dir = ''
let file = ''
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'launch-settings-'))
  file = path.join(dir, 'nested', 'launch-settings.json')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const settings = (env: Record<string, string> = {}, signedIn = false) =>
  createLaunchSettings({ file, boot: bootLaunchSettings({ ...env }, file), signedIn: () => signedIn })
const at = (values = LAUNCH_DEFAULTS, over: object = {}) => ({ values, running: LAUNCH_DEFAULTS, pinned: [], restart: false, signedIn: false, ...over })

describe('the defaults', () => {
  it('are the launch line the owner runs', () => {
    expect(LAUNCH_DEFAULTS).toEqual({ registry: 'https://cookrew.dev', interactiveBrowser: true, multiInstance: true, multiplexer: 'herdr' })
  })

  it('apply with no file and no variables, and nothing is pinned', () => {
    expect(settings().status()).toEqual(at())
  })
})

describe('what is kept', () => {
  it('lives with the rest of the app state', () => {
    expect(launchSettingsPath('/Users/me')).toBe('/Users/me/.cookrew/launch-settings.json')
  })

  it('drops what it cannot use, and keeps the rest', () => {
    expect(parseLaunchChoices({ multiplexer: 'screen', multiInstance: false, registry: 'ftp://x', interactiveBrowser: 'yes', other: 1 })).toEqual({ multiInstance: false })
  })

  it('reads a damaged file as nothing chosen', () => {
    settings().save({ multiInstance: false })
    writeFileSync(file, '{ not json')
    expect(readLaunchChoices(file)).toEqual({})
  })

  it('keeps only what differs from the default, so a later default still arrives', () => {
    expect(settings().save({ multiInstance: false, multiplexer: 'herdr', registry: 'https://cookrew.dev', interactiveBrowser: true }).ok).toBe(true)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ multiInstance: false })
  })
})

describe('a registry', () => {
  it('is an https origin, or loopback for a developer', () => {
    expect(registryValue(' https://registry.example/ ')).toBe('https://registry.example')
    expect(registryValue('http://127.0.0.1:8790')).toBe('http://127.0.0.1:8790')
  })

  it('is never a page in the clear on the open network', () => {
    expect(registryValue('http://registry.example')).toBeNull()
    expect(registryValue('not a url')).toBeNull()
    expect(registryValue(7)).toBeNull()
  })

  it('cannot be emptied here: that turns off the doors and leaves the phone line up, which no sheet should promise', () => {
    expect(registryValue('  ')).toBeNull()
    expect(settings().save({ registry: '' })).toEqual({ ok: false, reason: 'invalid-registry' })
  })

  it('stays as it is while signed in: the session would go to the new address', () => {
    const live = settings({}, true)
    expect(live.status().signedIn).toBe(true)
    expect(live.save({ registry: 'https://registry.example' })).toEqual({ ok: false, reason: 'signed-in' })
    expect(readLaunchChoices(file)).toEqual({})
  })

  it('does not stop a signed-in save that leaves it alone', () => {
    expect(settings({}, true).save({ registry: 'https://cookrew.dev/', multiInstance: false }).ok).toBe(true)
  })

  it('moves freely when signed out', () => {
    expect(settings().save({ registry: 'https://registry.example' }).ok).toBe(true)
  })
})

describe('at start', () => {
  it('a saved choice becomes the variable the app already reads', () => {
    settings().save({ registry: 'https://a.example', interactiveBrowser: false, multiInstance: false, multiplexer: 'tmux' })
    const env: Record<string, string> = {}
    bootLaunchSettings(env, file)
    expect(env).toMatchObject({ COOKREW_REGISTRY: 'https://a.example', COOKREW_INTERACTIVE_BROWSER: '0', COOKREW_MULTI_INSTANCE: '0', COOKREW_MULTIPLEXER: 'tmux' })
  })

  it('an explicit variable wins, even an empty one', () => {
    expect(launchEnvOf({ multiplexer: 'tmux', registry: 'https://a.example' }, { COOKREW_MULTIPLEXER: 'direct', COOKREW_REGISTRY: '' })).toEqual({})
  })

  it('a relaunch inherits what the file applied, and does not mistake it for the launch', () => {
    settings().save({ multiplexer: 'tmux' })
    const env: Record<string, string | undefined> = {}
    bootLaunchSettings(env, file)
    writeFileSync(file, '{}')
    const next = bootLaunchSettings(env, file)
    expect(env.COOKREW_MULTIPLEXER).toBeUndefined()
    expect(createLaunchSettings({ file, boot: next, signedIn: () => false }).status()).toEqual(at())
  })

  it('keeps a real variable beside one the file applied', () => {
    settings().save({ multiplexer: 'tmux' })
    const env: Record<string, string | undefined> = { COOKREW_MULTI_INSTANCE: '0' }
    bootLaunchSettings(env, file)
    const next = bootLaunchSettings(env, file)
    expect(createLaunchSettings({ file, boot: next, signedIn: () => false }).status().pinned).toEqual(['multiInstance'])
  })

  it('says nothing for what was never chosen, so panes inherit no new variable', () => {
    const env: Record<string, string> = {}
    bootLaunchSettings(env, file)
    expect(env).toEqual({})
  })
})

describe('the status', () => {
  it('shows a variable as what is in force, and pins it', () => {
    const status = settings({ COOKREW_MULTIPLEXER: 'tmux', COOKREW_MULTI_INSTANCE: '0' }).status()
    expect(status.values.multiplexer).toBe('tmux')
    expect(status.values.multiInstance).toBe(false)
    expect(status.pinned).toEqual(['multiInstance', 'multiplexer'])
  })

  it('asks for a restart once a saved choice differs from this run, and stops if it is put back', () => {
    const live = settings()
    const saved = live.save({ multiplexer: 'tmux' })
    expect(saved).toEqual({ ok: true, status: at({ ...LAUNCH_DEFAULTS, multiplexer: 'tmux' }, { restart: true }) })
    expect(live.save({}).ok && live.status().restart).toBe(false)
  })

  it('a restart picks up what was saved', () => {
    settings().save({ multiInstance: false })
    const values = { ...LAUNCH_DEFAULTS, multiInstance: false }
    expect(settings().status()).toEqual(at(values, { running: values }))
  })
})

describe('saving', () => {
  it('refuses a bad registry and leaves the file alone', () => {
    const live = settings()
    live.save({ multiInstance: false })
    expect(live.save({ registry: 'http://registry.example' })).toEqual({ ok: false, reason: 'invalid-registry' })
    expect(readLaunchChoices(file)).toEqual({ multiInstance: false })
  })

  it('refuses a host it does not know and what is not settings', () => {
    expect(settings().save({ multiplexer: 'screen' })).toEqual({ ok: false, reason: 'invalid-choice' })
    expect(settings().save({ multiInstance: 'no' })).toEqual({ ok: false, reason: 'invalid-choice' })
    expect(settings().save(null)).toEqual({ ok: false, reason: 'invalid-choice' })
  })

  it('cannot change what a variable holds, and keeps what was saved under it', () => {
    settings().save({ multiplexer: 'tmux' })
    const live = settings({ COOKREW_MULTIPLEXER: 'direct' })
    expect(live.save({ multiplexer: 'herdr', multiInstance: false }).ok).toBe(true)
    expect(readLaunchChoices(file)).toEqual({ multiplexer: 'tmux', multiInstance: false })
  })

  it('is not refused over a locked value the person cannot edit', () => {
    expect(settings({ COOKREW_MULTIPLEXER: 'custom' }).save({ multiplexer: 'custom', multiInstance: false }).ok).toBe(true)
    expect(settings({ COOKREW_REGISTRY: 'http://192.168.1.5:8790' }, true).save({ registry: 'http://192.168.1.5:8790', multiInstance: false }).ok).toBe(true)
  })

  it('says so when it cannot write', () => {
    const blocked = path.join(dir, 'a-file')
    writeFileSync(blocked, '')
    const live = createLaunchSettings({ file: path.join(blocked, 'launch-settings.json'), boot: bootLaunchSettings({}, file), signedIn: () => false })
    expect(live.save({ multiInstance: false })).toEqual({ ok: false, reason: 'write-failed' })
  })
})

describe('the wiring', () => {
  const main = readFileSync('src/main/index.ts', 'utf8')

  it('is read before anything else in main, so no module sees the old value', () => {
    expect(main.split('\n')[0]).toBe("import { launchBoot } from './launch-settings-boot'")
  })

  it('only the Mac\'s own window can read or change it', () => {
    expect(main).toMatch(/'launch-settings:status', \(event\) => \(ownerFrame\(event\)/)
    expect(main).toMatch(/'launch-settings:save', \(event, input: unknown\) => \(ownerFrame\(event\)/)
  })
})
