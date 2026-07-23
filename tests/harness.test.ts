import { describe, expect, it } from 'vitest'
import { harnessFor } from '../src/main/harness'

describe('harnessFor — multi-harness resume registry', () => {
  it('identifies each harness and its session field', () => {
    expect(harnessFor('claude --permission-mode bypassPermissions')?.id).toBe('claude')
    expect(harnessFor('codex')?.id).toBe('codex')
    expect(harnessFor('opencode')?.id).toBe('opencode')
    expect(harnessFor('')).toBeNull()
    expect(harnessFor('bash')).toBeNull()
    expect(harnessFor('claude')?.sessionField).toBe('claudeSessionId')
    expect(harnessFor('codex')?.sessionField).toBe('codexSessionRef')
    expect(harnessFor('opencode')?.sessionField).toBe('opencodeSessionId')
  })

  it('builds a full-session resume command per harness', () => {
    const claude = harnessFor('claude --permission-mode bypassPermissions')!
    expect(claude.resumeCommand('claude --permission-mode bypassPermissions', 'sess-1')).toBe(
      'claude --permission-mode bypassPermissions --resume sess-1'
    )
    // strips any prior session binding (recover of a recovered agent)
    expect(claude.resumeCommand('claude --resume old --verbose', 'new')).toBe(
      'claude --verbose --resume new'
    )
    expect(harnessFor('codex')!.resumeCommand('codex', 'cx-uuid')).toBe('codex resume cx-uuid')
    // global bypass opts stay BEFORE the resume subcommand (Tinker)
    expect(
      harnessFor('codex')!.resumeCommand('codex --dangerously-bypass-approvals-and-sandbox', 'u')
    ).toBe('codex --dangerously-bypass-approvals-and-sandbox resume u')
    expect(harnessFor('opencode')!.resumeCommand('opencode', 'oc-1')).toBe(
      'opencode --session oc-1'
    )
    expect(harnessFor('opencode')!.resumeCommand('opencode --session old', 'oc-2')).toBe(
      'opencode --session oc-2'
    )
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
})
