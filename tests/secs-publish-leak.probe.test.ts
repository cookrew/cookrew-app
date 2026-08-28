// SEC-S self-review probe: what does a CLEAN scrub actually let leave?
// Not a shipped test — a measurement of the gate on the publish side.
import { describe, expect, it } from 'vitest'
import { scrubForPublish } from '../src/main/preset-scrub'
import type { TeamSnapshot } from '../src/main/teams'
import { canonicalJson } from '../src/shared/preset-manifest'

const terminal = (id: string, over: Record<string, unknown> = {}) => ({
  kind: 'terminal' as const,
  id,
  name: id,
  preset: 'Claude Code',
  command: 'claude',
  cwd: '/Users/owner/workspace/proj',
  orch: false,
  role: null,
  position: { x: 0, y: 0 },
  size: { width: 10, height: 10 },
  ...over
})

const note = (id: string, content: string) => ({
  kind: 'note' as const,
  id,
  name: id,
  customName: null,
  content,
  locked: false,
  position: { x: 0, y: 0 },
  size: { width: 10, height: 10 }
})

const snap = (nodes: unknown[], over: Partial<TeamSnapshot> = {}): TeamSnapshot =>
  ({
    name: 'proj team',
    savedAt: 1,
    dir: '/Users/owner/workspace/proj',
    nodes,
    connections: [],
    turns: {},
    ...over
  }) as TeamSnapshot

describe('SEC-S: what a clean scrub publishes', () => {
  it('P1 — absolute paths outside the workdir table', () => {
    const r = scrubForPublish(
      snap([
        note('n1', 'Key lives at /Users/owner/.ssh/id_rsa; see /Users/owner/other-repo/NOTES.md'),
        terminal('t1', { command: 'bash /Users/owner/.cookrew/deploy.sh' })
      ])
    )
    expect(r.ok).toBe(true)
    const out = canonicalJson(r.ok ? r.snapshot : {})
    console.log('P1 report:', JSON.stringify(r.report))
    console.log('P1 leaked "/Users/owner":', out.includes('/Users/owner'))
    console.log('P1 body:', out)
  })

  it('P2 — credential shapes the pattern list does not cover', () => {
    const creds = [
      `STRIPE=sk_live_${'0'.repeat(24)}`,
      'GH=github_pat_11ABCDEFG0aBcDeFgHiJkL_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij1234567890',
      'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      'DATABASE_URL=postgres://admin:hunter2SuperSecret@db.internal:5432/prod',
      'OPENAI_API_KEY=sk-proj-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
    ]
    for (const c of creds) {
      const r = scrubForPublish(snap([note('n1', c)]))
      console.log(`P2 ${c.split('=')[0].padEnd(22)} -> ${r.ok ? 'PUBLISHES' : 'blocked'}`)
    }
  })

  it('P3 — the team name itself', () => {
    const r = scrubForPublish(
      snap([terminal('t1')], { name: '/Users/owner/secret-client sk-ant-aaaaaaaaaaaaaaaaaaaaaaaa' })
    )
    console.log('P3 ok:', r.ok, 'name shipped as:', r.ok ? r.snapshot.name : '(blocked)')
  })

  it('P4 — env-ish fields on a terminal that the spread carries through', () => {
    const r = scrubForPublish(
      snap([terminal('t1', { env: { OPENAI_API_KEY: 'sk-proj-ZZZZZZZZZZZZZZZZZZZZZZZZZZZZ' } })])
    )
    console.log('P4 ok:', r.ok, 'node:', r.ok ? JSON.stringify(r.snapshot.nodes[0]) : '(blocked)')
  })
})
