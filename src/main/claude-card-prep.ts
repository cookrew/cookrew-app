// BEFORE ONE OF THE OWNER'S CLAUDE CARDS STARTS: THE THREE QUESTIONS A FRESH
// CLAUDE ASKS, ANSWERED WHERE THE OWNER ALREADY ANSWERED THEM.
//
// Solis, 2026-11-09: a freshly installed Claude stopped a recruited card twice,
// once on "Is this a project you trust?" (67 s, then the dispatch gave up, and
// nothing said why) and once on the bypass-permissions notice (the delivered
// prompt answered "No, exit"). The owner's rulings:
//
//   trust     the folder a person chose for a workspace is trusted, at create and
//             at spawn (older workspaces). A home folder, the root, or anything
//             above home never silently: the card says so instead of hanging,
//             and the person answers once (the card's button, `cookrew trust`).
//   consent   the owner's cards run bypass permissions, so its notice is
//             accepted for them (claude-consent.ts).
//   wizard    skipped for a Claude that is signed in; its sign-in lives in it.
//
// Reads go through a cache keyed on each file's stamp: a fleet booting at once
// and a sweep over offline cards must not parse a config of megabytes per card,
// and an entry Claude dropped since is seen and written again. Served cards never
// come here: their HOME is their own (served-onboarding.ts).

import { existsSync, realpathSync } from 'node:fs'
import path from 'node:path'
import type { LaunchFailure } from '../shared/launch-failure'
import { CachedConfig } from './claude-config-file'
import {
  acceptBypassConsent,
  claudeSignedInBy,
  completeOnboarding,
  consentOf,
  runsBypassPermissions,
  type ConsentOutcome,
  type OnboardingOutcome
} from './claude-consent'
import { entryTrusted, isBroadFolder, trustDirectory, trustOf, type TrustOutcome } from './claude-trust'
import { untrustedFolderFailure } from './launch-check'

export interface ClaudeCardPrepDeps {
  home: string
  /** What the panes inherit: a key there signs Claude in, CLAUDE_CONFIG_DIR moves its files. */
  env: Readonly<Record<string, string | undefined>>
  exists?: (file: string) => boolean
}

export interface PrepReport {
  /** broad: home or above, left to the person. outside: no workspace's folder. */
  trust: TrustOutcome | 'broad' | 'outside'
  consent: ConsentOutcome | 'not-bypass'
  onboarding: OnboardingOutcome
}

/** Where Claude keeps its global config and its user settings for these panes. */
export function claudeConfigPaths(home: string, env: Readonly<Record<string, string | undefined>>): { claudeJson: string; settingsJson: string } {
  const dir = env.CLAUDE_CONFIG_DIR?.trim()
  if (dir) return { claudeJson: path.join(dir, '.claude.json'), settingsJson: path.join(dir, 'settings.json') }
  return { claudeJson: path.join(home, '.claude.json'), settingsJson: path.join(home, '.claude', 'settings.json') }
}

/** A folder as the OS resolves it; as given when it cannot be read. */
export function realDir(dir: string): string {
  try {
    return realpathSync(dir)
  } catch {
    return path.resolve(dir)
  }
}

function within(dir: string, parent: string): boolean {
  return dir === parent || dir.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep)
}

export class ClaudeCardPrep {
  private readonly home: string
  private readonly cache = new CachedConfig()
  readonly claudeJson: string
  readonly settingsJson: string

  constructor(private readonly deps: ClaudeCardPrepDeps) {
    this.home = realDir(deps.home)
    const paths = claudeConfigPaths(deps.home, deps.env)
    this.claudeJson = paths.claudeJson
    this.settingsJson = paths.settingsJson
  }

  /**
   * Is `dir` a folder this module trusts on its own: inside a folder a workspace
   * was given, and not broad itself? A workspace whose folder IS home (the default
   * one) lends nothing: under it, every project would be trusted unasked.
   */
  private trustable(dir: string, workspaceDirs: readonly string[]): boolean {
    if (isBroadFolder(dir, this.home)) return false
    return workspaceDirs.map(realDir).some((w) => !isBroadFolder(w, this.home) && within(dir, w))
  }

  /**
   * What stops a Claude card starting in `cwd`: a folder Claude would ask about
   * and nobody here will answer. Null when prepare() trusts it, Claude already
   * does, or the config cannot be read (a false alarm costs more than silence).
   */
  folderBlock(cwd: string, workspaceDirs: readonly string[], cardName = 'Agent'): LaunchFailure | null {
    const dir = realDir(cwd)
    if (this.trustable(dir, workspaceDirs)) return null
    const read = this.cache.read(this.claudeJson)
    // Either spelling Claude might key on: /tmp is a symlink on a Mac.
    for (const spelling of new Set([dir, path.resolve(cwd)])) {
      if (trustOf(read, spelling) !== 'untrusted') return null
    }
    return untrustedFolderFailure(dir, this.home, cardName)
  }

  /** Answer what a fresh Claude would ask, before a card of the owner's starts in `cwd`. */
  prepare(command: string, cwd: string, workspaceDirs: readonly string[]): PrepReport {
    return {
      trust: this.trustFolder(realDir(cwd), workspaceDirs),
      consent: runsBypassPermissions(command) ? this.consent() : 'not-bypass',
      onboarding: this.onboarding()
    }
  }

  /** The person said yes, on the card or with `cookrew trust`: home included. */
  trustChosen(cwd: string): TrustOutcome {
    return trustDirectory(realDir(cwd), this.claudeJson)
  }

  /**
   * A folder a person chose for a new workspace. Nothing is written for a Claude
   * never run here (no config yet): the first card's prepare() trusts it then.
   */
  trustWorkspaceFolder(folder: string): TrustOutcome | 'broad' | 'no-claude' {
    const dir = realDir(folder)
    if (isBroadFolder(dir, this.home)) return 'broad'
    if (!existsSync(this.claudeJson)) return 'no-claude'
    return entryTrusted(this.cache.read(this.claudeJson), dir) ? 'already-trusted' : trustDirectory(dir, this.claudeJson)
  }

  private trustFolder(dir: string, workspaceDirs: readonly string[]): PrepReport['trust'] {
    if (isBroadFolder(dir, this.home)) return 'broad'
    if (!this.trustable(dir, workspaceDirs)) return 'outside'
    if (entryTrusted(this.cache.read(this.claudeJson), dir)) return 'already-trusted'
    return trustDirectory(dir, this.claudeJson)
  }

  private consent(): ConsentOutcome {
    if (consentOf(this.cache.read(this.settingsJson)) === 'accepted') return 'already-accepted'
    return acceptBypassConsent(this.settingsJson)
  }

  private onboarding(): OnboardingOutcome {
    const read = this.cache.read(this.claudeJson)
    if (read.state === 'ok' && read.value.hasCompletedOnboarding === true) return 'already-completed'
    const evidence = { home: this.deps.home, env: this.deps.env, exists: this.deps.exists ?? existsSync }
    if (read.state === 'ok' && !claudeSignedInBy(read.value, evidence)) return 'not-signed-in'
    return completeOnboarding(this.claudeJson, (config) => claudeSignedInBy(config, evidence))
  }
}
