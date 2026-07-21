import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  claudeSessionFile,
  resumeRoleSession,
  saveRoleSessionCopy
} from '../src/main/claude-fork'
import { claudeProjectSlug } from '../src/shared/claude-fork'

const CLAUDE = 'claude --permission-mode bypassPermissions'

function user(content: string, uuid: string): string {
  return JSON.stringify({ type: 'user', message: { role: 'user', content }, uuid, sessionId: 'src' })
}
function assistant(text: string): string {
  return JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
    sessionId: 'src'
  })
}

/** Write a source session file for `cwd`/`sessionId` under a fake projects dir. */
function seedSession(projectsDir: string, cwd: string, sessionId: string, lines: string[]): void {
  const dir = path.join(projectsDir, claudeProjectSlug(cwd))
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, `${sessionId}.jsonl`), lines.join('\n') + '\n', 'utf8')
}

const SESSION = [
  user('checkpoint one opener', 'u1'),
  assistant('reply one'),
  user('later turn two', 'u2'),
  assistant('reply two'),
  user('later turn three', 'u3'),
  assistant('reply three')
]

describe('saveRoleSessionCopy', () => {
  it('writes a truncated copy at the checkpoint uuid (context up to the checkpoint only)', () => {
    const projectsDir = mkdtempSync(path.join(tmpdir(), 'proj-'))
    const destDir = mkdtempSync(path.join(tmpdir(), 'rolesess-'))
    seedSession(projectsDir, '/repo', 'src', SESSION)

    const ref = saveRoleSessionCopy({
      command: CLAUDE,
      cwd: '/repo',
      sessionId: 'src',
      sourceTurnUuid: 'u1',
      destDir,
      projectsDir
    })
    expect(ref).toBeTruthy()
    const copy = readFileSync(path.join(destDir, `${ref}.jsonl`), 'utf8')
    expect(copy).toContain('checkpoint one opener')
    expect(copy).not.toContain('later turn two')
    // Kept records are restamped to the ref session id.
    expect(copy).toContain(`"sessionId":"${ref}"`)
  })

  it('returns null for a non-Claude (Codex) source — no native copy', () => {
    const destDir = mkdtempSync(path.join(tmpdir(), 'rolesess-'))
    expect(
      saveRoleSessionCopy({
        command: 'codex',
        cwd: '/repo',
        sessionId: 'src',
        sourceTurnUuid: 'u1',
        destDir
      })
    ).toBeNull()
  })

  it('returns null when the source session file is absent', () => {
    const projectsDir = mkdtempSync(path.join(tmpdir(), 'proj-'))
    const destDir = mkdtempSync(path.join(tmpdir(), 'rolesess-'))
    expect(
      saveRoleSessionCopy({
        command: CLAUDE,
        cwd: '/repo',
        sessionId: 'missing',
        sourceTurnUuid: 'u1',
        destDir,
        projectsDir
      })
    ).toBeNull()
  })
})

describe('resumeRoleSession', () => {
  it('materializes the role copy under a fresh id in the boot cwd project dir', () => {
    const projectsDir = mkdtempSync(path.join(tmpdir(), 'proj-'))
    const copyDir = mkdtempSync(path.join(tmpdir(), 'rolesess-'))
    // A stored role session copy (from a prior save).
    writeFileSync(
      path.join(copyDir, 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.jsonl'),
      [user('checkpoint one opener', 'u1'), assistant('reply one')].join('\n') + '\n',
      'utf8'
    )

    const freshId = resumeRoleSession({
      sessionCopyRef: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      copyDir,
      cwd: '/newdir',
      projectsDir
    })
    expect(freshId).toBeTruthy()
    const bootFile = claudeSessionFile('/newdir', freshId as string, projectsDir)
    expect(existsSync(bootFile)).toBe(true)
    const content = readFileSync(bootFile, 'utf8')
    // The booted session CONTAINS the checkpoint context, restamped to fresh id.
    expect(content).toContain('checkpoint one opener')
    expect(content).toContain(`"sessionId":"${freshId}"`)
    expect(content).not.toContain('"sessionId":"aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"')
  })

  it('gives a distinct id each boot so one role can seed many terminals', () => {
    const projectsDir = mkdtempSync(path.join(tmpdir(), 'proj-'))
    const copyDir = mkdtempSync(path.join(tmpdir(), 'rolesess-'))
    writeFileSync(path.join(copyDir, 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.jsonl'), user('opener', 'u1') + '\n', 'utf8')
    const a = resumeRoleSession({ sessionCopyRef: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', copyDir, cwd: '/d', projectsDir })
    const b = resumeRoleSession({ sessionCopyRef: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', copyDir, cwd: '/d', projectsDir })
    expect(a).not.toBe(b)
  })

  it('returns null when the stored copy is missing (boot fresh)', () => {
    const projectsDir = mkdtempSync(path.join(tmpdir(), 'proj-'))
    const copyDir = mkdtempSync(path.join(tmpdir(), 'rolesess-'))
    expect(resumeRoleSession({ sessionCopyRef: '99999999-8888-4777-8666-555555555555', copyDir, cwd: '/d', projectsDir })).toBeNull()
  })

  it('rejects a non-UUID ref (traversal-shaped) without touching the fs', () => {
    const projectsDir = mkdtempSync(path.join(tmpdir(), 'proj-'))
    const copyDir = mkdtempSync(path.join(tmpdir(), 'rolesess-'))
    expect(
      resumeRoleSession({ sessionCopyRef: '../../etc/passwd', copyDir, cwd: '/d', projectsDir })
    ).toBeNull()
  })
})
