import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  isPiCommand,
  latestPiSession,
  piFreshCommand,
  piLaunchBinding,
  piNodeSessionDir,
  piResumeCommand,
  piSessionDir,
  piSessionDirFromCommand,
  piSessionFile,
  piWatchFile,
  resolvePiSessionByPane,
  stripPiSessionFlags
} from '../src/main/pi-bind'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** A Pi session file as pi writes it: `<stamp>_<id>.jsonl`, header first. */
function writeSession(dir: string, cwd: string, id: string, startedAtMs: number): string {
  const file = path.join(dir, `${startedAtMs}_${id}.jsonl`)
  writeFileSync(
    file,
    `${JSON.stringify({
      type: 'session', version: 3, id, cwd, timestamp: new Date(startedAtMs).toISOString()
    })}\n`
  )
  return file
}

/**
 * POSIX-only. Skipped on Windows because the FEATURE is POSIX-only, not
 * because the assertions are awkward there:
 *
 *   - codex session binding shells out to `lsof`, which does not exist on
 *     Windows. There is no Windows implementation yet.
 *   - pi session directories are built with path.resolve() and then
 *     shell-quoted for a POSIX shell. On Windows path.resolve() correctly
 *     prepends a drive letter and the quoting escapes backslashes that cmd
 *     does not treat as escapes.
 *
 * Rewriting these expectations to accept Windows output would make CI green
 * while hiding a real functional gap. Skipping states the gap instead.
 */
describe.skipIf(process.platform === 'win32')('Pi command binding', () => {
  it('recognizes only the Pi executable token', () => {
    expect(isPiCommand('pi')).toBe(true)
    expect(isPiCommand('  pi --model sonnet')).toBe(true)
    expect(isPiCommand('pip install x')).toBe(false)
    expect(isPiCommand('pi; touch /tmp/nope')).toBe(false)
    expect(isPiCommand('bash')).toBe(false)
  })

  it('strips every competing session selector and builds deterministic commands', () => {
    expect(stripPiSessionFlags('pi --model sonnet --session old -c')).toBe('pi --model sonnet')
    expect(stripPiSessionFlags('pi --session-id=old --resume --no-session')).toBe('pi')
    expect(stripPiSessionFlags('pi --session-dir /tmp/other --model sonnet --fork')).toBe('pi --model sonnet')
    // M7: --fork takes a VALUE (path|id per pi's CLI) and values may be quoted
    // (a fork path can contain spaces) — the whole quoted token must go, not
    // just up to the first space.
    expect(stripPiSessionFlags('pi --session "my id" --model sonnet')).toBe('pi --model sonnet')
    expect(stripPiSessionFlags("pi --fork '/tmp/my session/x.jsonl'")).toBe('pi')
    expect(stripPiSessionFlags('pi --session-dir="/tmp/my dir" --model sonnet')).toBe('pi --model sonnet')
    expect(piFreshCommand('pi --session old', '/tmp/pi node')).toBe(
      'pi --session-dir /tmp/pi\\ node'
    )
    expect(piResumeCommand('pi --session-id old', '019f-safe', '/tmp/pi node')).toBe(
      'pi --session 019f-safe --session-dir /tmp/pi\\ node'
    )
  })

  it('derives a stable shell-safe session directory from the terminal id', () => {
    const root = '/tmp/Cookrew Pi'
    const first = piNodeSessionDir('node/../../hostile;id', { rootDir: root })
    expect(first).toBe(piNodeSessionDir('node/../../hostile;id', { rootDir: root }))
    expect(path.dirname(first)).toBe(root)
    expect(path.basename(first)).toMatch(/^[a-f0-9]{64}$/)
  })
})

