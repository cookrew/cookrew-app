import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { makeMinter, type ForkEngine } from '../src/main/session-instantiator-adapters'
import { sessionIdentity } from '../src/main/session-identity'
import {
  CLAUDE_PROJECT_TRUST,
  CLAUDE_SETTINGS,
  claudeOnboardingFor,
  seedClaudeOnboarding,
  servedSessionProvisioner
} from '../src/main/served-onboarding'

const roots: string[] = []
const tempRoot = (): string => {
  const root = mkdtempSync(path.join(tmpdir(), 'served-onboarding-'))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('Claude served-session seed', () => {
  it('writes only the minimal current first-run choices, 0600, inside the sandbox', () => {
    const sandbox = tempRoot()
    seedClaudeOnboarding(sandbox)

    const config = path.join(sandbox, '.claude.json')
    const settings = path.join(sandbox, '.claude', 'settings.json')
    const trusted = realpathSync(sandbox)
    const onboarding = JSON.parse(readFileSync(config, 'utf8'))
    expect(onboarding).toEqual(claudeOnboardingFor(sandbox))
    expect(JSON.parse(readFileSync(settings, 'utf8'))).toEqual(CLAUDE_SETTINGS)
    expect(Object.keys(onboarding).sort()).toEqual([
      'autoUpdates',
      'bypassPermissionsModeAccepted',
      'hasCompletedOnboarding',
      'projects'
    ])
    expect(Object.keys(onboarding.projects)).toEqual([trusted])
    expect(onboarding.projects[trusted]).toEqual(CLAUDE_PROJECT_TRUST)
    expect(Object.keys(JSON.parse(readFileSync(settings, 'utf8')))).toEqual(['theme'])
    expect(lstatSync(config).mode & 0o777).toBe(0o600)
    expect(lstatSync(settings).mode & 0o777).toBe(0o600)

    // The Codex empty-HOME gate is auth and Pi has no onboarding state. Neither
    // may receive invented identity/config merely because Claude needs a seed.
    expect(existsSync(path.join(sandbox, '.codex'))).toBe(false)
    expect(existsSync(path.join(sandbox, '.pi'))).toBe(false)
  })

  it('canonicalizes the dynamic trust key and trusts no other project', () => {
    const root = tempRoot()
    const realSandbox = path.join(root, 'sandbox')
    const alias = path.join(root, 'alias')
    mkdirSync(realSandbox)
    symlinkSync(realSandbox, alias)

    const onboarding = claudeOnboardingFor(path.join(alias, '..', 'alias')) as {
      projects: Record<string, unknown>
    }
    const trusted = realpathSync(realSandbox)
    expect(Object.keys(onboarding.projects)).toEqual([trusted])
    expect(onboarding.projects[trusted]).toEqual(CLAUDE_PROJECT_TRUST)
    expect(onboarding.projects[alias]).toBeUndefined()
    expect(onboarding.projects[root]).toBeUndefined()
  })

  it('never overwrites existing user or granted state', () => {
    const sandbox = tempRoot()
    const claudeDir = path.join(sandbox, '.claude')
    mkdirSync(claudeDir)
    const config = path.join(sandbox, '.claude.json')
    const settings = path.join(claudeDir, 'settings.json')
    const existingConfig = '{"hasCompletedOnboarding":false,"owner":"kept"}\n'
    const existingSettings = '{"theme":"light","owner":"kept"}\n'
    writeFileSync(config, existingConfig, { mode: 0o640 })
    writeFileSync(settings, existingSettings, { mode: 0o640 })

    seedClaudeOnboarding(sandbox)

    expect(readFileSync(config, 'utf8')).toBe(existingConfig)
    expect(readFileSync(settings, 'utf8')).toBe(existingSettings)
    expect(lstatSync(config).mode & 0o777).toBe(0o640)
    expect(lstatSync(settings).mode & 0o777).toBe(0o640)
  })

  it('refuses an existing settings symlink that points outside the sandbox', () => {
    const root = tempRoot()
    const sandbox = path.join(root, 'sandbox')
    const outside = path.join(root, 'outside')
    mkdirSync(sandbox)
    mkdirSync(outside)
    symlinkSync(outside, path.join(sandbox, '.claude'))

    expect(() => seedClaudeOnboarding(sandbox)).toThrow(/escaped the session sandbox/)
    expect(existsSync(path.join(outside, 'settings.json'))).toBe(false)
  })
})

describe('served provision ordering', () => {
  it('seeds before the grant and exposes both to the fork boot', async () => {
    const base = tempRoot()
    const order: string[] = []
    const engine: ForkEngine = {
      fork: async (input) => {
        order.push('fork')
        expect(JSON.parse(readFileSync(path.join(input.dir, '.claude.json'), 'utf8'))).toEqual(
          claudeOnboardingFor(input.dir)
        )
        expect(JSON.parse(readFileSync(path.join(input.dir, '.claude', 'settings.json'), 'utf8'))).toEqual(
          CLAUDE_SETTINGS
        )
        expect(readFileSync(path.join(input.dir, 'granted.txt'), 'utf8')).toBe('lent')
        return 'ws-served'
      }
    }
    const provision = servedSessionProvisioner({
      envKeysFor: () => [],
      ownerEnvFor: () => ({}),
      provision(_serviceId, sandbox) {
        order.push('grant')
        // If this runs, the seed must already be visible through the same hook.
        expect(existsSync(path.join(sandbox, '.claude.json'))).toBe(true)
        writeFileSync(path.join(sandbox, 'granted.txt'), 'lent', { mode: 0o600 })
      }
    })
    const minter = makeMinter({ base, engine, provision })

    await expect(
      minter.mint({
        serviceId: 'svc',
        identity: sessionIdentity('svc', 'ana', 1),
        template: { templateId: 'tmpl', version: 1, pinAddress: 'sha256:x' }
      })
    ).resolves.toBe('ws-served')
    expect(order).toEqual(['grant', 'fork'])
  })

  it('approves only the suffix of an explicitly granted Anthropic key', async () => {
    const base = tempRoot()
    const synthetic = 'fake-prefix-that-must-not-land-abcdefghijklmnopqrst'
    const suffix = synthetic.trim().slice(-20)
    const provision = servedSessionProvisioner({
      envKeysFor: (serviceId) => {
        expect(serviceId).toBe('svc')
        return ['ANTHROPIC_API_KEY']
      },
      ownerEnvFor: (serviceId) => {
        expect(serviceId).toBe('svc')
        return { ANTHROPIC_API_KEY: `  ${synthetic}  ` }
      },
      provision: () => undefined
    })
    const minter = makeMinter({
      base,
      provision,
      engine: {
        fork: async (input) => {
          const raw = readFileSync(path.join(input.dir, '.claude.json'), 'utf8')
          const seeded = JSON.parse(raw)
          expect(seeded.customApiKeyResponses).toEqual({ approved: [suffix] })
          expect(raw).not.toContain('fake-prefix-that-must-not-land')
          return 'ws-approved'
        }
      }
    })

    await expect(
      minter.mint({
        serviceId: 'svc',
        identity: sessionIdentity('svc', 'keyed', 1),
        template: { templateId: 'tmpl', version: 1, pinAddress: 'sha256:x' }
      })
    ).resolves.toBe('ws-approved')
  })

  it('does not approve an ambient Anthropic key that the service was not granted', async () => {
    const base = tempRoot()
    let ownerEnvReads = 0
    const provision = servedSessionProvisioner({
      envKeysFor: () => [],
      ownerEnvFor: () => {
        ownerEnvReads++
        return { ANTHROPIC_API_KEY: 'ambient-fake-value-that-must-not-be-read' }
      },
      provision: () => undefined
    })
    const minter = makeMinter({
      base,
      provision,
      engine: {
        fork: async (input) => {
          const seeded = JSON.parse(readFileSync(path.join(input.dir, '.claude.json'), 'utf8'))
          expect(seeded.customApiKeyResponses).toBeUndefined()
          return 'ws-ungranted'
        }
      }
    })

    await expect(
      minter.mint({
        serviceId: 'svc',
        identity: sessionIdentity('svc', 'ambient', 1),
        template: { templateId: 'tmpl', version: 1, pinAddress: 'sha256:x' }
      })
    ).resolves.toBe('ws-ungranted')
    expect(ownerEnvReads).toBe(0)
  })
})
