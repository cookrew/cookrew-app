// A fresh Claude asked "By proceeding, you accept all responsibility... No, exit /
// Yes, I accept" the first time a card ran it in bypassPermissions; the delivered
// prompt answered it and claude exited 1 (Solis, 2026-11-09). The owner ruled
// bypass permissions on for their own cards, so the acceptance is written the way
// Claude 2.1.x writes it: skipDangerousModePermissionPrompt in ~/.claude/settings.json.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  acceptBypassConsent,
  bypassConsentState,
  claudeSignedInBy,
  completeOnboarding,
  runsBypassPermissions
} from '../src/main/claude-consent'

function scratch(): { home: string; settings: string; claudeJson: string } {
  const home = mkdtempSync(path.join(tmpdir(), 'claude-consent-'))
  return { home, settings: path.join(home, '.claude', 'settings.json'), claudeJson: path.join(home, '.claude.json') }
}

describe('runsBypassPermissions', () => {
  it('knows both spellings of the mode and the old flag, and nothing else', () => {
    expect(runsBypassPermissions('claude --permission-mode bypassPermissions')).toBe(true)
    expect(runsBypassPermissions('claude --permission-mode=bypassPermissions --model opus')).toBe(true)
    expect(runsBypassPermissions('claude --dangerously-skip-permissions')).toBe(true)
    expect(runsBypassPermissions('claude')).toBe(false)
    expect(runsBypassPermissions('claude --permission-mode acceptEdits')).toBe(false)
  })
})

describe('acceptBypassConsent', () => {
  it('creates ~/.claude/settings.json (0600, in a 0700 folder) with the acceptance when nothing is there', () => {
    const { settings } = scratch()
    expect(acceptBypassConsent(settings)).toBe('accepted')
    expect(JSON.parse(readFileSync(settings, 'utf8'))).toEqual({ skipDangerousModePermissionPrompt: true })
    expect(statSync(settings).mode & 0o777).toBe(0o600)
    expect(statSync(path.dirname(settings)).mode & 0o777).toBe(0o700)
    expect(bypassConsentState(settings)).toBe('accepted')
  })

  it('keeps every other setting and the file mode', () => {
    const { settings } = scratch()
    mkdirSync(path.dirname(settings), { recursive: true })
    writeFileSync(settings, JSON.stringify({ theme: 'light', permissions: { allow: ['Bash'] } }), { mode: 0o644 })
    expect(acceptBypassConsent(settings)).toBe('accepted')
    expect(JSON.parse(readFileSync(settings, 'utf8'))).toEqual({
      theme: 'light',
      permissions: { allow: ['Bash'] },
      skipDangerousModePermissionPrompt: true
    })
    expect(statSync(settings).mode & 0o777).toBe(0o644)
  })

  it('writes nothing a second time', () => {
    const { settings } = scratch()
    acceptBypassConsent(settings)
    const before = readFileSync(settings, 'utf8')
    expect(acceptBypassConsent(settings)).toBe('already-accepted')
    expect(readFileSync(settings, 'utf8')).toBe(before)
  })

  it('never rewrites a settings file it cannot read', () => {
    const { settings } = scratch()
    mkdirSync(path.dirname(settings), { recursive: true })
    writeFileSync(settings, '{ "theme": ')
    expect(bypassConsentState(settings)).toBe('unreadable')
    expect(acceptBypassConsent(settings)).toBe('skipped-unreadable')
    expect(readFileSync(settings, 'utf8')).toBe('{ "theme": ')
  })

  it('says not-yet before anything is written', () => {
    expect(bypassConsentState(scratch().settings)).toBe('not-yet')
  })
})

describe('claudeSignedInBy', () => {
  const none = { home: '/nowhere', env: {}, exists: () => false }
  it('reads an account, a saved key, a credentials file or a key in the environment', () => {
    expect(claudeSignedInBy({ oauthAccount: { emailAddress: 'a@b' } }, none)).toBe(true)
    expect(claudeSignedInBy({ primaryApiKey: 'sk-ant-x' }, none)).toBe(true)
    expect(claudeSignedInBy({}, { ...none, exists: (f) => f === '/nowhere/.claude/.credentials.json' })).toBe(true)
    expect(claudeSignedInBy({}, { ...none, env: { CLAUDE_CODE_OAUTH_TOKEN: 't' } })).toBe(true)
    expect(claudeSignedInBy({}, { ...none, env: { ANTHROPIC_API_KEY: 'k' } })).toBe(true)
    expect(claudeSignedInBy({}, { ...none, env: { ANTHROPIC_API_KEY: '' } })).toBe(false)
    expect(claudeSignedInBy({}, none)).toBe(false)
  })
})

describe('completeOnboarding', () => {
  it('marks onboarding done for a signed-in Claude and keeps every other key', () => {
    const { claudeJson } = scratch()
    writeFileSync(claudeJson, JSON.stringify({ oauthAccount: { emailAddress: 'a@b' }, projects: { '/a': {} } }), { mode: 0o600 })
    expect(completeOnboarding(claudeJson, (config) => config.oauthAccount !== undefined)).toBe('completed')
    expect(JSON.parse(readFileSync(claudeJson, 'utf8'))).toEqual({
      oauthAccount: { emailAddress: 'a@b' },
      projects: { '/a': {} },
      hasCompletedOnboarding: true
    })
    expect(completeOnboarding(claudeJson, () => true)).toBe('already-completed')
  })

  it('leaves the wizard to a Claude nobody signed in: its login is part of it', () => {
    const { claudeJson } = scratch()
    expect(completeOnboarding(claudeJson, () => false)).toBe('not-signed-in')
    expect(existsSync(claudeJson)).toBe(false)
  })

  it('never rewrites a config it cannot read', () => {
    const { claudeJson } = scratch()
    writeFileSync(claudeJson, 'nope')
    expect(completeOnboarding(claudeJson, () => true)).toBe('skipped-unreadable')
    expect(readFileSync(claudeJson, 'utf8')).toBe('nope')
  })
})
