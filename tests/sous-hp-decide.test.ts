// THE HOLD MACHINE (HP round, lane hp-decide): ticking by default, paused for
// exposure ≥ 2 and a respawn, needs-ack on a paused exposure-2 commit, a late
// revision that only appends, a cancel that clears the pending sentence, a
// chore outside the repo, and a status question answered from the board.
import { describe, expect, it } from 'vitest'
import { ACK_EXPOSURE, holdMode, SousController, type SousControlDeps } from '../src/main/sous-control'
import { DECISION_HOLD_MS, type DecideCandidate } from '../src/shared/sous-decide'
import type { IntentRoster } from '../src/shared/sous-intent'
import { enterAction, holdMode as boxHoldMode, modeBadge, needsSendAnyway } from '../src/renderer/src/decision-hold'

const NOW = Date.parse('2026-10-12T09:00:00Z')
const H = 3_600_000
const card = (patch: Partial<DecideCandidate> & Pick<DecideCandidate, 'id'>): DecideCandidate => ({
  name: patch.id[0].toUpperCase() + patch.id.slice(1),
  workspaceId: 'ws',
  cwd: '/repo',
  role: null,
  orch: false,
  phase: 'done',
  contextFull: false,
  lastTask: null,
  lastActivityAt: NOW - H,
  ...patch
})
const crew = [
  card({ id: 'conductor', orch: true, phase: 'working', lastTask: 'orchestrating the release' }),
  card({ id: 'forge', role: 'Developer', lastTask: 'README install section → EN', lastActivityAt: NOW - 2 * H }),
  card({ id: 'tinker', role: 'Bugfix', phase: 'waiting', lastTask: 'cable signal QA', lastActivityAt: NOW - 40 * 60_000 }),
  card({ id: 'guest', role: 'Developer', served: true })
]
const roster: IntentRoster = {
  agents: [
    { id: 'conductor', name: 'Conductor', workspaceId: 'ws', workspaceName: 'Dev', orch: true },
    { id: 'forge', name: 'Forge', workspaceId: 'ws', workspaceName: 'Dev', role: 'Developer' },
    { id: 'tinker', name: 'Tinker', workspaceId: 'ws', workspaceName: 'Dev', role: 'Bugfix' }
  ],
  workspaces: [{ id: 'ws', name: 'Dev' }],
  presets: ['Claude Code', 'Codex', 'OpenCode', 'Pi', 'Shell']
}

function controller(options: { respawn?: boolean; openDispatches?: number } = {}) {
  const calls: string[] = []
  const ledger: Array<Record<string, unknown>> = []
  const updates: Array<{ token: string; alternates: unknown[] }> = []
  let minted = 0
  const deps: SousControlDeps = {
    roster: () => roster,
    activeWorkspaceId: () => 'ws',
    switchWorkspace: () => undefined,
    createTerminal: ({ name }) => ({ id: 'new', name }),
    createBrowser: async () => undefined,
    connect: (a, b) => calls.push(`connect ${a} ${b}`),
    rename: () => undefined,
    submit: async (id, text) => {
      calls.push(`submit ${id} ${text}`)
    },
    ui: (command) => calls.push(`ui ${command.kind}`),
    now: () => NOW,
    decide: {
      candidates: () => crew,
      workdir: () => '/repo',
      recruit: ({ preset, name, cwd, besideId }) => {
        calls.push(`recruit ${preset} "${name}" cwd ${cwd} beside ${besideId ?? '-'}`)
        return { id: 'recruited', name }
      },
      deliver: async ({ nodeId, sentence }) => {
        calls.push(`deliver ${nodeId} ${JSON.stringify(sentence)}`)
        return { dispatchId: `d-${nodeId}` }
      },
      token: () => `t${++minted}`,
      status: () => ({ openDispatches: options.openDispatches ?? 0 }),
      routeOf: ({ cardId }) => (cardId ? { route: 'group/auto', effective: 'direct', respawn: options.respawn ?? false } : null),
      ledger: { write: (patch) => ledger.push(patch) },
      decisionUpdated: (u) => updates.push(u)
    }
  }
  return { calls, ledger, updates, sous: new SousController(deps) }
}

