// Solis, 2026-11-09: `cookrew recruit "X"` started claude in /home/ubuntu, the
// workspace's folder, and it sat on "Quick safety check: Is this a project you
// trust?" until the dispatch gave up 67 s later. Nothing said why. Owner ruling:
// the folder a person chose for a workspace is trusted for Claude; a home folder
// (or /) never silently, and the card says so instead of hanging.
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ClaudeCardPrep } from '../src/main/claude-card-prep'

const BYPASS = 'claude --permission-mode bypassPermissions'

function scratch(config?: Record<string, unknown>) {
  const home = realpathSync(mkdtempSync(path.join(tmpdir(), 'claude-card-prep-')))
  const claudeJson = path.join(home, '.claude.json')
  const settings = path.join(home, '.claude', 'settings.json')
  const app = path.join(home, 'app')
  mkdirSync(app)
  if (config) writeFileSync(claudeJson, JSON.stringify(config))
  const prep = new ClaudeCardPrep({ home, env: {}, exists: () => false })
  const read = (file: string): Record<string, unknown> => JSON.parse(readFileSync(file, 'utf8'))
  const projects = (): Record<string, { hasTrustDialogAccepted?: boolean }> =>
    (read(claudeJson).projects ?? {}) as Record<string, { hasTrustDialogAccepted?: boolean }>
  return { home, claudeJson, settings, app, prep, read, projects }
}

describe('ClaudeCardPrep.prepare', () => {
  it('trusts the workspace folder a card starts in, accepts bypass, and completes a signed-in onboarding', () => {
    const { app, prep, settings, claudeJson, read, projects } = scratch({ oauthAccount: { emailAddress: 'a@b' } })
    const report = prep.prepare(BYPASS, app, [app])
    expect(report).toEqual({ trust: 'trusted', consent: 'accepted', onboarding: 'completed' })
    expect(projects()[app].hasTrustDialogAccepted).toBe(true)
    expect(read(settings).skipDangerousModePermissionPrompt).toBe(true)
    expect(read(claudeJson).hasCompletedOnboarding).toBe(true)
  })

  it('trusts a folder inside a workspace folder, by its real path', () => {
    const { app, prep, projects } = scratch({})
    const sub = path.join(app, 'packages', 'web')
    mkdirSync(sub, { recursive: true })
    const link = path.join(path.dirname(app), 'link')
    symlinkSync(sub, link)
    expect(prep.prepare('claude', link, [app]).trust).toBe('trusted')
    expect(projects()[sub].hasTrustDialogAccepted).toBe(true)
  })

  it('never trusts the home folder silently, even when it is the workspace folder', () => {
    const { home, prep, projects } = scratch({})
    expect(prep.prepare(BYPASS, home, [home]).trust).toBe('broad')
    expect(projects()[home]).toBeUndefined()
  })

  it('never trusts a folder that is no workspace folder', () => {
    const { home, prep, projects } = scratch({})
    const elsewhere = path.join(home, 'elsewhere')
    mkdirSync(elsewhere)
    expect(prep.prepare('claude', elsewhere, [path.join(home, 'app')]).trust).toBe('outside')
    expect(projects()[elsewhere]).toBeUndefined()
  })

  it('writes no bypass acceptance for a card that does not run bypass permissions', () => {
    const { app, prep, settings } = scratch({})
    expect(prep.prepare('claude', app, [app]).consent).toBe('not-bypass')
    expect(() => readFileSync(settings)).toThrow()
  })

  it('leaves the onboarding wizard to a Claude nobody signed in', () => {
    const { app, prep, read, claudeJson } = scratch({})
    expect(prep.prepare(BYPASS, app, [app]).onboarding).toBe('not-signed-in')
    expect(read(claudeJson).hasCompletedOnboarding).toBeUndefined()
  })

  it('counts a key in the environment the panes get as a sign-in', () => {
    const home = realpathSync(mkdtempSync(path.join(tmpdir(), 'claude-card-prep-env-')))
    const prep = new ClaudeCardPrep({ home, env: { ANTHROPIC_API_KEY: 'k' }, exists: () => false })
    expect(prep.prepare('claude', home, []).onboarding).toBe('completed')
  })

  it('writes nothing a second time, and reads a file again only once it changed', () => {
    const { app, prep, settings, claudeJson } = scratch({ oauthAccount: {} })
    prep.prepare(BYPASS, app, [app])
    const before = [readFileSync(settings, 'utf8'), readFileSync(claudeJson, 'utf8')]
    expect(prep.prepare(BYPASS, app, [app])).toEqual({ trust: 'already-trusted', consent: 'already-accepted', onboarding: 'already-completed' })
    expect([readFileSync(settings, 'utf8'), readFileSync(claudeJson, 'utf8')]).toEqual(before)
  })

  it('writes a trust entry again that Claude dropped since', () => {
    const { app, prep, claudeJson, projects } = scratch({})
    prep.prepare('claude', app, [app])
    writeFileSync(claudeJson, JSON.stringify({ projects: {}, numStartups: 2 }))
    expect(prep.prepare('claude', app, [app]).trust).toBe('trusted')
    expect(projects()[app].hasTrustDialogAccepted).toBe(true)
  })

  it('lends nothing from a workspace whose folder is home: a project under it is not trusted unasked', () => {
    const { home, app, prep, projects } = scratch({})
    expect(prep.prepare('claude', app, [home]).trust).toBe('outside')
    expect(projects()[app]).toBeUndefined()
    expect(prep.folderBlock(app, [home])?.kind).toBe('folder-untrusted')
  })

  it("follows CLAUDE_CONFIG_DIR to the files Claude reads", () => {
    const home = realpathSync(mkdtempSync(path.join(tmpdir(), 'claude-card-prep-cfg-')))
    const dir = path.join(home, 'cfg')
    const app = path.join(home, 'app')
    mkdirSync(app)
    const prep = new ClaudeCardPrep({ home, env: { CLAUDE_CONFIG_DIR: dir, ANTHROPIC_API_KEY: 'k' }, exists: () => false })
    expect(prep.prepare(BYPASS, app, [app])).toEqual({ trust: 'trusted', consent: 'accepted', onboarding: 'completed' })
    expect(JSON.parse(readFileSync(path.join(dir, 'settings.json'), 'utf8')).skipDangerousModePermissionPrompt).toBe(true)
    expect(JSON.parse(readFileSync(path.join(dir, '.claude.json'), 'utf8')).hasCompletedOnboarding).toBe(true)
  })
})

