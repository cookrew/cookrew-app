import { describe, expect, it } from 'vitest'
import { decide, isQuestion, pickHarness, placeBeside, titleOf, type DecideCandidate } from '../src/shared/sous-decide'

const NOW = Date.parse('2026-10-11T10:00:00Z')
const H = 3_600_000
const card = (patch: Partial<DecideCandidate> & Pick<DecideCandidate, 'id'>): DecideCandidate => ({
  name: patch.id,
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
  card({ id: 'conductor', name: 'Conductor', orch: true, phase: 'working', lastTask: 'orchestrating the release' }),
  card({ id: 'forge', name: 'Forge', role: 'Developer', lastTask: 'README install section → EN', lastActivityAt: NOW - 2 * H }),
  card({ id: 'tinker', name: 'Tinker', role: 'Bugfix', lastTask: 'cable signal QA', lastActivityAt: NOW - 40 * 60_000 }),
  card({ id: 'magpie', name: 'Magpie', role: 'QA (Browser)', phase: 'working' }),
  card({ id: 'elsewhere', name: 'Elsewhere', cwd: '/other', role: 'Developer' })
]
const ctx = { candidates: crew, workdir: '/repo', now: NOW }

describe('decide — ask an existing card', () => {
  it('picks the idle same-repo card whose role or last task matches, and names three reasons', () => {
    const d = decide('Make the install section of README English and add a test for the install script', ctx)
    expect(d.kind).toBe('ask')
    if (d.kind !== 'ask') return
    expect(d.target).toEqual({ id: 'forge', name: 'Forge' })
    expect(d.reasons).toHaveLength(3)
    expect(d.reasons[0]).toBe('idle')
    expect(d.reasons[1]).toBe('same repo')
    expect(d.reasons[2]).toMatch(/last touched (readme|install)/)
    expect(d.reasons[2]).toMatch(/2h/)
  })

  it('a role word in the sentence beats a last-task word, and the alternate is the next fit', () => {
    const d = decide('bugfix: the cable signal flickers on the harness view', ctx)
    expect(d.kind).toBe('ask')
    if (d.kind !== 'ask') return
    expect(d.target.name).toBe('Tinker')
    expect(d.reasons[2]).toBe('role: Bugfix')
    expect(d.alternates).toEqual([])
  })

  it('never picks a working card, a full card, or a card in another repo', () => {
    const d = decide('Log in through the browser wall on the staging site', {
      ...ctx,
      candidates: [
        ...crew,
        card({ id: 'full', name: 'Full', role: 'QA (Browser)', contextFull: true }),
        card({ id: 'far', name: 'Far', cwd: '/other', role: 'QA (Browser)' })
      ]
    })
    // Magpie is the role match but is working; Full is full; Far is elsewhere → nobody fits
    expect(d.kind).toBe('recruit')
  })
})

describe('decide — recruit a new card', () => {
  it('with no fitting card, recruits the harness the task shape asks for, beside the orch', () => {
    const d = decide('Delete every v1 route in the registry and keep the tests green', ctx)
    expect(d.kind).toBe('recruit')
    if (d.kind !== 'recruit') return
    // tests → long multi-step wins over repo-wide
    expect(d.harness).toBe('Claude Code')
    expect(d.beside).toEqual({ id: 'conductor', name: 'Conductor' })
    expect(d.reasons).toHaveLength(3)
    expect(d.reasons[0]).toBe('no idle card fits the brief')
    expect(d.reasons[2]).toBe('beside Conductor, wired to it')
    expect(d.alternates[0].name).toBe('Codex')
  })

  it('repo-wide review → Codex; light and local → Pi; a plain brief → Claude Code', () => {
    expect(pickHarness('Refactor every call site of the old logger, repo-wide').harness).toBe('Codex')
    expect(pickHarness('quick: explain what this file does, local is fine').harness).toBe('Pi')
    expect(pickHarness('Wire the new inbox into the phone bar').harness).toBe('Claude Code')
    expect(decide('Audit all the Stripe code paths', ctx).kind).toBe('recruit')
  })

  it('names the new card after the sentence', () => {
    expect(titleOf('Delete every v1 route in the registry and keep the tests green')).toBe('Delete V1 Route')
    expect(titleOf('把 registry 里的 v1 路由全删掉，保证测试还绿')).toBe('把 registry 里的…')
  })
})

describe('decide — a question stays a question', () => {
  it('asks back in the box and creates nothing', () => {
    for (const said of ['下周发版', 'Should we release next week?', 'release next week', 'what is Forge doing']) {
      const d = decide(said, ctx)
      expect(d.kind, said).toBe('question')
      if (d.kind === 'question') expect(d.question).toContain(said.replace(/[?？]$/u, ''))
    }
    expect(isQuestion('Make the install section of README English')).toBe(false)
  })
})

describe('placeBeside — the bench beside the orch, on the 110 px grid', () => {
  const size = { width: 640, height: 420 }
  it('lands to the right of the anchor on the grid, then slides past anything already there', () => {
    const orch = { position: { x: 1100, y: 220 }, size }
    const first = placeBeside(orch, [orch], size)
    expect(first).toEqual({ x: 1870, y: 220 })
    const occupied = { position: first, size }
    const second = placeBeside(orch, [orch, occupied], size)
    expect(second.x).toBeGreaterThanOrEqual(first.x + size.width)
    expect(second.x % 110).toBe(0)
    expect(second.y % 110).toBe(0)
  })
  it('with no anchor goes to the right of everything', () => {
    expect(placeBeside(null, [{ position: { x: 0, y: 115 }, size }], size)).toEqual({ x: 770, y: 110 })
  })
})

// ── the controller: the token is spent once, and dies after 30 s ──────────
import { SousController, type SousControlDeps } from '../src/main/sous-control'
import type { IntentRoster } from '../src/shared/sous-intent'

const roster: IntentRoster = {
  agents: [
    { id: 'conductor', name: 'Conductor', workspaceId: 'ws', workspaceName: 'Dev', orch: true },
    { id: 'forge', name: 'Forge', workspaceId: 'ws', workspaceName: 'Dev', role: 'Developer' },
    { id: 'tinker', name: 'Tinker', workspaceId: 'ws', workspaceName: 'Dev', role: 'Bugfix' }
  ],
  workspaces: [{ id: 'ws', name: 'Dev' }],
  presets: ['Claude Code', 'Codex', 'OpenCode', 'Pi', 'Shell']
}

function controller(): { calls: string[]; sous: SousController; tick: (ms: number) => void } {
  const calls: string[] = []
  let clock = NOW
  let minted = 0
  const deps: SousControlDeps = {
    roster: () => roster,
    activeWorkspaceId: () => 'ws',
    switchWorkspace: (id) => {
      calls.push(`switch ${id}`)
    },
    createTerminal: ({ preset, name }) => {
      calls.push(`create ${preset} ${name}`)
      return { id: 'new', name }
    },
    createBrowser: async () => undefined,
    connect: (a, b) => calls.push(`connect ${a} ${b}`),
    rename: () => undefined,
    submit: async (id, text, { enter }) => {
      calls.push(`${enter ? 'submit' : 'type'} ${id} ${text}`)
    },
    ui: (command, ws) => calls.push(`ui ${command.kind}${'nodeId' in command ? ` ${command.nodeId}` : ''} @${ws}`),
    note: (kind, id, detail) => calls.push(`note ${kind} ${id ?? '-'} ${detail}`),
    now: () => clock,
    decide: {
      candidates: () => crew,
      workdir: () => '/repo',
      recruit: ({ preset, name, role, besideId }) => {
        calls.push(`recruit ${preset} "${name}" beside ${besideId ?? '-'} role ${role.slice(0, 12)}`)
        return { id: 'recruited', name }
      },
      token: () => `t${++minted}`
    }
  }
  return { calls, sous: new SousController(deps), tick: (ms) => (clock += ms) }
}

describe('SousController — the decide step and its commit', () => {
  it('a brief the core does not match comes back as a decision, held, not executed', async () => {
    const h = controller()
    const r = await h.sous.handle({ text: 'Make the install section of README English and add a test for the install script', surface: 'canvas', box: true })
    expect(r.intent).toBe('decide')
    expect(r.decision?.kind).toBe('ask')
    expect(r.decision?.token).toBe('t1')
    expect(r.decision?.holdMs).toBe(1500)
    expect(r.spoken).toMatch(/^→ Forge \(idle · same repo · last touched/)
    expect(h.calls.filter((c) => c.startsWith('submit'))).toEqual([])
  })

  it('commit sends the brief to the chosen card exactly once; a second commit is refused', async () => {
    const h = controller()
    const r = await h.sous.handle({ text: 'Make the install section of README English and add a test', surface: 'canvas', box: true })
    const token = r.decision?.token ?? ''
    const done = await h.sous.commit(token)
    expect(done.intent).toBe('ask')
    expect(done.spoken).toBe('Sent to Forge')
    expect(h.calls).toContain('submit forge Make the install section of README English and add a test')
    expect(h.calls).toContain('ui zoom forge @ws')
    const again = await h.sous.commit(token)
    expect(again.intent).toBe('refused')
    expect(h.calls.filter((c) => c.startsWith('submit'))).toHaveLength(1)
  })

  it('the alternate re-targets the same brief', async () => {
    const h = controller()
    const r = await h.sous.handle({ text: 'bugfix: the install section of README flickers', surface: 'canvas', box: true })
    expect(r.decision?.kind).toBe('ask')
    const done = await h.sous.commit(r.decision?.token ?? '', { target: 'forge' })
    expect(done.spoken).toBe('Sent to Forge')
  })

  it('a token outlives nothing: 30 s later it is expired', async () => {
    const h = controller()
    const r = await h.sous.handle({ text: 'Make the install section of README English', surface: 'canvas', box: true })
    h.tick(30_001)
    const late = await h.sous.commit(r.decision?.token ?? '')
    expect(late.intent).toBe('refused')
    expect(late.spoken).toMatch(/expired/)
  })

  it('recruit places the harness beside the orch, wires it, and the alternate harness can be chosen', async () => {
    const h = controller()
    const r = await h.sous.handle({ text: 'Delete every v1 route in the registry and keep the tests green', surface: 'canvas', box: true })
    expect(r.decision?.kind).toBe('recruit')
    const done = await h.sous.commit(r.decision?.token ?? '', { target: 'harness:Codex' })
    expect(done.intent).toBe('create')
    expect(h.calls).toContain('recruit Codex "Delete V1 Route" beside conductor role Delete every')
    expect(h.calls).toContain('connect conductor recruited')
    expect(h.calls).toContain('ui zoom recruited @ws')
  })

  it('a question is answered in the box and leaves nothing to commit', async () => {
    const h = controller()
    const r = await h.sous.handle({ text: '下周发版', surface: 'canvas', box: true })
    expect(r.intent).toBe('decide')
    expect(r.decision?.kind).toBe('question')
    expect(r.spoken).toContain('下周发版')
    const none = await h.sous.commit(r.decision?.token ?? '')
    expect(none.intent).toBe('refused')
    expect(h.calls.filter((c) => c.startsWith('create') || c.startsWith('recruit') || c.startsWith('submit'))).toEqual([])
  })

  it('a zoomed terminal still gets dictation, never a decision', async () => {
    const h = controller()
    const r = await h.sous.handle({ text: 'Make the install section of README English', surface: 'zoom', focusedAgentId: 'forge' })
    expect(r.intent).toBe('prompt')
  })
})

describe('SousController — fix round 1: surfaces, targets, the token’s life', () => {
  it('HIGH 3 · only the surfaces with a box mint a decision; voice, the CLI and the gateway keep the regex core', async () => {
    const h = controller()
    const brief = 'Make the install section of README English and add a test'
    expect((await h.sous.handle({ text: brief, surface: 'canvas', box: true })).intent).toBe('decide')
    expect((await h.sous.handle({ text: brief, surface: 'phone', box: true })).intent).toBe('decide')
    expect((await h.sous.handle({ text: brief, surface: 'cli', box: true })).intent).toBe('none')
    expect((await h.sous.handle({ text: brief, surface: 'home', box: true })).intent).toBe('none')
    expect((await h.sous.handle({ text: brief, surface: 'zoom', focusedAgentId: 'forge' })).intent).toBe('prompt')
    // a command still works everywhere
    expect((await h.sous.handle({ text: 'rename Forge to Anvil', surface: 'cli' })).intent).toBe('rename')
  })

  it('HIGH 4 · commit takes only the choices shown: a stranger id or a harness on an ask is a bad target, and the decision stays', async () => {
    const h = controller()
    const r = await h.sous.handle({ text: 'Make the install section of README English and add a test', surface: 'canvas', box: true })
    const token = r.decision?.token ?? ''
    const stranger = await h.sous.commit(token, { target: 'conductor' })
    expect(stranger).toMatchObject({ intent: 'refused', error: 'bad-target' })
    const harness = await h.sous.commit(token, { target: 'harness:Codex' })
    expect(harness).toMatchObject({ intent: 'refused', error: 'bad-target' })
    expect(h.calls.filter((c) => c.startsWith('submit'))).toEqual([])
    // the token is still good: the shown target commits
    const ok = await h.sous.commit(token)
    expect(ok.intent).toBe('ask')
    expect(h.calls.filter((c) => c.startsWith('submit'))).toHaveLength(1)
  })

  it('HIGH 4 · a recruit takes its harness or an alternate harness, never a card', async () => {
    const h = controller()
    const r = await h.sous.handle({ text: 'Delete every v1 route in the registry and keep the tests green', surface: 'canvas', box: true })
    const token = r.decision?.token ?? ''
    expect(await h.sous.commit(token, { target: 'forge' })).toMatchObject({ intent: 'refused', error: 'bad-target' })
    expect(await h.sous.commit(token, { target: 'harness:Pi' })).toMatchObject({ intent: 'refused', error: 'bad-target' })
    expect((await h.sous.commit(token, { target: 'harness:Codex' })).intent).toBe('create')
  })

  it('HIGH 4 · a delivery that fails leaves the token in place, so the same echo can be committed again', async () => {
    const calls: string[] = []
    let fail = true
    const deps: SousControlDeps = {
      roster: () => roster,
      activeWorkspaceId: () => 'ws',
      switchWorkspace: () => undefined,
      createTerminal: () => ({ id: 'new', name: 'new' }),
      createBrowser: async () => undefined,
      connect: () => undefined,
      rename: () => undefined,
      submit: async (id, text) => {
        if (fail) throw new Error('input box is busy')
        calls.push(`submit ${id} ${text}`)
      },
      ui: () => undefined,
      now: () => NOW,
      decide: { candidates: () => crew, workdir: () => '/repo', recruit: () => ({ id: 'x', name: 'x' }), token: () => 'tok' }
    }
    const sous = new SousController(deps)
    await sous.handle({ text: 'Make the install section of README English and add a test', surface: 'canvas', box: true })
    const first = await sous.commit('tok')
    expect(first.intent).toBe('refused')
    expect(first.error).toBeUndefined()
    fail = false
    const second = await sous.commit('tok')
    expect(second.intent).toBe('ask')
    expect(calls).toHaveLength(1)
    expect((await sous.commit('tok')).error).toBe('expired')
  })

  it('CRITICAL 1 · cancel drops the token: a commit after the box closed is expired, nothing runs', async () => {
    const h = controller()
    const r = await h.sous.handle({ text: 'Make the install section of README English and add a test', surface: 'canvas', box: true })
    const token = r.decision?.token ?? ''
    expect(h.sous.cancel(token)).toBe(true)
    expect(h.sous.cancel(token)).toBe(false)
    expect(await h.sous.commit(token)).toMatchObject({ intent: 'refused', error: 'expired' })
    expect(h.calls.filter((c) => c.startsWith('submit'))).toEqual([])
  })

  it('LOW 12 · a token is a uuid when the deps mint none', async () => {
    const h = controller()
    const deps = (h.sous as unknown as { deps: SousControlDeps }).deps
    if (deps.decide) delete deps.decide.token
    const r = await h.sous.handle({ text: 'Make the install section of README English and add a test', surface: 'canvas', box: true })
    expect(r.decision?.token).toMatch(/^[0-9a-f-]{36}$/)
  })
})


describe('SousController — round 2: the box, the caller, and a commit in flight', () => {
  const brief = 'Make the install section of README English and add a test'

  it('1 · push-to-talk on the canvas mints nothing: the same sentence without `box` is the regex core’s answer', async () => {
    const h = controller()
    const spoken = await h.sous.handle({ text: brief, surface: 'canvas' })
    expect(spoken.intent).toBe('none')
    expect(spoken.decision).toBeUndefined()
    const flagged = await h.sous.handle({ text: brief, surface: 'canvas', box: false })
    expect(flagged.intent).toBe('none')
    // a command spoken aloud still runs
    expect((await h.sous.handle({ text: 'rename Forge to Anvil', surface: 'canvas' })).intent).toBe('rename')
    // and the box gets its decision
    expect((await h.sous.handle({ text: brief, surface: 'canvas', box: true })).intent).toBe('decide')
  })

  it('6 · a token belongs to the caller that minted it: another box can neither commit nor cancel it', async () => {
    const h = controller()
    const r = await h.sous.handle({ text: brief, surface: 'phone', box: true, callerId: 'phone-a' })
    const token = r.decision?.token ?? ''
    expect(await h.sous.commit(token, {}, { surface: 'phone', callerId: 'phone-b' })).toMatchObject({ intent: 'refused', error: 'not-yours' })
    expect(await h.sous.commit(token, {}, { surface: 'canvas', callerId: 'desktop' })).toMatchObject({ intent: 'refused', error: 'not-yours' })
    expect(h.sous.cancel(token, { surface: 'phone', callerId: 'phone-b' })).toBe(false)
    expect(h.calls.filter((c) => c.startsWith('submit'))).toEqual([])
    expect((await h.sous.commit(token, {}, { surface: 'phone', callerId: 'phone-a' })).intent).toBe('ask')
  })

  it('5 · a cancel that arrives while the brief is on its way answers false, and the brief lands', async () => {
    const calls: string[] = []
    let release: () => void = () => undefined
    const deps: SousControlDeps = {
      roster: () => roster,
      activeWorkspaceId: () => 'ws',
      switchWorkspace: () => undefined,
      createTerminal: () => ({ id: 'new', name: 'new' }),
      createBrowser: async () => undefined,
      connect: () => undefined,
      rename: () => undefined,
      submit: (id, text) =>
        new Promise<void>((resolve) => {
          release = () => {
            calls.push(`submit ${id} ${text}`)
            resolve()
          }
        }),
      ui: () => undefined,
      now: () => NOW,
      decide: { candidates: () => crew, workdir: () => '/repo', recruit: () => ({ id: 'x', name: 'x' }), token: () => 'tok' }
    }
    const sous = new SousController(deps)
    await sous.handle({ text: brief, surface: 'canvas', box: true })
    const committing = sous.commit('tok')
    await Promise.resolve()
    expect(sous.cancel('tok')).toBe(false)
    expect((await sous.commit('tok')).error).toBe('expired')
    release()
    expect((await committing).intent).toBe('ask')
    expect(calls).toEqual([`submit forge ${brief}`])
    expect(sous.cancel('tok')).toBe(false)
  })
})
