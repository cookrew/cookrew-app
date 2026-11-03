// THE BRIEF REACHES THE RECRUITED CARD (route program R3, live defect on
// storyboard beat 4): the sentence goes through the dispatch engine, the two
// boot-time 503s of a card made a moment ago are retried inside a window, every
// other refusal is thrown, and "delivered" is read from the ledger's record.

import { describe, expect, it } from 'vitest'
import { deliverToRecruit, retryableAtBoot, type RecruitDispatchEngine } from '../src/main/recruit-delivery'

type Answer = { status: number; body: Record<string, unknown> }

const engine = (answers: Answer[], record?: { state: string; error?: string }) => {
  const calls: Array<{ agentId: string; input: { text: string; origin?: string } }> = []
  let settledCalls = 0
  const fake: RecruitDispatchEngine = {
    dispatch: async (agentId, input) => {
      calls.push({ agentId, input })
      return answers[Math.min(calls.length, answers.length) - 1]
    },
    settled: async () => void (settledCalls += 1),
    get: () => record ?? { state: 'submitted' }
  }
  return { fake, calls, settled: () => settledCalls }
}

const clock = () => {
  let t = 0
  return { now: () => t, sleep: async (ms: number) => void (t += ms) }
}

describe('retryableAtBoot', () => {
  it('only the two refusals a booting card gives, and only as 503', () => {
    expect(retryableAtBoot(503, { error: 'unreachable' })).toBe(true)
    expect(retryableAtBoot(503, { error: 'agent has no durable observer' })).toBe(true)
    expect(retryableAtBoot(503, { error: 'dispatch ledger unavailable' })).toBe(false)
    expect(retryableAtBoot(409, { error: 'busy' })).toBe(false)
    expect(retryableAtBoot(404, { error: 'no such agent' })).toBe(false)
  })
})

describe('deliverToRecruit', () => {
  it('admits once, with the sentence as the text and the asker as origin, and resolves with the dispatch id', async () => {
    const e = engine([{ status: 202, body: { dispatchId: 'd1', state: 'submitted' } }])
    const out = await deliverToRecruit(e.fake, { nodeId: 'new', sentence: 'write a haiku about cables', originId: 'conductor' }, clock())
    expect(out).toEqual({ dispatchId: 'd1' })
    expect(e.calls).toEqual([{ agentId: 'new', input: { text: 'write a haiku about cables', origin: 'conductor' } }])
    expect(e.settled()).toBe(1)
  })

  it('a card whose pane and observer are not up yet is retried until it admits — one delivery', async () => {
    const e = engine([
      { status: 503, body: { error: 'unreachable' } },
      { status: 503, body: { error: 'agent has no durable observer' } },
      { status: 202, body: { dispatchId: 'd2', state: 'submitted' } }
    ])
    const out = await deliverToRecruit(e.fake, { nodeId: 'new', sentence: 's', originId: null }, { ...clock(), retryMs: 250 })
    expect(out.dispatchId).toBe('d2')
    expect(e.calls).toHaveLength(3)
    expect(e.calls[0].input).toEqual({ text: 's' })
  })

  it('gives up when the boot window closes, saying why', async () => {
    const e = engine([{ status: 503, body: { error: 'unreachable' } }])
    await expect(deliverToRecruit(e.fake, { nodeId: 'new', sentence: 's', originId: null }, { ...clock(), admissionMs: 1000, retryMs: 250 })).rejects.toThrow(/unreachable/)
    expect(e.calls.length).toBeGreaterThanOrEqual(4)
    expect(e.calls.length).toBeLessThanOrEqual(6)
  })

  it('a refusal that is not a boot symptom is thrown at once — busy, no such agent, a dead ledger', async () => {
    for (const answer of [
      { status: 409, body: { error: 'busy' } },
      { status: 404, body: { error: 'no such agent' } },
      { status: 503, body: { error: 'dispatch ledger unavailable' } }
    ]) {
      const e = engine([answer])
      await expect(deliverToRecruit(e.fake, { nodeId: 'new', sentence: 's', originId: null }, clock())).rejects.toThrow(String(answer.body.error))
      expect(e.calls).toHaveLength(1)
    }
  })

  it('an admitted brief whose delivery leg failed is a failure, not a "sent"', async () => {
    const e = engine([{ status: 202, body: { dispatchId: 'd3', state: 'submitted' } }], { state: 'failed', error: 'context-full' })
    await expect(deliverToRecruit(e.fake, { nodeId: 'new', sentence: 's', originId: null }, clock())).rejects.toThrow(/context-full/)
    const i = engine([{ status: 202, body: { dispatchId: 'd4', state: 'submitted' } }], { state: 'interrupted' })
    await expect(deliverToRecruit(i.fake, { nodeId: 'new', sentence: 's', originId: null }, clock())).rejects.toThrow(/interrupted/)
    // a record already running or done, or one the engine no longer holds, is a delivery
    const r = engine([{ status: 202, body: { dispatchId: 'd5', state: 'submitted' } }], { state: 'running' })
    await expect(deliverToRecruit(r.fake, { nodeId: 'new', sentence: 's', originId: null }, clock())).resolves.toEqual({ dispatchId: 'd5' })
  })
})

