// THE MAGPIE SWITCHES: kept with the launch settings, but live. A save applies at
// once, never asks for a restart, and keeps every other saved choice.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { bootLaunchSettings, createLaunchSettings } from '../src/main/launch-settings'
import { launchValues } from '../src/main/launch-defaults'
import { LAUNCH_DEFAULTS, LIVE_KEYS, parseLaunchChoices } from '../src/shared/launch-settings'

let dir = ''
let file = ''
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'launch-live-'))
  file = path.join(dir, 'launch-settings.json')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const settings = (env: Record<string, string> = {}) => createLaunchSettings({ file, boot: bootLaunchSettings({ ...env }, file), signedIn: () => false })

describe('the Magpie switches', () => {
  it('default to Magpie on and Magpie remote off', () => {
    expect(LAUNCH_DEFAULTS.magpie).toBe(true)
    expect(LAUNCH_DEFAULTS.magpieRemote).toBe(false)
    expect(settings().live()).toEqual({ magpie: true, magpieRemote: false })
    expect(LIVE_KEYS).toEqual(['magpie', 'magpieRemote'])
  })

  it('read COOKREW_MAGPIE and COOKREW_MAGPIE_REMOTE', () => {
    expect(launchValues({ COOKREW_MAGPIE: '0', COOKREW_MAGPIE_REMOTE: '1' })).toMatchObject({ magpie: false, magpieRemote: true })
    expect(launchValues({})).toMatchObject({ magpie: true, magpieRemote: false })
  })

  it('parse only booleans from a hand-edited file', () => {
    expect(parseLaunchChoices({ magpie: 'no', magpieRemote: true })).toEqual({ magpieRemote: true })
  })

  it('apply at once, without a restart, and tell who listens', () => {
    const s = settings()
    const heard: unknown[] = []
    s.onLive((values) => heard.push(values))
    const answer = s.setLive({ magpieRemote: true })
    expect(answer.ok).toBe(true)
    expect(s.live()).toEqual({ magpie: true, magpieRemote: true })
    expect(s.status().restart).toBe(false)
    expect(s.status().running.magpieRemote).toBe(true)
    expect(heard).toEqual([{ magpie: true, magpieRemote: true }])
  })

  it('keep every other saved choice, and store only what differs from the default', () => {
    writeFileSync(file, JSON.stringify({ multiplexer: 'tmux', interactiveBrowser: false }))
    const s = settings()
    s.setLive({ magpie: false })
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ multiplexer: 'tmux', interactiveBrowser: false, magpie: false })
    s.setLive({ magpie: true })
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ multiplexer: 'tmux', interactiveBrowser: false })
  })

  it('leave a switch pinned by its variable alone, and refuse other keys', () => {
    const s = settings({ COOKREW_MAGPIE: '0' })
    s.setLive({ magpie: true })
    expect(s.live().magpie).toBe(false)
    expect(s.status().pinned).toContain('magpie')
    expect(s.setLive({ multiplexer: 'tmux' })).toEqual({ ok: false, reason: 'invalid-choice' })
    expect(s.setLive(null)).toEqual({ ok: false, reason: 'invalid-choice' })
  })

  it('are saved by the sheet too, still without asking for a restart', () => {
    const s = settings()
    const answer = s.save({ ...LAUNCH_DEFAULTS, magpie: false })
    expect(answer.ok).toBe(true)
    expect(s.live().magpie).toBe(false)
    expect(s.status().restart).toBe(false)
  })
})
