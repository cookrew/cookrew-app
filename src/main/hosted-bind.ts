// HOSTED ACP AGENTS: WHERE THEIR SESSIONS LIVE AND HOW A CARD BINDS ONE
// (harness expansion P4; the host is cli/cookrew-acp.mjs).
//
// The host writes ~/.cookrew/hosted/<agent>/<session>.jsonl and holds it open
// while that session is its own, so the card binds to the transcript its pane
// process holds (lsof, the codex/opencode/agy recipe; contract rule 3). A
// /new in the host closes one file and opens the next: the sweep follows it.
// Resume is `--resume <session>` on the host's line, which the host turns into
// ACP session/resume.
//
// DeepSeek Harness (the first hosted agent) keeps its own copy of a session
// in ~/.dsh/sessions/--<cwd>--/<id>/ and refuses to resume it from any other
// folder (measured 2026-11-28: "session cwd does not match").

import { existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { realCwd } from './claude-fork'
import { defaultOpenFiles, type OpenFilesReader } from './codex-bind'
import { processTree, type ChildPids } from './devin-bind'

/** An ACP session id as the host accepts it (dsh: a UUID): the check before a path or a shell line. */
const SESSION_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const AGENT_RE = /^[a-z0-9][a-z0-9-]{0,31}$/

export function validHostedSessionId(value: unknown): value is string {
  return typeof value === 'string' && SESSION_RE.test(value) && !value.includes('..')
}

export function hostedDir(agent: string, home = process.env.HOME || homedir()): string {
  if (!AGENT_RE.test(agent)) throw new Error(`not a hosted agent name: ${agent}`)
  return path.join(home, '.cookrew', 'hosted', agent)
}

export function hostedTranscriptFile(agent: string, id: string, home?: string): string {
  return path.join(hostedDir(agent, home), `${id}.jsonl`)
}

/** The session a transcript path belongs to, or undefined for any other path. */
export function hostedSessionOfFile(file: string): string | undefined {
  if (path.basename(path.dirname(path.dirname(file))) !== 'hosted' || !file.endsWith('.jsonl')) return undefined
  const id = path.basename(file, '.jsonl')
  return validHostedSessionId(id) ? id : undefined
}

/** The session whose transcript is among these open files, or null. The dir as written and as resolved (lsof prints the second). */
export function hostedSessionFromOpenFiles(files: readonly string[], dir: string): string | null {
  const dirs = [...new Set([dir, realCwd(dir)])].map((d) => d + path.sep)
  for (const file of files) {
    if (!file.endsWith('.jsonl')) continue
    const inDir = dirs.find((d) => file.startsWith(d) && !file.slice(d.length).includes(path.sep))
    if (!inDir) continue
    const id = path.basename(file, '.jsonl')
    if (validHostedSessionId(id)) return id
  }
  return null
}

/** The session the host under `pid` holds open, or null (not booted, not the host). */
export function resolveHostedSessionByPid(
  agent: string,
  pid: number | null,
  readOpenFiles: OpenFilesReader = defaultOpenFiles,
  children?: ChildPids,
  home?: string
): string | null {
  if (pid === null || !Number.isFinite(pid) || pid <= 0) return null
  const dir = hostedDir(agent, home)
  for (const p of processTree(pid, children)) {
    const id = hostedSessionFromOpenFiles(readOpenFiles(p), dir)
    if (id) return id
  }
  return null
}

/** The transcript SessionTurnSync polls for a bound card, or null. */
export function hostedWatchFile(agent: string, id: unknown, home?: string): string | null {
  return validHostedSessionId(id) ? hostedTranscriptFile(agent, id, home) : null
}

/** A transcript written after the bound one: the hint that the host moved to a new session. */
export function hostedNewerTranscript(agent: string, bound: string, home?: string): boolean {
  try {
    const dir = hostedDir(agent, home)
    const since = statSync(path.join(dir, `${bound}.jsonl`)).mtimeMs
    return readdirSync(dir).some((name) => name.endsWith('.jsonl') && name !== `${bound}.jsonl` && statSync(path.join(dir, name)).mtimeMs > since)
  } catch {
    return false
  }
}

const VALUE_FLAGS_RE = /\s+--resume(?:=\S+|\s+(?!-)\S+)?(?=\s|$)/g

/** The host's line without the session it resumes: what a copy keeps. */
export function stripHostedSessionFlags(command: string): string {
  return command.replace(VALUE_FLAGS_RE, '').trim()
}

export function hostedResumeCommand(command: string, id: string): string {
  return `${stripHostedSessionFlags(command)} --resume ${id}`
}

/** dsh's own copy of a session, which session/resume reads: ~/.dsh/sessions/<cwd slug>/<id>/. */
export function dshSessionExists(id: string, dshHome = process.env.DSH_HOME || path.join(homedir(), '.dsh')): boolean {
  if (!validHostedSessionId(id)) return false
  const root = path.join(dshHome, 'sessions')
  try {
    return readdirSync(root).some((slug) => existsSync(path.join(root, slug, id)))
  } catch {
    return false
  }
}
