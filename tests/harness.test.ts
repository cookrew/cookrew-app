import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { harnessFor } from '../src/main/harness'
import { piNodeSessionDir, piSessionDir } from '../src/main/pi-bind'

describe('harnessFor — multi-harness resume registry', () => {
  it('identifies each harness and its session field', () => {
    expect(harnessFor('claude --permission-mode bypassPermissions')?.id).toBe('claude')
    expect(harnessFor('codex')?.id).toBe('codex')
    expect(harnessFor('opencode')?.id).toBe('opencode')
    expect(harnessFor('pi')?.id).toBe('pi')
    expect(harnessFor('')).toBeNull()
    expect(harnessFor('bash')).toBeNull()
    expect(harnessFor('claude')?.sessionField).toBe('claudeSessionId')
    expect(harnessFor('codex')?.sessionField).toBe('codexSessionRef')
    expect(harnessFor('opencode')?.sessionField).toBe('opencodeSessionId')
    expect(harnessFor('pi')?.sessionField).toBe('piSessionId')
  })

  // pi's resume command embeds a path.resolve()d, POSIX-shell-quoted
  // session dir; on Windows that is a drive-lettered path with
  // backslashes cmd does not treat as escapes. Real gap, not a test bug.
  it.skipIf(process.platform === 'win32')('builds a full-session resume command per harness', () => {
    // cwd/terminalId are ignored by harnesses that scope neither.
    const ctx = { terminalId: 'x', cwd: '/work/repo' }
    const claude = harnessFor('claude --permission-mode bypassPermissions')!
    expect(claude.resumeCommand('claude --permission-mode bypassPermissions', 'sess-1', ctx)).toBe(
      'claude --permission-mode bypassPermissions --resume sess-1'
    )
    // strips any prior session binding (recover of a recovered agent)
    expect(claude.resumeCommand('claude --resume old --verbose', 'new', ctx)).toBe(
      'claude --verbose --resume new'
    )
    expect(harnessFor('codex')!.resumeCommand('codex', 'cx-uuid', ctx)).toBe('codex resume cx-uuid')
    // global bypass opts stay BEFORE the resume subcommand (Tinker)
    expect(
      harnessFor('codex')!.resumeCommand('codex --dangerously-bypass-approvals-and-sandbox', 'u', ctx)
    ).toBe('codex --dangerously-bypass-approvals-and-sandbox resume u')
    expect(harnessFor('opencode')!.resumeCommand('opencode', 'oc-1', ctx)).toBe(
      'opencode --session oc-1'
    )
    expect(harnessFor('opencode')!.resumeCommand('opencode --session old', 'oc-2', ctx)).toBe(
      'opencode --session oc-2'
    )
    const piDir = piNodeSessionDir('pi-node')
    expect(harnessFor('pi')!.resumeCommand('pi --model sonnet', '019f-safe', { terminalId: 'pi-node', cwd: '/work/repo' })).toBe(
      `pi --model sonnet --session 019f-safe --session-dir ${piDir}`
    )
    expect(harnessFor('pi')!.resumeCommand('pi --session old -c', '019f-safe', { terminalId: 'pi-node', cwd: '/work/repo' })).toBe(
      `pi --session 019f-safe --session-dir ${piDir}`
    )
  })

  // pi's resume command embeds a path.resolve()d, POSIX-shell-quoted
  // session dir; on Windows that is a drive-lettered path with
  // backslashes cmd does not treat as escapes. Real gap, not a test bug.
  it.skipIf(process.platform === 'win32')('pi resumes an ADOPTED session in the directory that holds it', () => {
    // Registry parity with piLaunchBinding: the generic resume path (recover,
    // restore) must not send an adopted node back to its empty exclusive dir.
    const root = mkdtempSync(path.join(tmpdir(), 'harness-pi-adopted-'))
    const cwd = path.join(root, 'work')
    const agentDir = path.join(root, 'agent')
    mkdirSync(cwd, { recursive: true })
    const shared = piSessionDir(cwd, { agentDir })
    mkdirSync(shared, { recursive: true })
    const id = '019fd18d-adopted'
    writeFileSync(
      path.join(shared, `2026_${id}.jsonl`),
      `${JSON.stringify({ type: 'session', version: 3, id, cwd })}\n`
    )
    const previous = process.env.PI_CODING_AGENT_DIR
    process.env.PI_CODING_AGENT_DIR = agentDir
    try {
      expect(harnessFor('pi')!.resumeCommand('pi', id, { terminalId: 'pi-node', cwd })).toBe(
        `pi --session ${id} --session-dir ${shared}`
      )
    } finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR
      else process.env.PI_CODING_AGENT_DIR = previous
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('resolves the codex resume key from a rollout path, else a bare uuid', () => {
    const codex = harnessFor('codex')!
    expect(
      codex.resumeKey('/Users/x/.codex/sessions/2026/07/22/rollout-2026-07-22T16-00-00-019f88f9-3ebd-73f3-b5e0-9a2eaca11ebb.jsonl')
    ).toBe('019f88f9-3ebd-73f3-b5e0-9a2eaca11ebb')
    expect(codex.resumeKey('019f88f9-3ebd-73f3-b5e0-9a2eaca11ebb')).toBe(
      '019f88f9-3ebd-73f3-b5e0-9a2eaca11ebb'
    )
    expect(codex.resumeKey('garbage')).toBeNull()
    expect(harnessFor('claude')!.resumeKey('sess-1')).toBe('sess-1')
  })

  it('rejects a hostile opencode session ref — shell-injection guard (HIGH-2)', () => {
    const oc = harnessFor('opencode')!
    expect(oc.resumeKey('ses_abc123XYZ')).toBe('ses_abc123XYZ')
    expect(oc.resumeKey('ses_x; rm -rf /')).toBeNull()
    expect(oc.resumeKey('$(whoami)')).toBeNull()
    expect(oc.resumeKey('ses_a b')).toBeNull()
    expect(oc.resumeKey('')).toBeNull()
  })

  it('rejects a hostile Pi session ref before it reaches the shell', () => {
    const pi = harnessFor('pi')!
    expect(pi.resumeKey('019f88f9-safe_ID.1')).toBe('019f88f9-safe_ID.1')
    expect(pi.resumeKey('x; rm -rf /')).toBeNull()
    expect(pi.resumeKey('$(whoami)')).toBeNull()
    expect(pi.resumeKey('x y')).toBeNull()
  })
})