// THE BRIEF THAT VANISHED INTO A BOOTING PANE (2026-11-03, six of six): herdr
// typed the brief before Claude's TUI could take input, exited 0, the engine
// marked the record running on that acknowledgement, and recruit said
// "Prompt delivered" over an empty composer — while the armed stamp left the
// card busy for every later ask. With a witness the brief waits for the
// harness's own input prompt, and "delivered" needs evidence: a turn that
// started, or the text on screen. Unconfirmed is said out loud and the
// dispatch is closed so the card is not left busy.

import { DispatchService, type DispatchDeps } from '../src/main/dispatch'
import { TurnTracker } from '../src/main/turn-tracker'
import type { RecruitWitness } from '../src/main/recruit-delivery'

type Clock = { now: () => number; sleep: (ms: number) => Promise<void> }

const witnessed = (
  clockNow: () => number,
  over: Partial<{ readyAt: number; turnAt: number; textAt: number; runningAlways: boolean; sentence: string }> = {}
) => {
  const ready = over.readyAt ?? 0
  const witness: RecruitWitness = {
    readyForInput: () => clockNow() >= ready,
    turnRunning: () => over.runningAlways === true || (over.turnAt !== undefined && clockNow() >= over.turnAt),
    turnCount: () => 0,
    screen: () => (over.textAt !== undefined && clockNow() >= over.textAt ? `────────────\n❯ ${over.sentence ?? ''}\n────────────` : '────────────\n❯ \n────────────')
  }
  return witness
}

const timedEngine = (clk: Clock, answers: Answer[], record: () => { state: string; error?: string } = () => ({ state: 'running' })) => {
  const calls: Array<{ at: number; agentId: string; input: { text: string; origin?: string } }> = []
  const interrupted: Array<{ id: string; why: string }> = []
  const fake: RecruitDispatchEngine = {
    dispatch: async (agentId, input) => {
      calls.push({ at: clk.now(), agentId, input })
      return answers[Math.min(calls.length, answers.length) - 1]
    },
    settled: async () => undefined,
    get: () => record(),
    interrupt: (id, why) => void interrupted.push({ id, why })
  }
  return { fake, calls, interrupted }
}

const accepted: Answer = { status: 202, body: { dispatchId: 'd1', state: 'submitted' } }

