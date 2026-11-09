// READ AND WRITE ONE OF CLAUDE'S OWN JSON FILES WITHOUT HURTING IT.
//
// ~/.claude.json and ~/.claude/settings.json belong to Claude Code. Cookrew adds a
// key now and then (claude-trust.ts, claude-consent.ts) and must leave the rest
// as it found it:
//
//   - a file that does not parse as one JSON object is never rewritten: a card
//     that then shows Claude's dialog is better than a config Claude cannot load;
//   - a symlinked file (dotfiles managers) is written through to its target, never
//     replaced by a plain file beside it;
//   - live Claude processes rewrite ~/.claude.json too, so a file that changed
//     between the read and the rename is read and changed again, not overwritten.

import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export type ConfigObject = Record<string, unknown>

export type ConfigRead =
  | { state: 'absent' }
  | { state: 'unreadable' }
  | { state: 'ok'; value: ConfigObject; mode: number; stamp: string }

export type UpdateOutcome = 'written' | 'unchanged' | 'unreadable' | 'failed'

/** A new file is the owner's alone, like Claude's own. */
const NEW_FILE_MODE = 0o600
const NEW_DIR_MODE = 0o700
/** Reads before giving up on a file something else keeps rewriting. */
const UPDATE_TRIES = 3

/** What a write lands on: a symlink's target, so the link stays a link. */
function targetOf(file: string): string {
  try {
    return lstatSync(file).isSymbolicLink() ? realpathSync(file) : file
  } catch {
    return file
  }
}

/** Size and time of the last change: a different stamp is a different file. */
function stampOf(file: string): string | null {
  try {
    const stat = statSync(file)
    return `${stat.mtimeMs}:${stat.size}:${stat.ino}`
  } catch {
    return null
  }
}

export function readConfigObject(file: string): ConfigRead {
  if (!existsSync(file)) return { state: 'absent' }
  try {
    const stamp = stampOf(file) ?? ''
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { state: 'unreadable' }
    return { state: 'ok', value: parsed as ConfigObject, mode: statSync(file).mode & 0o777, stamp }
  } catch {
    return { state: 'unreadable' }
  }
}

/**
 * Change one config: `change` gets what the file holds now ({} when absent) and
 * answers the whole next object, or null for "nothing to do". Replaced in one
 * rename, so Claude never reads half of it.
 */
export function updateConfigObject(file: string, change: (current: ConfigObject) => ConfigObject | null): UpdateOutcome {
  const target = targetOf(file)
  for (let attempt = 0; attempt < UPDATE_TRIES; attempt++) {
    const read = readConfigObject(target)
    if (read.state === 'unreadable') return 'unreadable'
    const next = change(read.state === 'ok' ? read.value : {})
    if (next === null) return 'unchanged'
    const written = writeIfUnchanged(target, next, read)
    if (written !== 'raced') return written
  }
  return 'failed'
}

function writeIfUnchanged(target: string, next: ConfigObject, read: ConfigRead): 'written' | 'failed' | 'raced' {
  const tmp = `${target}.${process.pid}.tmp`
  try {
    const dir = path.dirname(target)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: NEW_DIR_MODE })
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: read.state === 'ok' ? read.mode : NEW_FILE_MODE })
    // Someone wrote it since the read (a Claude saving its own state): start over from theirs.
    if (stampOf(target) !== (read.state === 'ok' ? read.stamp : null)) {
      removeQuietly(tmp)
      return 'raced'
    }
    renameSync(tmp, target)
    return 'written'
  } catch {
    removeQuietly(tmp)
    return 'failed'
  }
}

function removeQuietly(file: string): void {
  try {
    if (existsSync(file)) unlinkSync(file)
  } catch {
    // Nothing to do: a stray temp file beside a config hurts nobody.
  }
}

/**
 * The last read of a file, kept until its stamp changes: a launch sweep asks per
 * offline card, and ~/.claude.json runs to megabytes for a heavy user.
 */
export class CachedConfig {
  private readonly reads = new Map<string, { stamp: string | null; read: ConfigRead }>()

  read(file: string): ConfigRead {
    const stamp = stampOf(file)
    const known = this.reads.get(file)
    if (known && known.stamp === stamp) return known.read
    const read = readConfigObject(file)
    this.reads.set(file, { stamp, read })
    return read
  }
}
