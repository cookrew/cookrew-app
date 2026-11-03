// Pre-trust a working directory Cookrew creates for its own use, so a
// Claude Code card started there does not stop at the first-run trust dialog.
//
// Claude keeps the trust decision per directory in the `projects` map of the
// user's ~/.claude.json. This module adds exactly one entry for one directory
// and leaves every other key untouched. An unreadable or malformed file is
// never rewritten: a card that then shows the dialog is better than a config
// that Claude cannot load.

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'

export type TrustOutcome = 'trusted' | 'already-trusted' | 'skipped-unreadable' | 'failed'

interface ClaudeConfig {
  projects?: Record<string, Record<string, unknown>>
  [key: string]: unknown
}

/** Mark `dir` as trusted in the Claude config at `claudeJson`. Idempotent. */
export function trustDirectory(dir: string, claudeJson: string): TrustOutcome {
  let config: ClaudeConfig = {}
  let mode = 0o600
  if (existsSync(claudeJson)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(claudeJson, 'utf8'))
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return 'skipped-unreadable'
      config = parsed as ClaudeConfig
      mode = statSync(claudeJson).mode & 0o777
    } catch {
      return 'skipped-unreadable'
    }
  }
  const projects = config.projects ?? {}
  const entry = projects[dir] ?? {}
  if (entry.hasTrustDialogAccepted === true) return 'already-trusted'
  const next: ClaudeConfig = {
    ...config,
    projects: { ...projects, [dir]: { ...entry, hasTrustDialogAccepted: true } }
  }
  try {
    const tmp = `${claudeJson}.${process.pid}.tmp`
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode })
    renameSync(tmp, claudeJson)
    return 'trusted'
  } catch {
    return 'failed'
  }
}

/** Create the chores directory if needed (0700), then pre-trust it. */
export function prepareChoresDir(dir: string, claudeJson: string): TrustOutcome {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
  return trustDirectory(dir, claudeJson)
}