// POSIX-only for the same reason as the block above.
describe.skipIf(process.platform === 'win32')('Pi session lookup', () => {
  it('launches fresh in an exclusive node directory, then resumes its exact persisted id', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'cookrew-pi-launch-'))
    roots.push(root)
    const cwd = path.join(root, 'work')
    const sessionsRoot = path.join(root, 'sessions')
    const terminalId = 'node-1'
    mkdirSync(cwd, { recursive: true })

    const fresh = piLaunchBinding({ command: 'pi --model sonnet', cwd, terminalId, sessionsRoot })
    expect(fresh.sessionId).toBeNull()
    expect(fresh.command).toBe(`pi --model sonnet --session-dir ${fresh.sessionDir}`)

    mkdirSync(fresh.sessionDir, { recursive: true })
    const id = '019f88f9-session'
    writeFileSync(
      path.join(fresh.sessionDir, `2026_${id}.jsonl`),
      `${JSON.stringify({ type: 'session', version: 3, id, cwd })}\n`
    )
    const resumed = piLaunchBinding({ command: 'pi --continue', cwd, terminalId, sessionsRoot })
    expect(resumed.sessionId).toBe(id)
    expect(resumed.command).toBe(`pi --session ${id} --session-dir ${fresh.sessionDir}`)
  })

  it('uses Pi cwd encoding and validates both header id and cwd', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'cookrew-pi-'))
    roots.push(root)
    const cwd = path.join(root, 'work', 'repo')
    const agentDir = path.join(root, 'agent')
    mkdirSync(cwd, { recursive: true })
    const dir = piSessionDir(cwd, { agentDir })
    mkdirSync(dir, { recursive: true })
    const id = '019f88f9-safe'
    const file = path.join(dir, `2026-08-03T00-00-00-000Z_${id}.jsonl`)
    writeFileSync(file, `${JSON.stringify({ type: 'session', version: 3, id, cwd })}\n`)

    expect(path.basename(dir)).toMatch(/^--.*work-repo--$/)
    expect(piSessionFile(cwd, id, { agentDir })).toBe(file)
    expect(latestPiSession(cwd, { agentDir })).toEqual({ id, file })
    expect(piSessionFile(cwd, 'x;touch-pwn', { agentDir })).toBeNull()
  })

  it('refuses a matching filename with a planted header cwd', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'cookrew-pi-'))
    roots.push(root)
    const cwd = path.join(root, 'work')
    const agentDir = path.join(root, 'agent')
    mkdirSync(cwd, { recursive: true })
    const dir = piSessionDir(cwd, { agentDir })
    mkdirSync(dir, { recursive: true })
    const id = 'session-safe'
    writeFileSync(
      path.join(dir, `2026_${id}.jsonl`),
      `${JSON.stringify({ type: 'session', version: 3, id, cwd: '/other/project' })}\n`
    )
    expect(piSessionFile(cwd, id, { agentDir })).toBeNull()
  })

  it('resolves the session of a LEGACY pane launched without --session-dir', () => {
    // The reattach gap (rail showed '(recovered turn)'): tmux `new-session -A`
    // reattaches a pane created before the exclusive-dir wiring, so the LIVE
    // pi keeps writing to pi's own cwd-derived dir while Cookrew only ever
    // scanned the node's exclusive dir — the node never bound, so turn history
    // fell back to PTY scraping. Binding follows the pane's REAL dir.
    const root = mkdtempSync(path.join(tmpdir(), 'cookrew-pi-legacy-'))
    roots.push(root)
    const cwd = path.join(root, 'work')
    const agentDir = path.join(root, 'agent')
    const sessionsRoot = path.join(root, 'exclusive')
    mkdirSync(cwd, { recursive: true })
    const shared = piSessionDir(cwd, { agentDir })
    mkdirSync(shared, { recursive: true })
    const paneStartedAtMs = Date.parse('2026-08-05T10:52:01.000Z')
    // Ours: pi opened its session ~2s after tmux started the pane.
    const ours = writeSession(shared, cwd, '019fd18d-mine', paneStartedAtMs + 2765)
    // Another pi in the SAME cwd, hours earlier — never ours to take.
    writeSession(shared, cwd, '019fcfd6-theirs', paneStartedAtMs - 8 * 3600_000)

    const legacy = { command: 'sh -c "export TERM_PROGRAM=Cookrew; exec pi"', paneStartedAtMs }
    expect(
      resolvePiSessionByPane({ cwd, terminalId: 'node-1', sessionsRoot, agentDir, ...legacy })
    ).toEqual({ id: '019fd18d-mine', file: ours })

    // No pane start time = no proof of ownership: never guess in a SHARED dir.
    expect(
      resolvePiSessionByPane({
        cwd, terminalId: 'node-1', sessionsRoot, agentDir,
        command: legacy.command, paneStartedAtMs: null
      })
    ).toBeNull()

    // Already claimed by another node → skipped, not stolen.
    expect(
      resolvePiSessionByPane({
        cwd, terminalId: 'node-1', sessionsRoot, agentDir, ...legacy,
        exclude: new Set(['019fd18d-mine'])
      })
    ).toBeNull()
  })

  it('never adopts a session that was already running when the pane started', () => {
    // Direction gate: pi opens its session AFTER its pane, so anything older
    // belongs to someone else — typically a pi the user is running by hand in
    // the same cwd. Adopting it would put two writers on one JSONL.
    const root = mkdtempSync(path.join(tmpdir(), 'cookrew-pi-before-'))
    roots.push(root)
    const cwd = path.join(root, 'work')
    const agentDir = path.join(root, 'agent')
    mkdirSync(cwd, { recursive: true })
    const shared = piSessionDir(cwd, { agentDir })
    mkdirSync(shared, { recursive: true })
    const paneStartedAtMs = Date.parse('2026-08-05T10:00:00.000Z')
    writeSession(shared, cwd, 'users-own', paneStartedAtMs - 100_000)

    expect(
      resolvePiSessionByPane({
        cwd, terminalId: 'node-1', agentDir,
        sessionsRoot: path.join(root, 'exclusive'),
        command: 'sh -c "exec pi"',
        paneStartedAtMs
      })
    ).toBeNull()
  })

  it('two legacy panes in one cwd each take the session that opened with THEM', () => {
    // Cross-wire gate: both sessions sit inside both panes' windows, and the
    // busier one has the newest mtime. Picking by mtime handed each node the
    // other's conversation; nearest-to-pane-start is the honest owner test.
    const root = mkdtempSync(path.join(tmpdir(), 'cookrew-pi-pair-'))
    roots.push(root)
    const cwd = path.join(root, 'work')
    const agentDir = path.join(root, 'agent')
    const sessionsRoot = path.join(root, 'exclusive')
    mkdirSync(cwd, { recursive: true })
    const shared = piSessionDir(cwd, { agentDir })
    mkdirSync(shared, { recursive: true })
    const paneA = Date.parse('2026-08-05T10:00:00.000Z')
    const paneB = paneA + 20_000
    const fileA = writeSession(shared, cwd, 'sess-a', paneA + 2000)
    const fileB = writeSession(shared, cwd, 'sess-b', paneB + 2000)
    // Node B is mid-turn, so ITS file is the most recently written one.
    utimesSync(fileA, new Date(1000), new Date(1000))
    utimesSync(fileB, new Date(9000), new Date(9000))

    const bind = (terminalId: string, paneStartedAtMs: number, exclude?: Set<string>) =>
      resolvePiSessionByPane({
        cwd, terminalId, agentDir, sessionsRoot, exclude,
        command: 'sh -c "exec pi"', paneStartedAtMs
      })
    expect(bind('node-a', paneA)).toEqual({ id: 'sess-a', file: fileA })
    expect(bind('node-b', paneB, new Set(['sess-a']))).toEqual({ id: 'sess-b', file: fileB })
  })

  it('applies the same proof to a declared dir that is NOT this terminal\'s own', () => {
    // An adopted node relaunches as `pi --session <id> --session-dir <shared>`,
    // so the pane now DECLARES a shared directory. Trusting a declared dir
    // outright would let the next rebind (after the id is rotated away) take
    // whatever was written there most recently — the user's own session.
    const root = mkdtempSync(path.join(tmpdir(), 'cookrew-pi-declared-'))
    roots.push(root)
    const cwd = path.join(root, 'work')
    const agentDir = path.join(root, 'agent')
    mkdirSync(cwd, { recursive: true })
    const shared = piSessionDir(cwd, { agentDir })
    mkdirSync(shared, { recursive: true })
    const paneStartedAtMs = Date.parse('2026-08-05T10:00:00.000Z')
    writeSession(shared, cwd, 'users-own', paneStartedAtMs - 100_000)

    expect(
      resolvePiSessionByPane({
        cwd, terminalId: 'node-1', agentDir,
        sessionsRoot: path.join(root, 'exclusive'),
        command: `sh -c "exec pi --session-dir ${shared}"`,
        paneStartedAtMs
      })
    ).toBeNull()
  })

  it('a pane launched WITH --session-dir binds inside that exact directory', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'cookrew-pi-pane-'))
    roots.push(root)
    const cwd = path.join(root, 'work')
    const agentDir = path.join(root, 'agent')
    const sessionsRoot = path.join(root, 'exclusive')
    mkdirSync(cwd, { recursive: true })
    const dir = piNodeSessionDir('node-1', { rootDir: sessionsRoot })
    mkdirSync(dir, { recursive: true })
    const id = '019fca80-exclusive'
    const file = path.join(dir, `2026-08-04_${id}.jsonl`)
    writeFileSync(file, `${JSON.stringify({ type: 'session', version: 3, id, cwd })}\n`)
    // A decoy in the shared dir must never win when the pane declares its dir.
    const shared = piSessionDir(cwd, { agentDir })
    mkdirSync(shared, { recursive: true })
    writeFileSync(
      path.join(shared, '2026-08-05_decoy-session.jsonl'),
      `${JSON.stringify({ type: 'session', version: 3, id: 'decoy-session', cwd })}\n`
    )

    expect(
      resolvePiSessionByPane({
        cwd, terminalId: 'node-1', sessionsRoot, agentDir,
        command: `sh -c "exec pi --session-dir ${dir}"`,
        paneStartedAtMs: Date.now()
      })
    ).toEqual({ id, file })
  })

  it('reads the session dir a live pane was launched with, in every quoting form', () => {
    expect(piSessionDirFromCommand('pi --session-dir /tmp/x')).toBe('/tmp/x')
    expect(piSessionDirFromCommand('pi --session-dir=/tmp/x --model k3')).toBe('/tmp/x')
    expect(piSessionDirFromCommand('sh -c "export A=1; exec pi --session-dir /tmp/x"')).toBe('/tmp/x')
    // Cookrew shell-escapes spaces; a hand-typed command may quote instead.
    expect(piSessionDirFromCommand('pi --session-dir /tmp/pi\\ node')).toBe('/tmp/pi node')
    expect(piSessionDirFromCommand("pi --session-dir '/tmp/my dir'")).toBe('/tmp/my dir')
    expect(piSessionDirFromCommand('pi --session-dir="/tmp/my dir"')).toBe('/tmp/my dir')
    expect(piSessionDirFromCommand('sh -c "exec pi"')).toBeNull()
    expect(piSessionDirFromCommand('pi --session-dir')).toBeNull()
    // Cookrew APPENDS its own flag, so the last occurrence is the one pi obeys.
    expect(piSessionDirFromCommand('pi --session-dir /tmp/first --session-dir /tmp/last')).toBe(
      '/tmp/last'
    )
  })

  it('resumes an adopted session in the directory that holds it', () => {
    // Without this the next reboot boots an EMPTY conversation in the node's
    // (still empty) exclusive dir, stranding the history we just adopted.
    const root = mkdtempSync(path.join(tmpdir(), 'cookrew-pi-resume-'))
    roots.push(root)
    const cwd = path.join(root, 'work')
    const agentDir = path.join(root, 'agent')
    const sessionsRoot = path.join(root, 'exclusive')
    mkdirSync(cwd, { recursive: true })
    const shared = piSessionDir(cwd, { agentDir })
    mkdirSync(shared, { recursive: true })
    const id = '019fd18d-adopted'
    writeSession(shared, cwd, id, Date.parse('2026-08-05T10:00:02.000Z'))

    const adopted = piLaunchBinding({
      command: 'pi', cwd, terminalId: 'node-1', sessionsRoot, agentDir, storedSessionId: id
    })
    expect(adopted).toEqual({
      command: `pi --session ${id} --session-dir ${shared}`,
      sessionId: id,
      sessionDir: shared
    })

    // A stored id that resolves NOWHERE still boots fresh in the exclusive dir.
    const fresh = piLaunchBinding({
      command: 'pi', cwd, terminalId: 'node-1', sessionsRoot, agentDir, storedSessionId: 'gone'
    })
    expect(fresh.sessionId).toBeNull()
    expect(fresh.sessionDir).toBe(piNodeSessionDir('node-1', { rootDir: sessionsRoot }))
  })

  it('watches a legacy session that lives in pi\'s own cwd directory', () => {
    // Same gap at the WATCH boundary: an id bound from the shared dir must
    // still resolve to a file, or SessionTurnSync has nothing to reconcile.
    // Exact id + header cwd check — a lookup, never a most-recent guess.
    const root = mkdtempSync(path.join(tmpdir(), 'cookrew-pi-watch-'))
    roots.push(root)
    const cwd = path.join(root, 'work')
    const agentDir = path.join(root, 'agent')
    mkdirSync(cwd, { recursive: true })
    const shared = piSessionDir(cwd, { agentDir })
    mkdirSync(shared, { recursive: true })
    const id = '019fd18d-legacy'
    const file = path.join(shared, `2026-08-05_${id}.jsonl`)
    writeFileSync(file, `${JSON.stringify({ type: 'session', version: 3, id, cwd })}\n`)

    const node = { id: 'node-1', cwd, piSessionId: id }
    expect(
      piWatchFile(node, { piSessionsRoot: path.join(root, 'exclusive'), piAgentDir: agentDir })
    ).toBe(file)
    // A session id that exists NOWHERE stays unwatched.
    expect(
      piWatchFile({ ...node, piSessionId: 'not-a-session' }, {
        piSessionsRoot: path.join(root, 'exclusive'), piAgentDir: agentDir
      })
    ).toBeNull()
  })

  it('tracks Pi\'s most recently active file after a session switch', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'cookrew-pi-latest-'))
    roots.push(root)
    const cwd = path.join(root, 'work')
    const sessionsDir = path.join(root, 'sessions')
    mkdirSync(cwd, { recursive: true })
    mkdirSync(sessionsDir, { recursive: true })
    const oldId = 'old-session'
    const newId = 'new-session'
    const oldFile = path.join(sessionsDir, `2026-01_${oldId}.jsonl`)
    const newFile = path.join(sessionsDir, `2026-12_${newId}.jsonl`)
    writeFileSync(oldFile, `${JSON.stringify({ type: 'session', version: 3, id: oldId, cwd })}\n`)
    writeFileSync(newFile, `${JSON.stringify({ type: 'session', version: 3, id: newId, cwd })}\n`)
    utimesSync(newFile, new Date(1000), new Date(1000))
    utimesSync(oldFile, new Date(2000), new Date(2000))

    expect(latestPiSession(cwd, { sessionsDir })).toEqual({ id: oldId, file: oldFile })
  })
})
