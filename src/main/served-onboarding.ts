import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { confine } from './session-sandbox'
import type { SessionProvisioner } from './session-instantiator-adapters'

/**
 * FIRST BOOT INSIDE A SERVED HOME.
 *
 * Claude 2.1.241's own disposable evaluation bootstrap uses the three root
 * fields below. Disposable first runs separately proved the theme and exact
 * per-project trust record. Without them, the caller's first prompt is typed
 * into the theme / trust wizard and no harness session is made.
 *
 * These are choices and, only for an explicitly granted key, Claude's 20-char
 * approval fingerprint. No credential is persisted here. In particular, this
 * module must never consult or copy the owner's ~/.claude.json. Codex's empty
 * HOME gate is authentication itself, which belongs in an explicit owner
 * grant, not a fabricated seed. Pi 0.84.3 has no persisted first-run wizard;
 * its theme and session behavior are command-line settings. Therefore only
 * Claude gets state here.
 */

const CLAUDE_ONBOARDING_BASE = Object.freeze({
  hasCompletedOnboarding: true,
  autoUpdates: false,
  // Served Claude is already launched with --permission-mode bypassPermissions
  // inside Cookrew's external sandbox. This acknowledges that existing choice.
  bypassPermissionsModeAccepted: true
})

export const CLAUDE_SETTINGS = Object.freeze({ theme: 'dark' })

/**
 * Claude 2.1.241's load-bearing project-trust bit. A disposable acceptance also
 * materialized empty MCP/tool arrays and false include-warning defaults; those
 * are ordinary defaults, not onboarding choices, so the minimal seed omits them.
 */
export const CLAUDE_PROJECT_TRUST = Object.freeze({
  hasTrustDialogAccepted: true
})

/** Trust exactly this served HOME/cwd, canonicalized before it becomes a key. */
export function claudeOnboardingFor(
  sandbox: string,
  approvedApiKeySuffix?: string
): Record<string, unknown> {
  const root = realpathSync(sandbox)
  const approval = approvedApiKeySuffix?.trim().slice(-20)
  // Equality is deliberate: the project is the sandbox root itself. Resolving
  // first collapses symlink and `..` spellings, so no caller-supplied alias can
  // smuggle a second trusted project into the dynamic map.
  if (confine(root, root) !== root) throw new Error('Claude project trust escaped the session sandbox')
  return {
    ...CLAUDE_ONBOARDING_BASE,
    projects: { [root]: { ...CLAUDE_PROJECT_TRUST } },
    ...(approval
      ? { customApiKeyResponses: { approved: [approval] } }
      : {})
  }
}

/** The grant queries provisioning needs, kept narrow so composition is testable. */
export interface GrantProvisioner {
  provision(serviceId: string, sandbox: string): void
  envKeysFor(serviceId: string): readonly string[]
  ownerEnvFor(serviceId: string): Record<string, string | undefined>
}

/**
 * Seed harness choices, then lay down the owner's explicit grant. Seeding first
 * means a later failure has not spent the grant budget; an owner-granted config
 * may still replace the defaults deliberately.
 */
export function servedSessionProvisioner(grants: GrantProvisioner): SessionProvisioner {
  return {
    provision(serviceId, sandbox) {
      let approvedApiKeySuffix: string | undefined
      // An ambient owner key is not a grant. Consult its VALUE only after the
      // grant names it explicitly; then persist only Claude's 20-char approval
      // fingerprint, never the key itself.
      if (grants.envKeysFor(serviceId).includes('ANTHROPIC_API_KEY')) {
        const value = grants.ownerEnvFor(serviceId).ANTHROPIC_API_KEY?.trim()
        if (value) approvedApiKeySuffix = value.slice(-20)
      }
      seedClaudeOnboarding(sandbox, approvedApiKeySuffix)
      grants.provision(serviceId, sandbox)
    }
  }
}

/** Write only absent files. Existing session/user state is byte-for-byte owned by its writer. */
export function seedClaudeOnboarding(sandbox: string, approvedApiKeySuffix?: string): void {
  const root = realpathSync(sandbox)
  const rootConfig = confine(root, '.claude.json')
  const claudeDir = confine(root, '.claude')
  if (rootConfig === null || claudeDir === null) throw new Error('Claude seed escaped the session sandbox')

  writeIfAbsent(rootConfig, claudeOnboardingFor(root, approvedApiKeySuffix))
  mkdirSync(claudeDir, { recursive: true, mode: 0o700 })

  // Resolve after mkdir: an existing `.claude` symlink must not redirect the
  // settings write outside HOME. A fresh directory resolves inside `root`.
  const resolvedClaudeDir = realpathSync(claudeDir)
  if (confine(root, resolvedClaudeDir) === null) {
    throw new Error('Claude settings directory escaped the session sandbox')
  }
  writeIfAbsent(path.join(resolvedClaudeDir, 'settings.json'), CLAUDE_SETTINGS)
}

function writeIfAbsent(file: string, value: unknown): void {
  try {
    writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return
    throw error
  }
}
