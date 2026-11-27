// Devin binding, resume, card config and launch line (src/main/devin-bind.ts),
// and its model offer (src/main/devin-models.ts). Shapes read off Devin
// 3000.14 on 2026-11-26/27; paths are built natively for every platform.

import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  devinCardConfig,
  devinCardConfigFile,
  devinLogFile,
  devinNewerLock,
  devinResumeCommand,
  devinSessionExists,
  devinSessionFromOpenFiles,
  devinSessionLine,
  devinSessionOfFile,
  devinWatchFile,
  processTree,
  resolveDevinSessionByPid,
  stripDevinSessionFlags,
  validDevinSessionId
} from '../src/main/devin-bind'
import { devinLaunchOffer, devinSlugsOf } from '../src/main/devin-models'

const ID = 'wary-seeker'
const DATA = path.join(path.sep, 'Users', 'me', '.local', 'share', 'devin', 'cli')
const under = (...parts: string[]): string => path.join(DATA, ...parts)

function dataDirWith(...sessions: string[]): string {
  const data = mkdtempSync(path.join(tmpdir(), 'devin-data-'))
  for (const id of sessions) {
    mkdirSync(path.join(data, 'sessions', id), { recursive: true })
    writeFileSync(path.join(data, 'sessions', id, 'meta.json'), '{}')
  }
  return data
}

describe('Devin session ids', () => {
  it('accepts word slugs only', () => {
    for (const good of [ID, 'gravel-wormhole', 'luxurious-beard', 'abc12345']) expect(validDevinSessionId(good)).toBe(true)
    for (const bad of ['../../etc/passwd', `${ID}; rm -rf /`, 'Wary-Seeker', '-r', '', 'a--b', null, 3]) expect(validDevinSessionId(bad)).toBe(false)
  })

  it('a log path names its session; any other path names none', () => {
    expect(devinSessionOfFile(devinLogFile(ID, DATA))).toBe(ID)
    expect(devinSessionOfFile(under('sessions', ID, 'meta.json'))).toBeUndefined()
    expect(devinSessionOfFile(path.join(path.sep, 'tmp', 'log.jsonl'))).toBeUndefined()
  })
})

describe('binding by the session lock the Devin worker holds', () => {
  it('reads the lock among open files; refuses one outside the data dir', () => {
    expect(devinSessionFromOpenFiles([under('logs', 'devin.log'), under('session_locks', `${ID}.lock`)], DATA)).toBe(ID)
    expect(devinSessionFromOpenFiles([path.join(path.sep, 'tmp', 'session_locks', `${ID}.lock`)], DATA)).toBeNull()
    expect(devinSessionFromOpenFiles([under('session_locks', '__import__.lock')], DATA)).toBeNull()
  })

  it("walks the pane's process tree: the lock sits in a child", () => {
    const data = dataDirWith(ID)
    const children = (pid: number): number[] => ({ 10: [11], 11: [12] })[pid] ?? []
    expect(processTree(10, children)).toEqual([10, 11, 12])
    const files = (pid: number): string[] => (pid === 11 ? [path.join(data, 'session_locks', `${ID}.lock`)] : [])
    expect(resolveDevinSessionByPid(10, files, children, data)).toBe(ID)
  })

  it('binds only once the session has had its first prompt (its meta exists)', () => {
    const data = dataDirWith()
    const files = (): string[] => [path.join(data, 'session_locks', `${ID}.lock`)]
    expect(resolveDevinSessionByPid(10, files, () => [], data)).toBeNull()
    expect(devinSessionExists(ID, dataDirWith(ID))).toBe(true)
  })

  it('no pid, no lookup', () => {
    const read = vi.fn(() => [])
    expect(resolveDevinSessionByPid(null, read)).toBeNull()
    expect(read).not.toHaveBeenCalled()
  })

  it.skipIf(process.platform === 'win32')('a data dir reached through a symlink matches the resolved path lsof prints', () => {
    const real = mkdtempSync(path.join(tmpdir(), 'devin-real-'))
    const link = path.join(mkdtempSync(path.join(tmpdir(), 'devin-link-')), 'cli')
    symlinkSync(real, link)
    expect(devinSessionFromOpenFiles([path.join(realpathSync(real), 'session_locks', `${ID}.lock`)], link)).toBe(ID)
  })

  it('a newer lock than the bound one is the follow hint', () => {
    const data = dataDirWith(ID)
    mkdirSync(path.join(data, 'session_locks'))
    writeFileSync(path.join(data, 'session_locks', `${ID}.lock`), '')
    expect(devinNewerLock(ID, data)).toBe(false)
    const later = path.join(data, 'session_locks', 'gravel-wormhole.lock')
    writeFileSync(later, '')
    utimesSync(later, new Date(Date.now() + 5000), new Date(Date.now() + 5000))
    expect(devinNewerLock(ID, data)).toBe(true)
    expect(devinNewerLock('no-such', data)).toBe(false)
  })
})

