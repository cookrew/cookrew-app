// Pre-trust a working directory, so a Claude Code card started there does not
// stop at the first-run trust dialog.
//
// Claude keeps the trust decision per directory in the `projects` map of the
// user's ~/.claude.json, and walks up from its folder to find one. This module
// adds exactly one entry for one directory and leaves every other key untouched
// (claude-config-file.ts). Which directories may be trusted is the caller's
// business: claude-card-prep.ts for owner cards, the chores dir, the first-run
// pick.

import { existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { readConfigObject, updateConfigObject, type ConfigObject, type ConfigRead } from './claude-config-file'

export type TrustOutcome = 'trusted' | 'already-trusted' | 'skipped-unreadable' | 'failed'

type Projects = Record<string, Record<string, unknown>>

function projectsOf(config: ConfigObject): Projects {
  const projects = config.projects
  return typeof projects === 'object' && projects !== null && !Array.isArray(projects) ? (projects as Projects) : {}
}

/** Mark `dir` as trusted in the Claude config at `claudeJson`. Idempotent. */
export function trustDirectory(dir: string, claudeJson: string): TrustOutcome {
  const outcome = updateConfigObject(claudeJson, (config) => {
    const projects = projectsOf(config)
    const entry = projects[dir] ?? {}
    if (entry.hasTrustDialogAccepted === true) return null
    return { ...config, projects: { ...projects, [dir]: { ...entry, hasTrustDialogAccepted: true } } }
  })
  if (outcome === 'unreadable') return 'skipped-unreadable'
  return outcome === 'written' ? 'trusted' : outcome === 'unchanged' ? 'already-trusted' : 'failed'
}

/**
 * Would Claude find `dir` trusted, by a config already read? It walks up from
 * its folder, so a trusted parent answers for the child. Walking all the way up
 * can only say "trusted" where Claude might still ask, which errs toward saying
 * nothing.
 */
export function trustOf(read: ConfigRead, dir: string): 'trusted' | 'untrusted' | 'unreadable' {
  if (read.state === 'unreadable') return 'unreadable'
  if (read.state === 'absent') return 'untrusted'
  const projects = projectsOf(read.value)
  for (let at = path.resolve(dir); ; at = path.dirname(at)) {
    if (projects[at]?.hasTrustDialogAccepted === true) return 'trusted'
    if (path.dirname(at) === at) return 'untrusted'
  }
}

/** trustOf, reading the file now. */
export function directoryTrust(dir: string, claudeJson: string): 'trusted' | 'untrusted' | 'unreadable' {
  return trustOf(readConfigObject(claudeJson), dir)
}

/** Is exactly this folder's own entry trusted (no walk)? What prepare writes. */
export function entryTrusted(read: ConfigRead, dir: string): boolean {
  return read.state === 'ok' && projectsOf(read.value)[dir]?.hasTrustDialogAccepted === true
}

/**
 * The home folder, the root, or a folder above home: trusting one trusts every
 * project under it, so it is never done without the person saying so. Both
 * paths are real paths.
 */
export function isBroadFolder(dir: string, home: string): boolean {
  const at = path.resolve(dir)
  const root = path.parse(at).root
  if (at === root || at === path.resolve(home)) return true
  return path.resolve(home).startsWith(at.endsWith(path.sep) ? at : at + path.sep)
}

/** Create the chores directory if needed (0700), then pre-trust it. */
export function prepareChoresDir(dir: string, claudeJson: string): TrustOutcome {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
  return trustDirectory(dir, claudeJson)
}