describe('ClaudeCardPrep.folderBlock', () => {
  it('blocks a Claude card in an untrusted home folder, naming the folder and the way out', () => {
    const { home, prep } = scratch({})
    const block = prep.folderBlock(home, [home])
    expect(block?.kind).toBe('folder-untrusted')
    expect(block?.blocked).toBe(true)
    expect(block?.why).toContain(home)
    expect(block?.why).toContain('home folder')
    expect(block?.fix).toContain('cookrew trust')
  })

  it('blocks nothing once the person trusted the folder, by the button or the CLI', () => {
    const { home, prep, projects } = scratch({})
    expect(prep.folderBlock(home, [home])?.kind).toBe('folder-untrusted')
    expect(prep.trustChosen(home)).toBe('trusted')
    expect(projects()[home].hasTrustDialogAccepted).toBe(true)
    expect(prep.folderBlock(home, [home])).toBe(null)
  })

  it('blocks nothing Claude already trusts itself, or that prepare will trust', () => {
    const { home, prep } = scratch({ projects: { '/': { hasTrustDialogAccepted: true } } })
    expect(prep.folderBlock(home, [home])).toBe(null)
    const fresh = scratch({})
    expect(fresh.prep.folderBlock(fresh.app, [fresh.app])).toBe(null)
  })

  it('blocks an untrusted folder that is no workspace folder, since nobody would answer Claude there', () => {
    const { home, prep } = scratch({})
    const elsewhere = path.join(home, 'elsewhere')
    mkdirSync(elsewhere)
    expect(prep.folderBlock(elsewhere, [path.join(home, 'app')])?.kind).toBe('folder-untrusted')
  })

  it('says nothing when the config cannot be read: a false alarm costs more than silence', () => {
    const { home, prep, claudeJson } = scratch({})
    writeFileSync(claudeJson, '{')
    expect(prep.folderBlock(home, [home])).toBe(null)
  })
})

describe('ClaudeCardPrep.trustWorkspaceFolder', () => {
  it('trusts a new workspace folder when Claude has a config here, and leaves home and a Claude-less machine alone', () => {
    const { home, app, prep, projects } = scratch({})
    expect(prep.trustWorkspaceFolder(app)).toBe('trusted')
    expect(projects()[app].hasTrustDialogAccepted).toBe(true)
    expect(prep.trustWorkspaceFolder(home)).toBe('broad')
    const bare = realpathSync(mkdtempSync(path.join(tmpdir(), 'claude-card-prep-bare-')))
    expect(new ClaudeCardPrep({ home: bare, env: {}, exists: () => false }).trustWorkspaceFolder(bare + '/x')).toBe('no-claude')
  })
})