describe('Devin resume, copies and watch', () => {
  it('resumes with -r, replacing any earlier session flag', () => {
    expect(devinResumeCommand('devin --model swe-2-1', ID)).toBe(`devin --model swe-2-1 -r ${ID}`)
    expect(devinResumeCommand('devin -r gravel-wormhole --permission-mode auto', ID)).toBe(`devin --permission-mode auto -r ${ID}`)
  })

  it('a copy keeps no session, no -c guess and no card settings', () => {
    const line = `devin --model swe-2-1 -r ${ID} -c --config '/x y/c.json' --process-model in-process --respect-workspace-trust false --permission-mode auto`
    expect(stripDevinSessionFlags(line)).toBe('devin --model swe-2-1 --permission-mode auto')
    expect(stripDevinSessionFlags('devin -r')).toBe('devin')
  })

  it('the watch file needs a valid bound id', () => {
    expect(devinWatchFile({ devinSessionId: ID }, { devinDataDir: DATA })).toBe(under('sessions', ID, 'log.jsonl'))
    expect(devinWatchFile({ devinSessionId: '../x' }, { devinDataDir: DATA })).toBeNull()
    expect(devinWatchFile({}, { devinDataDir: DATA })).toBeNull()
  })
})

describe("a Devin card's own config and launch line", () => {
  it('keeps what Devin wrote, takes the person config over it, and forces files + no Claude hooks', () => {
    const card = { version: 1, devin: { org_id: 'org-1' }, theme_mode: 'dark', read_config_from: { cursor: false } }
    const user = { version: 1, permission_mode: 'auto', read_config_from: { claude: true, windsurf: false } }
    expect(devinCardConfig(card, user)).toEqual({
      version: 1,
      devin: { org_id: 'org-1' },
      theme_mode: 'dark',
      permission_mode: 'auto',
      read_config_from: { cursor: false, claude: false, windsurf: false },
      session_store: 'files'
    })
  })

  it('writes the config and adds the flags; a second spawn keeps what Devin wrote', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'devin-home-'))
    const userConfig = path.join(home, 'user.json')
    writeFileSync(userConfig, JSON.stringify({ version: 1 }))
    const file = devinCardConfigFile('card-1', home)
    const line = devinSessionLine('devin', 'card-1', { home, userConfig })
    expect(line).toContain('--config ')
    expect(line).toMatch(/--process-model in-process --respect-workspace-trust false$/)
    expect(stripDevinSessionFlags(line)).toBe('devin')
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), shell: { setup_complete: true } }))
    devinSessionLine('devin', 'card-1', { home, userConfig })
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ shell: { setup_complete: true }, session_store: 'files', read_config_from: { claude: false } })
  })

  it('a line with its own --config keeps it; a bad card id writes nothing', () => {
    expect(devinSessionLine('devin --config /mine.json', 'card-1')).toBe('devin --config /mine.json --process-model in-process --respect-workspace-trust false')
    expect(devinSessionLine('devin', '../x')).toBe('devin --process-model in-process --respect-workspace-trust false')
  })
})

describe('Devin model offer', () => {
  const OUTPUT = JSON.stringify({ families: [
    { slug: 'adaptive', variants: [{ model_uid: 'adaptive' }] },
    { slug: 'swe-2.1', variants: [{ model_uid: 'swe-2-1-medium' }, { model_uid: 'swe-2-1' }, { model_uid: '; rm -rf /' }] }
  ] })

  it('every variant is a model; Devin has no effort flag', () => {
    expect(devinSlugsOf(OUTPUT)).toEqual(['adaptive', 'swe-2-1-medium', 'swe-2-1', '; rm -rf /'])
    expect(devinSlugsOf('not json')).toEqual([])
    const dir = mkdtempSync(path.join(tmpdir(), 'devin-models-'))
    const cacheFile = path.join(dir, 'devin-models.json')
    const refresh = vi.fn()
    expect(devinLaunchOffer({ cacheFile, refresh, now: () => 1 })).toBeNull()
    expect(refresh).toHaveBeenCalledTimes(1)
    writeFileSync(cacheFile, JSON.stringify({ at: 1, slugs: devinSlugsOf(OUTPUT) }))
    expect(devinLaunchOffer({ cacheFile, refresh, now: () => 2 })).toEqual({ harness: 'devin', model: ['adaptive', 'swe-2-1-medium', 'swe-2-1'], effort: [] })
  })
})