describe('holdMode — ticking unless one of the four applies', () => {
  it('ticking by default; paused for exposure ≥ 2, a respawn, a rewritten brief, or a non-box trigger; a question is its own mode', () => {
    expect(holdMode({ kind: 'ask', answer: false, exposure: 1, respawn: false, rewritten: false, box: true })).toBe('ticking')
    expect(holdMode({ kind: 'ask', answer: false, exposure: 2, respawn: false, rewritten: false, box: true })).toBe('paused')
    expect(holdMode({ kind: 'ask', answer: false, exposure: 0, respawn: true, rewritten: false, box: true })).toBe('paused')
    expect(holdMode({ kind: 'ask', answer: false, exposure: 0, respawn: false, rewritten: true, box: true })).toBe('paused')
    expect(holdMode({ kind: 'recruit', answer: false, exposure: 0, respawn: false, rewritten: false, box: false })).toBe('paused')
    expect(holdMode({ kind: 'question', answer: false, exposure: 0, respawn: false, rewritten: false, box: true })).toBe('question')
    expect(holdMode({ kind: 'question', answer: true, exposure: 0, respawn: false, rewritten: false, box: true })).toBe('answer')
    expect(ACK_EXPOSURE).toBe(2)
    expect(DECISION_HOLD_MS).toBe(2500)
  })
})

describe('the decision carries mode, exposure, boundaries, domain and route', () => {
  it('an edit to the repo ticks for 2,500 ms with its route and no boundary line', async () => {
    const h = controller()
    const r = await h.sous.handle({ text: 'fix the install section of README', surface: 'canvas', box: true })
    expect(r.decision).toMatchObject({ kind: 'ask', mode: 'ticking', exposure: 1, exposureWhy: 'fix', boundaries: null, domain: 'repo', holdMs: 2500, route: { route: 'group/auto', effective: 'direct' } })
  })

  it('a card that will respawn starts paused even at exposure 1', async () => {
    const h = controller({ respawn: true })
    const r = await h.sous.handle({ text: 'fix the install section of README', surface: 'canvas', box: true })
    expect(r.decision?.mode).toBe('paused')
  })

  it('exposure 2 starts paused, refuses a plain commit with needs-ack, and the ack commits with the Boundaries line appended', async () => {
    const h = controller()
    const r = await h.sous.handle({ text: 'push the install section of README to the branch', surface: 'canvas', box: true })
    expect(r.decision).toMatchObject({ kind: 'ask', mode: 'paused', exposure: 2, boundaries: 'push only after the check passes' })
    const token = r.decision?.token ?? ''
    const plain = await h.sous.commit(token)
    expect(plain).toMatchObject({ intent: 'refused', error: 'needs-ack' })
    expect(h.calls.filter((c) => c.startsWith('deliver'))).toEqual([])
    const acked = await h.sous.commit(token, { ack: 'send-anyway' })
    expect(acked.intent).toBe('ask')
    expect(h.calls.filter((c) => c.startsWith('deliver'))).toEqual(['deliver forge "push the install section of README to the branch\\n\\nBoundaries: push only after the check passes"'])
    // the ledger saw: minted → send-anyway with the proposal → delivered to → delivered with the dispatch id
    expect(h.ledger.map((p) => p.ownerResponse ?? p.outcome ?? p.deliveredTo)).toEqual(['pending', 'send-anyway', 'forge', 'delivered'])
    expect(h.ledger.at(-1)).toMatchObject({ dispatchId: 'd-forge' })
  })
})

