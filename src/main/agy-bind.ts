// ANTIGRAVITY CLI (agy) SESSION INTEGRATION (harness expansion P2).
//
// Facts read off agy 1.5.18 on this machine (2026-11-26/27; captures in
// ~/.cookrew/captures/2026-11-26/agy):
//  - A conversation is a lowercase UUID. Its transcript is
//    <data>/brain/<id>/.system_generated/logs/transcript.jsonl, its store
//    <data>/conversations/<id>.db, <data> = ~/.gemini/antigravity-cli (fixed:
//    no flag or env moves it).
//  - From the FIRST turn the agy process holds <data>/presence/<id>.lock open
//    for as long as that conversation is its own — the deterministic bind
//    (lsof of the pane pid, the codex/opencode recipe; contract rule 3). Before
//    the first turn there is no conversation and nothing to bind.
//  - `--conversation <id>` (aliases -r, --resume) resumes one; -c/--continue
//    resumes the cwd's latest, which is a guess and is stripped from copies.
//  - `--settings '<json>'` sets settings.json keys for this session only and
//    never saves them: the card's folder is trusted and agy renders inline
//    there, with nothing written to the person's own settings.

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { realCwd } from './claude-fork'
import { defaultOpenFiles, type OpenFilesReader } from './codex-bind'
import { shellQuote } from './shell-quote'

const CONVERSATION_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export function defaultAgyDataDir(): string {
  return path.join(homedir(), '.gemini', 'antigravity-cli')
}

/** A conversation id in agy's closed alphabet — the check before it reaches a path or a shell line. */
export function validAgyConversationId(value: unknown): value is string {
  return typeof value === 'string' && CONVERSATION_RE.test(value)
}

export function agyTranscriptFile(id: string, dataDir = defaultAgyDataDir()): string {
  return path.join(dataDir, 'brain', id, '.system_generated', 'logs', 'transcript.jsonl')
}

/** The conversation a transcript path belongs to, or undefined for any other path. */
export function agyConversationOfFile(file: string): string | undefined {
  const parts = file.split(path.sep)
  const at = parts.lastIndexOf('brain')
  const id = at >= 0 ? parts[at + 1] : undefined
  return validAgyConversationId(id) ? id : undefined
}

/** The conversation whose presence lock is among these open files, or null. */
export function agyConversationFromOpenFiles(files: readonly string[], dataDir = defaultAgyDataDir()): string | null {
  // lsof names the RESOLVED file: a ~/.gemini that is a symlink (dotfiles)
  // must still match, so the data dir is taken as written and as resolved.
  const presence = [...new Set([dataDir, realCwd(dataDir)])].map((dir) => path.join(dir, 'presence') + path.sep)
  for (const file of files) {
    if (!presence.some((dir) => file.startsWith(dir)) || !file.endsWith('.lock')) continue
    const id = path.basename(file, '.lock')
    if (validAgyConversationId(id)) return id
  }
  return null
}

/** The conversation the agy process at `pid` holds, or null (not booted, no turn yet, not agy). */
export function resolveAgyConversationByPid(pid: number | null, readOpenFiles: OpenFilesReader = defaultOpenFiles): string | null {
  if (pid === null || !Number.isFinite(pid) || pid <= 0) return null
  return agyConversationFromOpenFiles(readOpenFiles(pid))
}

export function agyConversationExists(id: string, dataDir = defaultAgyDataDir()): boolean {
  return validAgyConversationId(id) && existsSync(path.join(dataDir, 'conversations', `${id}.db`))
}

/** The transcript SessionTurnSync polls for a bound card, or null. */
export function agyWatchFile(node: { agySessionId?: string | null }, options: { agyDataDir?: string } = {}): string | null {
  const id = node.agySessionId
  return validAgyConversationId(id) ? agyTranscriptFile(id, options.agyDataDir) : null
}

const VALUE_FLAGS_RE = /\s+(?:--conversation|--resume|-r|--settings)(?:=(?:"[^"]*"|'[^']*'|\S*)|\s+(?!-)(?:"[^"]*"|'[^']*'|\S+))/g
const SWITCH_FLAGS_RE = /\s+(?:--continue|-c)(?=\s|$)/g

/**
 * The launch line with every session binding removed: which conversation to
 * resume, and the session-only settings Cookrew adds at each spawn.
 */
export function stripAgySessionFlags(command: string): string {
  return command.replace(VALUE_FLAGS_RE, '').replace(SWITCH_FLAGS_RE, '').trim()
}

export function agyResumeCommand(command: string, id: string): string {
  return `${stripAgySessionFlags(command)} --conversation ${id}`
}

/**
 * The card's own session settings, added at every spawn: its folder trusted
 * (agy otherwise stops on "Do you trust this folder?" with nobody to answer)
 * and inline rendering, which the LIVE view scrolls (the codex-inline rule).
 * A line that already names --settings keeps its own.
 */
export function agySessionLine(command: string, cwd: string): string {
  if (/\s--settings(?:[=\s]|$)/.test(command)) return command
  // agy checks the folder as the pane was given it, not resolved (measured: a
  // card in /tmp was asked to trust /tmp/… with /private/tmp/… trusted), so
  // both spellings are trusted.
  const folders = [...new Set([cwd, realCwd(cwd)])]
  const settings = JSON.stringify({ trustedWorkspaces: folders, altScreenMode: 'never' })
  return `${command} --settings ${shellQuote(settings)}`
}

/**
 * agy's own note of the newest conversation in a folder
 * (<data>/cache/last_conversations.json, keyed by the folder as it was
 * typed or as resolved), or null. A HINT, never a binding: two cards in one
 * folder share it. A hint that differs from a card's binding is what makes
 * the follow pay for an lsof of the pane (index.ts · followHeldAgyConversation).
 */
export function agyLastConversation(cwd: string, dataDir = defaultAgyDataDir()): string | null {
  try {
    const index = JSON.parse(readFileSync(path.join(dataDir, 'cache', 'last_conversations.json'), 'utf8')) as Record<string, unknown>
    const id = index[cwd] ?? index[realCwd(cwd)]
    return validAgyConversationId(id) ? id : null
  } catch {
    return null
  }
}
