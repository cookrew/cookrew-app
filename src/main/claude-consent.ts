// THE OWNER'S CLAUDE, READY FOR A CARD NOBODY TYPES INTO FIRST.
//
// Cookrew starts the owner's Claude cards with --permission-mode
// bypassPermissions (the owner's ruling). A Claude that never accepted that mode
// opens on "By proceeding, you accept all responsibility... No, exit / Yes, I
// accept"; the first prompt delivered to the card answered it and claude exited 1
// (Solis, 2026-11-09). Claude 2.1.x keeps that acceptance as
// skipDangerousModePermissionPrompt in the USER settings, ~/.claude/settings.json:
// its own dialog writes exactly that key there, and the older
// bypassPermissionsModeAccepted in ~/.claude.json is only migrated into it (read
// off 2.1.316). served-onboarding.ts does the same for a served HOME.
//
// A fresh Claude also opens on its onboarding wizard (theme, notes, sign-in),
// which eats a delivered prompt the same way. hasCompletedOnboarding in
// ~/.claude.json skips it, and the theme then defaults to dark. The wizard holds
// the sign-in, so it is skipped only for a Claude that is already signed in.

import path from 'node:path'
import { readConfigObject, updateConfigObject, type ConfigObject, type ConfigRead } from './claude-config-file'

export type ConsentOutcome = 'accepted' | 'already-accepted' | 'skipped-unreadable' | 'failed'
export type OnboardingOutcome = 'completed' | 'already-completed' | 'not-signed-in' | 'skipped-unreadable' | 'failed'

const CONSENT_KEY = 'skipDangerousModePermissionPrompt'
const BYPASS = /(?:^|\s)(?:--permission-mode(?:\s+|=)bypassPermissions|--dangerously-skip-permissions)(?=\s|$)/
/** Keys a pane inherits that sign Claude in on their own. */
const SIGN_IN_KEYS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'] as const

/** Does this command start Claude in bypass permissions? */
export function runsBypassPermissions(command: string): boolean {
  return BYPASS.test(command)
}

/** What the settings say, by a read already made: the line Setup shows. */
export function consentOf(read: ConfigRead): 'accepted' | 'not-yet' | 'unreadable' {
  if (read.state === 'unreadable') return 'unreadable'
  return read.state === 'ok' && read.value[CONSENT_KEY] === true ? 'accepted' : 'not-yet'
}

/** What the settings say now. */
export function bypassConsentState(settingsJson: string): 'accepted' | 'not-yet' | 'unreadable' {
  return consentOf(readConfigObject(settingsJson))
}

/** Accept bypass permissions the way Claude's own dialog does. Idempotent. */
export function acceptBypassConsent(settingsJson: string): ConsentOutcome {
  const outcome = updateConfigObject(settingsJson, (settings) =>
    settings[CONSENT_KEY] === true ? null : { ...settings, [CONSENT_KEY]: true }
  )
  if (outcome === 'unreadable') return 'skipped-unreadable'
  return outcome === 'written' ? 'accepted' : outcome === 'unchanged' ? 'already-accepted' : 'failed'
}

export interface SignInEvidence {
  home: string
  /** What the panes inherit. */
  env: Readonly<Record<string, string | undefined>>
  exists: (file: string) => boolean
}

/**
 * Can this Claude work without its wizard? An account or a saved key in its
 * config, its credentials file (Linux), or a key every pane inherits. On a Mac
 * the sign-in itself sits in the Keychain, and the account beside it in the config.
 */
export function claudeSignedInBy(config: ConfigObject, evidence: SignInEvidence): boolean {
  const account = config.oauthAccount
  if (typeof account === 'object' && account !== null) return true
  if (typeof config.primaryApiKey === 'string' && config.primaryApiKey.length > 0) return true
  if (evidence.exists(path.join(evidence.home, '.claude', '.credentials.json'))) return true
  return SIGN_IN_KEYS.some((key) => Boolean(evidence.env[key]))
}

/** Skip the onboarding wizard of a Claude that is signed in. Idempotent. */
export function completeOnboarding(claudeJson: string, signedIn: (config: ConfigObject) => boolean): OnboardingOutcome {
  let unsigned = false
  const outcome = updateConfigObject(claudeJson, (config) => {
    unsigned = false
    if (config.hasCompletedOnboarding === true) return null
    if (!signedIn(config)) {
      unsigned = true
      return null
    }
    return { ...config, hasCompletedOnboarding: true }
  })
  if (outcome === 'unreadable') return 'skipped-unreadable'
  if (outcome === 'written') return 'completed'
  if (outcome === 'failed') return 'failed'
  return unsigned ? 'not-signed-in' : 'already-completed'
}
