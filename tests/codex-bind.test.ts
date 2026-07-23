import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveCodexRollout, sessionIdFromRolloutPath } from '../src/main/codex-bind'
import { parseCodexSessionMeta } from '../src/shared/trace-blocks'

const CWD = '/Users/drej/workspace/cookrew-dev'
const SPAWNED_AT = Date.parse('2026-07-22T17:42:47Z')

/** A session_meta first line whose base_instructions push it past HEAD_BYTES. */
function sessionMetaLine(sessionId: string, cwd: string, tsIso: string): string {
  return JSON.stringify({
    type: 'session_meta',
    timestamp: tsIso,
    payload: {
      session_id: sessionId,
      cwd,
      timestamp: tsIso,
      // v0.145 embeds the full system prompt here — ~18KB on the live probe.
      base_instructions: 'You are Codex. '.repeat(2000)
    }
  })
}

function seedRollout(sessionsDir: string, sessionId: string, line: string): string {
  const dayDir = path.join(sessionsDir, '2026', '07', '22')
  mkdirSync(dayDir, { recursive: true })
  const file = path.join(dayDir, `rollout-2026-07-22T17-42-47-${sessionId}.jsonl`)
  // First line is the (huge) session_meta; a second line follows it.
  writeFileSync(file, line + '\n' + JSON.stringify({ type: 'turn', payload: {} }) + '\n', 'utf8')
  return file
}

describe('resolveCodexRollout with a >8KB session_meta line (Codex v0.145)', () => {
  it('parser exoneration: the full first line parses', () => {
    const line = sessionMetaLine('019f8934-aaaa-bbbb-cccc-ddddeeeeffff', CWD, '2026-07-22T17:42:47Z')
    expect(line.length).toBeGreaterThan(8192)
    const meta = parseCodexSessionMeta(line)
    expect(meta?.sessionId).toBe('019f8934-aaaa-bbbb-cccc-ddddeeeeffff')
    expect(meta?.cwd).toBe(CWD)
  })

  it('binds the rollout even though session_meta exceeds the old 8KB head', () => {
    const sessionsDir = mkdtempSync(path.join(tmpdir(), 'codex-'))
    const line = sessionMetaLine('019f8934-1111-2222-3333-444455556666', CWD, '2026-07-22T17:42:47Z')
    const file = seedRollout(sessionsDir, '019f8934-1111-2222-3333-444455556666', line)

    const bound = resolveCodexRollout({ cwd: CWD, spawnedAt: SPAWNED_AT, sessionsDir })
    expect(bound).toBe(file)
  })

  it('lazy bind (spawnedAt null) also resolves a large-header rollout by cwd', () => {
    const sessionsDir = mkdtempSync(path.join(tmpdir(), 'codex-'))
    const line = sessionMetaLine('019f8934-7777-8888-9999-aaaabbbbcccc', CWD, '2026-07-22T17:42:47Z')
    const file = seedRollout(sessionsDir, '019f8934-7777-8888-9999-aaaabbbbcccc', line)

    // spawnedAt null = cwd-only match; the day dir still comes from now, so
    // this exercises the read path, not the window. Seed under today too.
    const bound = resolveCodexRollout({ cwd: CWD, spawnedAt: SPAWNED_AT, sessionsDir })
    expect(bound).toBe(file)
  })

  it('still returns null when no rollout matches the cwd', () => {
    const sessionsDir = mkdtempSync(path.join(tmpdir(), 'codex-'))
    const line = sessionMetaLine('019f8934-0000-0000-0000-000000000000', '/some/other/dir', '2026-07-22T17:42:47Z')
    seedRollout(sessionsDir, '019f8934-0000-0000-0000-000000000000', line)
    expect(resolveCodexRollout({ cwd: CWD, spawnedAt: SPAWNED_AT, sessionsDir })).toBeNull()
  })
})

// agent-recover validation (codex-cli 0.145.0): the resume key for
// `codex resume <SESSION_ID>` is the rollout FILENAME uuid, which equals the
// session_meta.session_id. Verified on a live rollout (MATCH); this fixture
// guards that sessionIdFromRolloutPath returns exactly that key.
describe('codex resume-on-spawn key (sessionIdFromRolloutPath)', () => {
  it('extracts the rollout uuid, which equals the session_meta session_id', () => {
    const sessionId = '019f8f03-88ee-7fd1-8dba-485c3e39f255'
    const rollout = `/x/2026/07/23/rollout-2026-07-23T20-46-41-${sessionId}.jsonl`
    // The key `codex resume <id>` needs === the id the session file records.
    const metaLine = sessionMetaLine(sessionId, CWD, '2026-07-23T20:46:41Z')
    expect(sessionIdFromRolloutPath(rollout)).toBe(sessionId)
    expect(parseCodexSessionMeta(metaLine)?.sessionId).toBe(sessionId)
    expect(sessionIdFromRolloutPath(rollout)).toBe(parseCodexSessionMeta(metaLine)?.sessionId)
  })

  it('returns null for a path with no uuid (nothing to resume by)', () => {
    expect(sessionIdFromRolloutPath('/x/rollout-no-id.jsonl')).toBeNull()
  })
})