describe('revise — late answers only append', () => {
  it('appends new alternates, emits the update, and never changes target, mode or brief', async () => {
    const h = controller()
    const r = await h.sous.handle({ text: 'fix the install section of README', surface: 'canvas', box: true })
    const token = r.decision?.token ?? ''
    const before = r.decision
    expect(h.sous.revise(token, [{ kind: 'ask', id: 'tinker', name: 'Tinker', reasons: ['scored second'] }])).toBe(true)
    expect(h.updates).toHaveLength(1)
    expect(h.updates[0].alternates.map((a) => (a as { id: string }).id)).toContain('tinker')
    // the shown decision kept everything but the list
    const slot = (h.sous as unknown as { decisions: Map<string, { decision: Record<string, unknown> }> }).decisions.get(token)
    expect(slot?.decision).toMatchObject({ target: before?.kind === 'ask' ? before.target : null, mode: before?.mode, sentence: before?.sentence })
    // the same alternate again appends nothing
    expect(h.sous.revise(token, [{ kind: 'ask', id: 'tinker', name: 'Tinker', reasons: [] }])).toBe(false)
    // and the appended alternate is committable
    expect((await h.sous.commit(token, { target: 'tinker' })).intent).toBe('ask')
  })

  it('a revise after the commit is ignored', async () => {
    const h = controller()
    const r = await h.sous.handle({ text: 'fix the install section of README', surface: 'canvas', box: true })
    const token = r.decision?.token ?? ''
    await h.sous.commit(token)
    expect(h.sous.revise(token, [{ kind: 'ask', id: 'tinker', name: 'Tinker', reasons: [] }])).toBe(false)
    expect(h.updates).toHaveLength(0)
  })
})

describe('cancel clears the pending sentence; chores and status answers', () => {
  it('a box close clears whatever Sous was still asking this caller, with or without a decision on the line', async () => {
    const h = controller()
    // "ask Forge" leaves Sous asking "what should I ask Forge?" — the box closes with no decision token
    await h.sous.handle({ text: 'ask Forge', surface: 'canvas', callerId: 'desktop' })
    expect(h.sous.pendingFor('canvas', 'desktop')).not.toBeNull()
    expect(h.sous.cancel('', { surface: 'canvas', callerId: 'desktop' })).toBe(false)
    expect(h.sous.pendingFor('canvas', 'desktop')).toBeNull()
    // another caller's pending question is not touched
    await h.sous.handle({ text: 'ask Forge', surface: 'phone', callerId: 'p1' })
    h.sous.cancel('', { surface: 'canvas', callerId: 'desktop' })
    expect(h.sous.pendingFor('phone', 'p1')).not.toBeNull()
    // and with a decision on the line, cancel drops it and the ledger says so
    const r = await h.sous.handle({ text: 'fix the install section of README', surface: 'canvas', box: true, callerId: 'desktop' })
    expect(h.sous.cancel(r.decision?.token ?? '', { surface: 'canvas', callerId: 'desktop' })).toBe(true)
    expect(h.ledger.at(-1)).toMatchObject({ ownerResponse: 'cancel', outcome: 'cancelled' })
  })

  it('a chore recruits Claude Code in ~/.cookrew/chores with no orch beside it, and says why', async () => {
    const h = controller()
    const r = await h.sous.handle({ text: 'draft a limerick about the weather', surface: 'canvas', box: true })
    expect(r.decision).toMatchObject({ kind: 'recruit', domain: 'chore', harness: 'Claude Code', cwd: 'chores', beside: null })
    if (r.decision?.kind === 'recruit') expect(r.decision.reasons[0]).toBe('not a repo task')
    await h.sous.commit(r.decision?.token ?? '')
    expect(h.calls.find((c) => c.startsWith('recruit'))).toBe('recruit Claude Code "Draft Limerick Weather" cwd chores beside -')
  })

  it('a status question is answered from the board — who waits and how long, what runs, open dispatches — and nothing is minted', async () => {
    const h = controller({ openDispatches: 2 })
    const r = await h.sous.handle({ text: "who's waiting on me?", surface: 'canvas', box: true })
    expect(r.decision).toMatchObject({ kind: 'question', mode: 'answer', domain: 'question' })
    expect(r.spoken).toBe('waiting on you: Tinker (40m) · running: Conductor · 2 dispatches open.')
    expect(h.ledger).toHaveLength(0)
    expect((await h.sous.commit(r.decision?.token ?? '')).error).toBe('expired')
  })

  it('a served seat never becomes a target even when its role matches', async () => {
    const h = controller()
    const r = await h.sous.handle({ text: 'developer: fix the README install section', surface: 'canvas', box: true })
    expect(r.decision?.kind).toBe('ask')
    if (r.decision?.kind === 'ask') {
      expect(r.decision.target.id).toBe('forge')
      expect(r.decision.alternates.map((a) => a.id)).not.toContain('guest')
    }
  })
})

