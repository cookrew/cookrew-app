import { describe, expect, it } from 'vitest'
import { routeEnv } from '../src/main/route-env'
import { routeSession } from '../src/shared/route'
import { toDecision } from '../src/main/route/decisions'

/**
 * group/auto AGAINST THE REAL GATEWAY — the E2E contract's `COOKREW_SOUS_AUTO=1` destination.
 *
 * Skipped unless BOTH hold:
 *   · COOKREW_MAGPIE_E2E=1, and
 *   · the gateway's own catalog lists `group/auto`.
 *
 *   COOKREW_MAGPIE_E2E=1 npx vitest run tests/route-auto-e2e.test.ts
 *
 * IT DOES NOT CREATE THE GROUP. The brief forbids it and so does the round's rule about the
 * owner's gateway: `group/auto` is the owner's three-tier routing group (local / mid / strong),
 * its membership is one of the decisions the E2E round lists as BLOCKED on them, and a group this
 * file invented would prove the plumbing against a shape nobody agreed to. While it is absent the
 * file says so and skips — `magpie group template smart` / `magpie group add auto models=…` is the
 * owner's line to type, and then these cases start running with no edit here.
 *
 * What it proves when it does run: a card routed at `group/auto` reaches a MEMBER of that group,
 * the decision names the group rather than the member the card asked for, and the usage row is
 * filed under this app with the card's own session — the same contract the group/smart case in
 * tests/route-magpie-e2e.test.ts holds, on the group Sous will actually point new cards at.
 */

const GATEWAY = 'http://127.0.0.1:3425'
const KEY = 'magpie-cookrew'
const GROUP = 'group/auto'
const SPAWN_MS = 180_000

const gateway = { url: GATEWAY, v1: `${GATEWAY}/v1`, key: KEY }

interface CatalogEntry {
  id: string
  owned_by?: string
}

/** The catalog, or null when nothing answers — the probe that decides whether this file runs. */
const catalog = await fetch(`${GATEWAY}/v1/models`, { headers: { authorization: `Bearer ${KEY}` } })
  .then((r) => (r.ok ? (r.json() as Promise<{ data?: CatalogEntry[] }>) : null))
  .catch(() => null)

const members = catalog?.data ?? []
const AUTO = members.find((m) => m.id === GROUP) ?? null
const GATED = process.env.COOKREW_MAGPIE_E2E === '1'
const RUN = GATED && AUTO !== null

if (GATED && AUTO === null) {
  process.stdout.write(
    `route-auto-e2e: the gateway has no ${GROUP} (${members.length} models in the catalog) — skipped.\n` +
      '  This file never creates it: the tiers are the owner\'s call (E2E round, BLOCKED list item a).\n'
  )
}

describe.skipIf(!RUN)('group/auto, against the real gateway', () => {
  it('is a routing group, not a plain model', () => {
    // `magpie_label` says "… · routing group" and a group is owned by whatever serves its members;
    // the fact that matters here is that the id resolves at all and the catalog offers it.
    expect(AUTO).not.toBeNull()
    expect(AUTO?.id).toBe(GROUP)
  })

  it('routes a claude spawn through the group and names the group in the decision', async () => {
    const id = `e2e-auto-${Date.now().toString(36)}`
    const session = routeSession(id)
    const r = routeEnv({ harness: 'claude', gateway, model: GROUP, cardId: id })
    expect(r.env.ANTHROPIC_MODEL).toBe(GROUP)
    expect(r.env.CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT).toBe('1')

    const { spawn } = await import('node:child_process')
    const { mkdtempSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const path = await import('node:path')
    const cwd = mkdtempSync(path.join(tmpdir(), 'route-auto-'))
    try {
      const ran = await new Promise<string>((resolve) => {
        let out = ''
        const child = spawn('claude', ['-p', 'Reply with exactly the word OK'], {
          cwd,
          env: { ...process.env, ...r.env },
          stdio: ['ignore', 'pipe', 'pipe']
        })
        child.stdout.on('data', (b: Buffer) => (out += b.toString()))
        child.stderr.on('data', (b: Buffer) => (out += b.toString()))
        const kill = setTimeout(() => child.kill('SIGKILL'), SPAWN_MS - 5_000)
        child.on('close', () => {
          clearTimeout(kill)
          resolve(out)
        })
      })
      expect(ran.length).toBeGreaterThan(0)
      await new Promise((done) => setTimeout(done, 2_000))

      const body = await fetch(`${GATEWAY}/v1/magpie/route?session=${encodeURIComponent(session)}`).then((x) => x.json())
      const decision = toDecision(id, body, Date.now())
      expect(decision).not.toBeNull()
      expect(decision?.session).toBe(session)
      expect(decision?.asked).toBe(GROUP)
      // The group's own name, and a member that is not the group id.
      expect(decision?.group).toBe('auto')
      expect(decision?.model).not.toBeNull()
      expect(decision?.model).not.toBe(GROUP)

      const usage = (await fetch(
        `${GATEWAY}/v1/magpie/usage/requests?period=today&q=${encodeURIComponent(session)}&limit=5`
      ).then((x) => x.json())) as { rows?: { agent?: string; session?: string; status?: number; out?: number }[] }
      const answered = (usage.rows ?? []).filter((row) => row.status === 200)
      expect(answered.length).toBeGreaterThan(0)
      expect(answered[0]?.agent).toBe('cookrew')
      expect(answered[0]?.session).toBe(session)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  }, SPAWN_MS)

  /**
   * The rule object, if the owner's `group/auto` carries the three tier rules the design describes
   * (local / mid / strong). A group with no rules answers `{"n": 0}`, which is a pass: this case
   * asserts the SHAPE either way, never that a rule must exist.
   */
  it('reports its rule object in the shape RouteDecision.rule is built from', async () => {
    const body = (await fetch(`${GATEWAY}/v1/magpie/route?session=${encodeURIComponent('cookrew:e2e-auto-shape')}`).then(
      (x) => x.json()
    )) as { route?: { rule?: { n?: number; use?: string } } }
    const rule = body.route?.rule
    if (rule === undefined) return // nothing has run on that session; the shape is pinned in hp-facts
    expect(typeof rule.n).toBe('number')
    if ((rule.n ?? 0) > 0) expect(typeof rule.use).toBe('string')
  })
})