describe('deliverToRecruit — held until the harness takes input, delivered only on evidence', () => {
  it('a card that becomes ready late gets the brief only once it is ready, once, and reports the turn it started', async () => {
    const clk = clock()
    const e = timedEngine(clk, [accepted])
    let dispatchedAt = -1
    const witness = witnessed(clk.now, { readyAt: 3000 })
    const watching: RecruitWitness = { ...witness, turnRunning: () => dispatchedAt >= 0 && clk.now() >= dispatchedAt + 500 }
    const engine: RecruitDispatchEngine = {
      ...e.fake,
      dispatch: async (agentId, input) => {
        dispatchedAt = clk.now()
        return e.fake.dispatch(agentId, input)
      }
    }
    const out = await deliverToRecruit(engine, { nodeId: 'new', sentence: 's', originId: null }, { ...clk, witness: watching })
    expect(out).toEqual({ dispatchId: 'd1', evidence: 'turn' })
    expect(e.calls).toHaveLength(1)
    expect(e.calls[0].at).toBeGreaterThanOrEqual(3000)
    expect(e.interrupted).toEqual([])
  })

  it('a card that never becomes ready is never typed into, and the failure says so', async () => {
    const clk = clock()
    const e = timedEngine(clk, [accepted])
    await expect(
      deliverToRecruit(e.fake, { nodeId: 'new', sentence: 's', originId: null }, { ...clk, witness: witnessed(clk.now, { readyAt: Number.POSITIVE_INFINITY }), readyMs: 30_000 })
    ).rejects.toThrow(/never showed its input prompt[\s\S]*nothing was sent/)
    expect(e.calls).toHaveLength(0)
    expect(e.interrupted).toEqual([])
  })

  it('a brief that was acknowledged but dropped (no turn, not on screen) is NOT confirmed, and its dispatch is closed — never re-sent', async () => {
    const clk = clock()
    const e = timedEngine(clk, [accepted])
    await expect(
      deliverToRecruit(e.fake, { nodeId: 'new', sentence: 'build the thing', originId: null }, { ...clk, witness: witnessed(clk.now), confirmMs: 10_000 })
    ).rejects.toThrow(/no turn started[\s\S]*closed, so the card is not held busy/)
    expect(e.calls).toHaveLength(1)
    expect(e.interrupted).toEqual([{ id: 'd1', why: expect.stringMatching(/not confirmed/) }])
  })

  it('the text showing in the composer is evidence it landed', async () => {
    const clk = clock()
    const e = timedEngine(clk, [accepted])
    const sentence = 'write a haiku about cables and send it back'
    const out = await deliverToRecruit(e.fake, { nodeId: 'new', sentence, originId: null }, { ...clk, witness: witnessed(clk.now, { textAt: 1000, sentence }) })
    expect(out).toEqual({ dispatchId: 'd1', evidence: 'composer' })
    expect(e.interrupted).toEqual([])
  })

  it('a turn the engine already closed is evidence of a turn', async () => {
    const clk = clock()
    const e = timedEngine(clk, [accepted], () => ({ state: 'done' }))
    const out = await deliverToRecruit(e.fake, { nodeId: 'new', sentence: 's', originId: null }, { ...clk, witness: witnessed(clk.now) })
    expect(out).toEqual({ dispatchId: 'd1', evidence: 'turn' })
  })

  it('a pane that was already "working" before the brief went in is not evidence the brief started anything', async () => {
    const clk = clock()
    const e = timedEngine(clk, [accepted])
    await expect(
      deliverToRecruit(e.fake, { nodeId: 'new', sentence: 's', originId: null }, { ...clk, witness: witnessed(clk.now, { runningAlways: true }), confirmMs: 5000 })
    ).rejects.toThrow(/no turn started/)
    expect(e.interrupted).toHaveLength(1)
  })

  it('a card already working on an earlier turn is not "booting": the engine refuses it at once, no readiness wait', async () => {
    const clk = clock()
    const e = timedEngine(clk, [{ status: 409, body: { error: 'busy' } }])
    const working: RecruitWitness = { readyForInput: () => false, turnRunning: () => true, turnCount: () => 3, screen: () => null }
    await expect(deliverToRecruit(e.fake, { nodeId: 'old', sentence: 's', originId: null }, { ...clk, witness: working })).rejects.toThrow(/busy/)
    expect(e.calls).toHaveLength(1)
    expect(e.calls[0].at).toBe(0)
  })

  it('a failed delivery leg is reported as such and needs no extra close', async () => {
    const clk = clock()
    const e = timedEngine(clk, [accepted], () => ({ state: 'failed', error: 'context-full' }))
    await expect(deliverToRecruit(e.fake, { nodeId: 'new', sentence: 's', originId: null }, { ...clk, witness: witnessed(clk.now) })).rejects.toThrow(/context-full/)
    expect(e.interrupted).toEqual([])
  })

  it('a multi-line ~3 KB brief with blank lines and quotes goes in whole, exactly once, and its echo confirms it', async () => {
    const clk = clock()
    const e = timedEngine(clk, [{ status: 503, body: { error: 'unreachable' } }, accepted])
    const sentence = [
      'You own the "login redirect" bug.',
      '',
      "Steps: read src/auth.ts, don't touch the tests' fixtures, then:",
      '',
      ...Array.from({ length: 40 }, (_, i) => `  ${i + 1}. check the 'next=' parameter for case ${i + 1} — keep "quotes" and \`ticks\``)
    ].join('\n')
    expect(sentence.length).toBeGreaterThan(2500)
    const out = await deliverToRecruit(e.fake, { nodeId: 'new', sentence, originId: 'me' }, { ...clk, witness: witnessed(clk.now, { readyAt: 1000, textAt: 2000, sentence }) })
    expect(out.evidence).toBe('composer')
    // one admission (the 503 retry is a refusal, not a delivery), the bytes exactly as given
    expect(e.calls.filter((c) => c.input.text === sentence)).toHaveLength(2)
    expect(e.calls.every((c) => c.input.text === sentence)).toBe(true)
    expect(e.interrupted).toEqual([])
  })
})

