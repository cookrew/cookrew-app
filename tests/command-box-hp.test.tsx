// LANE HP-BOX: the renderer side of the HP contract. The hold inversion and
// the distinct act are tested on the machine with fake timers; the echo, the
// sous rows and the draft chip as static markup (no DOM env, the house way).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createHold, enterAction, holdMode, modeBadge, needsSendAnyway } from '../src/renderer/src/decision-hold'
import { appendAlternates, draftOnOpen, inboxRowId, isDecisionUpdate, sousRowActions } from '../src/renderer/src/command-box-feed'
import { DECISION_HOLD_MS } from '../src/shared/sous-decide'
import type { Decision } from '../src/main/sous-control'
import type { InboxRow } from '../src/shared/inbox-rank'

const base: Decision = {
  kind: 'ask',
  target: { id: 'forge', name: 'Forge' },
  alternates: [{ kind: 'ask', id: 'tinker', name: 'Tinker', reasons: ['idle', 'same repo', 'role: Bugfix'] }],
  reasons: ['idle', 'same repo', 'last touched README · 2h'],
  recruit: { harness: 'Claude Code', name: 'Install Section', beside: null, direct: true },
  token: 't1',
  holdMs: 2500,
  sentence: 'Make the install section of README English'
}

function harness(d: Decision) {
  const commits: { target?: string; ack?: string }[] = []
  const cancels: string[] = []
  const hold = createHold(d, { onTick: () => undefined, onCommit: (target, ack) => commits.push({ target, ack }), onCancel: (t) => cancels.push(t) })
  return { hold, commits, cancels }
}

const stubDesktop = (): void => {
  const store = new Map<string, string>()
  const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) }
  ;(globalThis as unknown as { window: Record<string, unknown> }).window = {
    location: { origin: 'http://localhost', search: '', hash: '', href: 'http://localhost/' },
    localStorage: storage,
    sessionStorage: storage,
    history: { replaceState: () => undefined },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    cookrew: {}
  }
  ;(globalThis as unknown as { localStorage: unknown }).localStorage = storage
}
async function box(): Promise<typeof import('../src/renderer/src/CommandBox')> {
  stubDesktop()
  vi.resetModules()
  return import('../src/renderer/src/CommandBox')
}

describe('1 · the hold inversion', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('ticks by default and commits at 2.5 s, once', () => {
    expect(DECISION_HOLD_MS).toBe(2500)
    const h = harness({ ...base, holdMs: undefined as unknown as number })
    expect(h.hold.mode).toBe('ticking')
    vi.advanceTimersByTime(2400)
    expect(h.commits).toEqual([])
    vi.advanceTimersByTime(200)
    expect(h.commits).toEqual([{ target: undefined, ack: undefined }])
  })

  it('mode paused starts paused and never ticks on its own; question and answer show text with no hold', () => {
    const paused = harness({ ...base, mode: 'paused', exposureWhy: 'the target will respawn' })
    vi.advanceTimersByTime(10_000)
    expect(paused.hold.state).toBe('paused')
    expect(paused.commits).toEqual([])
    paused.hold.resume()
    expect(paused.hold.state).toBe('paused')
    expect(modeBadge(paused.hold ? { ...base, mode: 'paused', exposureWhy: 'the target will respawn' } : base, 'paused', 2500)).toBe('paused — the target will respawn')
    const q = harness({ kind: 'question', question: 'Which repo?', reasons: [], token: 'q', holdMs: 2500, sentence: 'x', mode: 'question' })
    vi.advanceTimersByTime(10_000)
    expect(q.commits).toEqual([])
    expect(modeBadge({ kind: 'question', mode: 'question' }, 'paused', 0)).toBe('question')
    expect(modeBadge({ kind: 'ask', mode: 'answer' }, 'paused', 0)).toBe('answer')
    expect(modeBadge(base, 'ticking', 2500)).toBe('auto in 2.5 s · or ↵ now')
    expect(holdMode({ kind: 'question' })).toBe('question')
    expect(holdMode({ kind: 'ask' })).toBe('ticking')
  })
})

describe('2 · the distinct act for exposure ≥ 2', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('Enter never commits an exposure-2 decision — it focuses SEND ANYWAY; the click commits once with the ack', () => {
    const exposed: Decision = { ...base, mode: 'paused', exposure: 2, exposureWhy: 'pushes to origin', boundaries: 'push only after the check passes' }
    expect(needsSendAnyway(exposed)).toBe(true)
    expect(enterAction(exposed, exposed.sentence)).toBe('focus-send-anyway')
    expect(enterAction(base, base.sentence)).toBe('commit')
    expect(enterAction(exposed, 'something else')).toBe('resubmit')
    const h = harness(exposed)
    vi.advanceTimersByTime(10_000)
    expect(h.commits).toEqual([])
    h.hold.commit(undefined, 'send-anyway')
    h.hold.commit(undefined, 'send-anyway')
    expect(h.commits).toEqual([{ target: undefined, ack: 'send-anyway' }])
  })

  it('draws the Boundaries line as a yellow row with the SEND ANYWAY button, and change ▾ still there', async () => {
    const { CommandBox } = await box()
    const exposed: Decision = { ...base, mode: 'paused', exposure: 2, exposureWhy: 'pushes to origin', boundaries: 'push only after the check passes' }
    const html = renderToStaticMarkup(<CommandBox open onClose={() => undefined} phone={false} rows={[]} initialDecision={exposed} />)
    expect(html).toContain('class="cmd-boundary"')
    expect(html).toContain('⚠ push only after the check passes')
    expect(html).toContain('class="send-anyway"')
    expect(html).toContain('SEND ANYWAY')
    expect(html).toContain('data-mode="paused"')
    expect(html).toContain('paused — pushes to origin')
    expect(html).toContain('change ▾')
    expect(html).not.toContain('or ↵ now')
  })
})