// INTEGRATION (route-merge): the decision main mints is the one the box
// reads. Velvet's decision-hold.ts readers are run over a decision minted
// through sous-control — mode, exposure, exposureWhy, boundaries, route and
// domain arrive on the wire, and the box's own rules agree with main's.
describe('the box receives what main minted', () => {
  it('an exposure-2 ask: paused, SEND ANYWAY required, the badge names why, Enter focuses the control, the route label is the card\'s', async () => {
    const h = controller()
    const r = await h.sous.handle({ text: 'push the install section of README to the branch', surface: 'canvas', box: true })
    const d = r.decision
    expect(d).toBeDefined()
    if (!d) return
    expect(d).toMatchObject({ mode: 'paused', exposure: 2, exposureWhy: 'push', boundaries: 'push only after the check passes', domain: 'repo', route: { route: 'group/auto', effective: 'direct' }, holdMs: 2500 })
    expect(boxHoldMode(d)).toBe('paused')
    expect(needsSendAnyway(d)).toBe(true)
    expect(modeBadge(d, 'paused', 0)).toBe('paused — push')
    expect(enterAction(d, d.sentence)).toBe('focus-send-anyway')
    // the plain commit main refuses is the same act the box refuses to take on Enter
    expect((await h.sous.commit(d.token)).error).toBe('needs-ack')
  })

  it('an exposure-1 ask ticks: the box auto-commits on its clock and Enter commits', async () => {
    const h = controller()
    const r = await h.sous.handle({ text: 'fix the install section of README', surface: 'canvas', box: true })
    const d = r.decision
    if (!d) throw new Error('no decision')
    expect(d).toMatchObject({ mode: 'ticking', exposure: 1, boundaries: null, domain: 'repo' })
    expect(boxHoldMode(d)).toBe('ticking')
    expect(needsSendAnyway(d)).toBe(false)
    expect(modeBadge(d, 'ticking', 2500)).toBe('auto in 2.5 s · or ↵ now')
    expect(enterAction(d, d.sentence)).toBe('commit')
  })

  it('a status question arrives as mode answer with the answer text; a chore as a recruit with cwd chores', async () => {
    const h = controller({ openDispatches: 1 })
    const a = (await h.sous.handle({ text: 'what is the status?', surface: 'canvas', box: true })).decision
    expect(a).toMatchObject({ kind: 'question', mode: 'answer', domain: 'question' })
    if (a?.kind === 'question') expect(a.answer).toMatch(/^waiting on you: Tinker/)
    expect(boxHoldMode(a as NonNullable<typeof a>)).toBe('answer')
    const c = (await h.sous.handle({ text: 'draft a limerick about the weather', surface: 'canvas', box: true })).decision
    // "draft" names no tier: exposure 0, nothing leaves the machine
    expect(c).toMatchObject({ kind: 'recruit', cwd: 'chores', domain: 'chore', mode: 'ticking', exposure: 0, boundaries: null })
  })
})