describe('deliverToRecruit over the real engine and tracker — an unconfirmed brief does not leave the card busy', () => {
  it('after "NOT confirmed" the stamp is gone and a follow-up dispatch is admitted, not refused as busy', async () => {
    const tracker = new TurnTracker(async () => null, null)
    let ids = 0
    const deps: DispatchDeps = {
      resolveAgent: (id) => (id === 'new' ? { name: 'Scout', workspaceId: 'ws-1' } : null),
      sessionNameFor: (id) => `cookrew_${id}`,
      sessionExists: () => true,
      capture: () => '',
      // herdr typed into a pane that was not reading yet and exited 0: the
      // acknowledgement the engine trusts, over a brief that went nowhere.
      submitAgent: async () => 'submitted',
      noteDispatch: (agentId, dispatchId, prompt) => tracker.noteDispatch(agentId, dispatchId, prompt),
      noteDelivered: (agentId, prompt, gen) => tracker.noteDispatchDelivered(agentId, prompt, gen),
      retractDelivered: () => undefined,
      clearDispatch: (agentId, dispatchId) => tracker.clearDispatch(agentId, dispatchId),
      beginWork: () => 'scrape',
      endWork: () => undefined,
      persist: () => true,
      newId: () => `dsp-${++ids}`,
      now: () => 1_700_000_000_000
    }
    const service = new DispatchService(deps)
    const clk = clock()
    await expect(
      deliverToRecruit(service, { nodeId: 'new', sentence: 'look around', originId: null }, { ...clk, witness: witnessed(clk.now), confirmMs: 5000 })
    ).rejects.toThrow(/no turn started/)

    expect(tracker.hasArmedDispatch('new')).toBe(false)
    expect(service.hasOpenDispatch('new')).toBe(false)
    expect(service.get('dsp-1')?.state).toBe('interrupted')
    const next = await service.dispatch('new', { text: 'look around' })
    expect(next.status).toBe(202)
    await service.settled(String(next.body.dispatchId))
  })
})
