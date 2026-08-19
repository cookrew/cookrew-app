import { describe, expect, it } from 'vitest'
import { scrubForPublish, PLACEHOLDER_PREFIX } from '../src/main/preset-scrub'
import type { TeamSnapshot } from '../src/main/teams'
import type { CanvasNode } from '../src/shared/model'

/**
 * A4: presets are executable-adjacent, so the scrubber is a SAFETY GATE, not a
 * formatter. These tests are the contract the manifest (§2) and the install
 * review sheet (§8) both read.
 */

const terminal = (over: Partial<Extract<CanvasNode, { kind: 'terminal' }>> = {}): CanvasNode =>
  ({
    kind: 'terminal',
    id: 't1',
    name: 'Forge',
    preset: 'Claude Code',
    command: 'claude --resume abc',
    cwd: '/Users/drej/workspace/cookrew-dev',
    orch: false,
    role: 'Developer',
    position: { x: 0, y: 0 },
    size: { width: 10, height: 10 },
    ...over
  }) as CanvasNode

const note = (content: string, id = 'n1'): CanvasNode =>
  ({
    kind: 'note',
    id,
    name: 'note',
    customName: null,
    content,
    locked: false,
    position: { x: 0, y: 0 },
    size: { width: 10, height: 10 }
  }) as CanvasNode

const browser = (url: string, id = 'b1'): CanvasNode =>
  ({
    kind: 'browser',
    id,
    name: 'browser',
    url,
    position: { x: 0, y: 0 },
    size: { width: 10, height: 10 }
  }) as CanvasNode

const snapshot = (over: Partial<TeamSnapshot> = {}): TeamSnapshot => ({
  name: 'crew',
  savedAt: 1_700_000_000_000,
  dir: '/Users/drej/workspace/cookrew-dev',
  dirs: ['/Users/drej/workspace/cookrew-dev', '/Users/drej/workspace/playground'],
  nodes: [terminal()],
  connections: [],
  turns: { t1: [{ index: 1 } as never] },
  sessions: { t1: 't1.jsonl' },
  ...over
})

describe('scrubForPublish — session context leaves only on purpose', () => {
  it('drops turns and the sessions sidecar by default', () => {
    const out = scrubForPublish(snapshot())
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.snapshot.turns).toEqual({})
    expect(out.snapshot.sessions).toBeUndefined()
    expect(out.report.sessions).toBe(false)
  })

  it('carries them only on explicit publisher opt-in, and says so in the report', () => {
    const out = scrubForPublish(snapshot(), { includeSessions: true })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.snapshot.turns).not.toEqual({})
    expect(out.snapshot.sessions).toEqual({ t1: 't1.jsonl' })
    expect(out.report.sessions).toBe(true)
  })
})

describe('scrubForPublish — absolute paths become role placeholders', () => {
  it('maps dir and dirs to stable placeholders, primary first', () => {
    const out = scrubForPublish(snapshot())
    if (!out.ok) throw new Error('blocked')
    expect(out.snapshot.dir).toBe(`${PLACEHOLDER_PREFIX}0}}`)
    expect(out.snapshot.dirs).toEqual([`${PLACEHOLDER_PREFIX}0}}`, `${PLACEHOLDER_PREFIX}1}}`])
    expect(out.report.paths).toBe('placeholders')
  })

  it('maps every terminal cwd through the same table', () => {
    const out = scrubForPublish(
      snapshot({ nodes: [terminal({ cwd: '/Users/drej/workspace/playground' })] })
    )
    if (!out.ok) throw new Error('blocked')
    const node = out.snapshot.nodes[0] as Extract<CanvasNode, { kind: 'terminal' }>
    expect(node.cwd).toBe(`${PLACEHOLDER_PREFIX}1}}`)
  })

  it('gives an unlisted cwd its own placeholder rather than leaking it', () => {
    const out = scrubForPublish(snapshot({ nodes: [terminal({ cwd: '/Users/drej/secret-client' })] }))
    if (!out.ok) throw new Error('blocked')
    const node = out.snapshot.nodes[0] as Extract<CanvasNode, { kind: 'terminal' }>
    expect(node.cwd).toBe(`${PLACEHOLDER_PREFIX}2}}`)
    expect(JSON.stringify(out.snapshot)).not.toContain('secret-client')
  })

  it('rewrites those paths where they are EMBEDDED in commands and notes too', () => {
    // A path in `cwd` and the same path inside a command leak the same username.
    const out = scrubForPublish(
      snapshot({
        nodes: [
          terminal({ command: 'cd /Users/drej/workspace/cookrew-dev && npm test' }),
          note('see /Users/drej/workspace/cookrew-dev/README.md')
        ]
      })
    )
    if (!out.ok) throw new Error('blocked')
    expect(JSON.stringify(out.snapshot)).not.toContain('/Users/drej')
  })
})