describe('3 · the model in the echo', () => {
  it('→ Forge · <effective or route (pinned at start)>; — when null; nothing on an older main', async () => {
    const { echoLine, routeLabel } = await box()
    expect(echoLine({ ...base, route: { route: 'group/smart', effective: 'deepseek/deepseek-v4' } })).toBe('→ Forge · deepseek/deepseek-v4 (idle · same repo · last touched README · 2h)')
    expect(echoLine({ ...base, route: { route: 'group/smart', effective: null } })).toBe('→ Forge · group/smart (pinned at start) (idle · same repo · last touched README · 2h)')
    expect(echoLine({ ...base, route: null })).toBe('→ Forge · — (idle · same repo · last touched README · 2h)')
    expect(echoLine(base)).toBe('→ Forge (idle · same repo · last touched README · 2h)')
    expect(routeLabel({})).toBeNull()
    const recruit: Decision = { kind: 'recruit', harness: 'Claude Code', name: 'Prune v1', beside: null, alternates: [], reasons: ['repo-wide'], direct: false, token: 'r', holdMs: 2500, sentence: 'prune', route: { route: 'group/smart', effective: null } }
    expect(echoLine(recruit)).toBe('+ Claude Code card · Prune v1 · group/smart (pinned at start) (repo-wide)')
  })
})

describe('4 · late revisions append alternates and nothing else', () => {
  it('appends by id, keeps what was there, ignores repeats, and refuses a frame of the wrong shape', () => {
    const more = [{ kind: 'recruit' as const, id: 'harness:Codex', name: 'Codex', harness: 'Codex' as const, reasons: ['repo-wide → Codex'] }, { ...base.alternates[0] }]
    const merged = appendAlternates(base.alternates, more)
    expect(merged.map((a) => a.id)).toEqual(['tinker', 'harness:Codex'])
    expect(appendAlternates(base.alternates, [base.alternates[0]])).toEqual(base.alternates)
    expect(isDecisionUpdate({ token: 't1', alternates: more })).toBe(true)
    expect(isDecisionUpdate({ token: 't1', alternates: [{ name: 'x' }] })).toBe(false)
    expect(isDecisionUpdate({ token: 't1', target: { id: 'x' } })).toBe(false)
    // A revision carries no target, mode or brief the box would read: only `alternates` is merged.
    const revised = { ...base, alternates: merged }
    expect(revised.target).toEqual(base.target)
    expect(revised.sentence).toBe(base.sentence)
  })
})

describe('5 · sous inbox rows', () => {
  const sousRow = (over: Partial<InboxRow>): InboxRow => ({
    nodeId: 'bench-2',
    nodeName: 'Bench 2',
    nodeKind: 'terminal',
    workspaceId: 'ws',
    workspaceName: 'Cookrew Dev',
    kind: 'sous',
    kinds: ['sous'],
    reasons: ['the brief never reached the card'],
    since: Date.now() - 3 * 60_000,
    waitMinutes: 3,
    served: false,
    blockedDownstream: 0,
    score: 1,
    id: 'sous-1',
    action: 'retry',
    dismissable: true,
    text: 'Audit every README for stale install lines',
    ...over
  })

  it('draws the icon, the proposal on one line, RETRY and DISMISS; an answer row has DISMISS alone', async () => {
    const { CommandBox } = await box()
    const html = renderToStaticMarkup(<CommandBox open onClose={() => undefined} phone={false} rows={[sousRow({}), sousRow({ id: 'sous-2', nodeName: 'Sous', action: null, text: 'Three cards are idle in this repo.' })]} />)
    expect(html).toContain('data-kind="sous"')
    expect(html).toContain('✦')
    expect(html).toContain('<b>Bench 2</b><span>Audit every README for stale install lines</span>')
    expect(html).toContain('>RETRY<')
    expect(html).toContain('<b>Sous</b><span>Three cards are idle in this repo.</span>')
    expect(html.match(/>DISMISS</g)).toHaveLength(2)
    expect(html.match(/>OPEN</g)).toBeNull()
    expect(sousRowActions(sousRow({ action: 'open' }))).toEqual({ act: 'open', dismiss: true })
    expect(sousRowActions(sousRow({ action: null, dismissable: false }))).toEqual({ act: null, dismiss: false })
    expect(sousRowActions({ kind: 'waiting' })).toEqual({ act: null, dismiss: false })
    expect(inboxRowId(sousRow({}))).toBe('sous-1')
    expect(inboxRowId({ nodeId: 'n' })).toBe('n')
  })
})

describe('6 · draft hygiene', () => {
  it('a non-empty field on open shows the draft chip; an empty one does not', async () => {
    const { CommandBox } = await box()
    expect(draftOnOpen('  ')).toBe(false)
    expect(draftOnOpen('rename Forge')).toBe(true)
    const html = renderToStaticMarkup(<CommandBox open onClose={() => undefined} phone={false} rows={[]} initialText="rename Forge to Anvil" />)
    expect(html).toContain('class="cmd-draft"')
    expect(html).toContain('draft from earlier —')
    expect(html).toContain('>clear?<')
    expect(html).toContain('value="rename Forge to Anvil"')
    const clean = renderToStaticMarkup(<CommandBox open onClose={() => undefined} phone={false} rows={[]} />)
    expect(clean).not.toContain('cmd-draft')
  })
})