describe('scrubForPublish — no session binding survives export', () => {
  it('clears every harness binding, lineage, restore stack and pending inject', () => {
    const out = scrubForPublish(
      snapshot({
        nodes: [
          terminal({
            claudeSessionId: 'c-1',
            piSessionId: 'p-1',
            codexSessionRef: '/Users/drej/.codex/sessions/x.jsonl',
            opencodeSessionId: 'o-1',
            sessionLineage: ['c-0'],
            restoreStack: [{ any: true } as never],
            pendingInject: 'leftover preamble',
            forkOf: { sourceId: 't0', sourceName: 'Old', turnIndex: 3 }
          })
        ]
      })
    )
    if (!out.ok) throw new Error('blocked')
    const node = out.snapshot.nodes[0] as Extract<CanvasNode, { kind: 'terminal' }>
    expect(node.claudeSessionId).toBeNull()
    expect(node.piSessionId).toBeNull()
    expect(node.codexSessionRef).toBeNull()
    expect(node.opencodeSessionId).toBeNull()
    expect(node.sessionLineage).toBeUndefined()
    expect(node.restoreStack).toBeUndefined()
    expect(node.pendingInject).toBeNull()
    // forkOf names a source id that does not exist for the buyer.
    expect(node.forkOf).toBeNull()
  })

  it('strips resume flags so a placed copy cannot reopen the author session', () => {
    const out = scrubForPublish(snapshot({ nodes: [terminal({ command: 'claude --resume abc123' })] }))
    if (!out.ok) throw new Error('blocked')
    const node = out.snapshot.nodes[0] as Extract<CanvasNode, { kind: 'terminal' }>
    expect(node.command).not.toContain('abc123')
  })
})

describe('scrubForPublish — the report is what the review sheet renders', () => {
  it('counts shells, notes and urls, and keeps shell commands verbatim', () => {
    const out = scrubForPublish(
      snapshot({
        nodes: [
          terminal({ id: 's1', preset: 'Shell', command: 'rm -rf ./build' }),
          terminal({ id: 's2', preset: 'Shell', command: 'make deploy' }),
          note('hello', 'n1'),
          note('world', 'n2'),
          browser('https://example.com', 'b1')
        ]
      })
    )
    if (!out.ok) throw new Error('blocked')
    expect(out.report.shells).toBe(2)
    expect(out.report.notes).toBe(2)
    expect(out.report.urls).toBe(1)
    // It is the product — the buyer must be able to READ it before first run.
    const shell = out.snapshot.nodes.find((n) => n.id === 's1') as Extract<
      CanvasNode,
      { kind: 'terminal' }
    >
    expect(shell.command).toBe('rm -rf ./build')
  })
})

describe('scrubForPublish — secrets BLOCK the publish, they are never warned', () => {
  const blocked = (nodes: CanvasNode[]): ReturnType<typeof scrubForPublish> =>
    scrubForPublish(snapshot({ nodes }))

  it('blocks an AWS access key in a shell command', () => {
    const out = blocked([terminal({ command: 'export AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE' })])
    expect(out.ok).toBe(false)
    expect(out.report.secretScan).toBe('blocked')
  })

  it('blocks provider API keys in a note body', () => {
    for (const key of ['sk-ant-api03-' + 'x'.repeat(40), 'sk-' + 'y'.repeat(32)]) {
      expect(blocked([note(`key: ${key}`)]).ok).toBe(false)
    }
  })

  it('blocks a GitHub token and a private key block', () => {
    expect(blocked([note('ghp_' + 'a'.repeat(36))]).ok).toBe(false)
    expect(blocked([note('-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n')]).ok).toBe(false)
  })

  it('blocks a secret carried in a browser url', () => {
    expect(blocked([browser('https://x.dev/cb?token=ghp_' + 'b'.repeat(36))]).ok).toBe(false)
  })

  it('names WHERE it found each secret but never echoes the secret itself', () => {
    const secret = 'AKIAIOSFODNN7EXAMPLE'
    const out = blocked([terminal({ id: 'z9', command: `export K=${secret}` })])
    expect(out.ok).toBe(false)
    expect(out.report.findings.length).toBeGreaterThan(0)
    expect(out.report.findings[0].where).toContain('z9')
    expect(JSON.stringify(out.report)).not.toContain(secret)
  })

  it('passes a clean team and reports the scan as clean', () => {
    const out = scrubForPublish(snapshot({ nodes: [terminal({ command: 'npm test' }), note('hi')] }))
    expect(out.ok).toBe(true)
    expect(out.report.secretScan).toBe('clean')
    expect(out.report.findings).toEqual([])
  })

  it('does not flag ordinary prose that merely mentions a key', () => {
    const out = scrubForPublish(snapshot({ nodes: [note('put your API key in .env, never here')] }))
    expect(out.ok).toBe(true)
  })
})

describe('scrubForPublish — purity', () => {
  it('never mutates the snapshot it was given', () => {
    const input = snapshot()
    const before = JSON.stringify(input)
    scrubForPublish(input)
    expect(JSON.stringify(input)).toBe(before)
  })
})
