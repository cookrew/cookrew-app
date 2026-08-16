import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import type http from 'node:http'
import { describe, expect, it, vi, afterEach } from 'vitest'
import { handleMobileApi, type MobileApiDeps } from '../src/main/mobile-api'
import {
  DispatchService,
  appendDispatchRecord,
  contextExhausted,
  describeSubmissionError,
  nonDeliveryProven,
  promptLanded,
  readDispatchRecords,
  turnDetails,
  type DispatchDeps,
  type DispatchRecord
} from '../src/main/dispatch'
import { promptViaHerdr, type PromptOutcome } from '../src/main/herdr-agent-wait'
import { pasteAndSubmit } from '../src/main/ask'
import { TurnTracker, type CompletedTurn } from '../src/main/turn-tracker'
import type { PtySession } from '../src/main/pty'

// V4 §3 on the v5 base — the dispatch route: attach-free agent-to-agent work.
//
// The protocol already has ~45 routes; the one it lacks is "give this agent
// work without attaching to it". HTTP /ask 404s on a detached pane (eval F1)
// while herdr-native prompt reached both background agents (P2) — so the
// path is the multiplexer, and NO PtySession appears in it. The single PTY in
// the design is the last-resort reattach fallback, and it only runs once the
// transcript has PROVEN the prompt never landed.
//
// F2 is the load-bearing one: `stalled` was a FALSE NEGATIVE on both
// successful dispatches. herdr's own words for it are "agent prompt produced
// no observed state change" — the prompt is in the pane, the detector just
// could not watch it land. Retrying on that word double-submits into a live
// agent's input box. Every retry in here is preceded by evidence.
//
// v5: there is no serviceState and no dormant refusal. ANY resolvable agent
// is dispatchable; the dispatch itself creates its tracking through
// beginWork/endWork, which the last suite pins.

const PROMPT = 'Run the F2 simulation and report the counts.'

function deps(over: Partial<DispatchDeps> = {}): DispatchDeps {
  return {
    resolveAgent: (id) =>
      id === 'agent-1' ? { name: 'Forge', workspaceId: 'ws-1' } : null,
    sessionNameFor: (id) => `cookrew_${id}`,
    sessionExists: () => true,
    capture: () => 'idle\n> ',
    promptAgent: async () => 'done',
    noteDispatch: () => true,
    beginWork: () => true,
    endWork: () => undefined,
    persist: () => true,
    newId: () => 'dsp-1',
    now: () => 1_700_000_000_000,
    ...over
  }
}

/** Dispatch and wait for the async delivery leg to settle. */
async function dispatchAndSettle(
  service: DispatchService,
  agentId = 'agent-1',
  body: { text?: string; brief?: string; idempotencyKey?: string; consumer?: string } = {
    text: PROMPT
  }
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await service.dispatch(agentId, body)
  await service.settled(String((response.body as { dispatchId?: string }).dispatchId ?? ''))
  return response as { status: number; body: Record<string, unknown> }
}

// ---------------------------------------------------------------------------
// The structural promise: no PtySession in the request path.
// ---------------------------------------------------------------------------

describe('the dispatch path never reaches for a PtySession', () => {
  it('does not import the pty module at all', () => {
    // Structural, not behavioural, because this is a DESIGN constraint: the
    // route must work for an agent nothing is attached to. A dep seam can be
    // stubbed in a test and still be wrong in production; an import cannot.
    //
    // Comments are stripped first — the module explains at length WHY no
    // PtySession appears in it, and prose about the constraint is not a
    // violation of it.
    const code = readFileSync(path.join(__dirname, '..', 'src', 'main', 'dispatch.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
    expect(code).not.toMatch(/from '\.\/pty'/)
    expect(code).not.toMatch(/PtySession/)
  })
})

// ---------------------------------------------------------------------------
// Refusals, in the order §3 states them. No dormant refusal exists any more:
// v5 dispatches any resolvable agent and creates the tracking itself.
// ---------------------------------------------------------------------------

describe('POST /api/agents/:id/dispatch — refusals', () => {
  it('404s an agent nobody has heard of', async () => {
    const service = new DispatchService(deps())
    const response = await service.dispatch('ghost', { text: PROMPT })
    expect(response.status).toBe(404)
  })

  it('400s a dispatch with nothing to say', async () => {
    const service = new DispatchService(deps())
    expect((await service.dispatch('agent-1', {})).status).toBe(400)
    expect((await service.dispatch('agent-1', { text: '   ' })).status).toBe(400)
  })

  it('409s BUSY while that agent already has work in flight', async () => {
    let release = (): void => undefined
    const held = new Promise<void>((resolve) => (release = resolve))
    let calls = 0
    const service = new DispatchService(
      deps({
        promptAgent: async () => {
          calls += 1
          await held
          return 'done'
        }
      })
    )
    const first = await service.dispatch('agent-1', { text: PROMPT })
    expect(first.status).toBe(202)

    const second = await service.dispatch('agent-1', { text: 'and another thing' })
    expect(second.status).toBe(409)
    expect(second.body).toMatchObject({ error: 'busy', dispatchId: 'dsp-1' })

    release()
    await service.settled('dsp-1')
    // The second prompt was never delivered — that is the whole point of a
    // reservation. Two prompts racing into one input box is the double-submit.
    // (Counted after settle: the leg starts on a setImmediate, so at 202 time
    // the count is legitimately still zero.)
    expect(calls).toBe(1)
  })

  it('503s when the pane is gone — unreachable, not busy', async () => {
    const service = new DispatchService(deps({ sessionExists: () => false }))
    const response = await service.dispatch('agent-1', { text: PROMPT })
    expect(response.status).toBe(503)
    expect(response.body).toMatchObject({ error: 'unreachable' })
  })

  it('fails a context-full agent at DELIVERY — accepted, then failed context-full', async () => {
    // Measured 2026-08-13: a Claude session at 100% context reported
    // agent_status "idle" and silently swallowed the brief — exit 0, empty
    // output, no turn. The status feed cannot see this; the pane's own status
    // line can. Sol r3 P1-15 moved the check off the accept path (a capture
    // is a synchronous CLI fork the 202 must not wait on): context-full is a
    // prompt-DELIVERY failure now — state 'failed', reason 'context-full' —
    // and the prompt is never submitted into the black hole.
    let prompts = 0
    const service = new DispatchService(
      deps({
        capture: () => 'some output\n  ⏵⏵ 100% context used  ',
        promptAgent: async () => {
          prompts += 1
          return 'done'
        }
      })
    )
    const response = await service.dispatch('agent-1', { text: PROMPT })
    expect(response.status).toBe(202)
    await service.settled('dsp-1')
    expect(service.get('dsp-1')).toMatchObject({ state: 'failed', error: 'context-full' })
    expect(prompts).toBe(0)
  })

  it('the accept path performs ZERO capture calls (Sol r3 P1-15)', async () => {
    // Admission asks the backend one question — session existence, which the
    // conductor answers from a cached inventory. Every pane read (context
    // check included) belongs to the delivery leg, past the 202.
    let captures = 0
    let deepCaptures = 0
    const service = new DispatchService(
      deps({
        capture: () => {
          captures += 1
          return 'idle\n> '
        },
        captureDeep: () => {
          deepCaptures += 1
          return 'idle\n> '
        }
      })
    )
    const response = await service.dispatch('agent-1', { text: PROMPT })
    expect(response.status).toBe(202)
    expect(captures).toBe(0)
    expect(deepCaptures).toBe(0)
    await service.settled('dsp-1')
    expect(captures).toBeGreaterThan(0) // the deliver leg's context check ran
  })

  it('503s when the backend cannot dispatch at all', async () => {
    const service = new DispatchService(deps({ promptAgent: undefined }))
    const response = await service.dispatch('agent-1', { text: PROMPT })
    expect(response.status).toBe(503)
  })

  it('releases the reservation once the TURN completes, not when submit returns', async () => {
    // F6: submission settles milliseconds after the prompt goes out while the
    // agent works for minutes. A slot freed there lets a second dispatch
    // overwrite the tracker's stamp — B closes with A's turn, A never closes.
    let n = 0
    const service = new DispatchService(deps({ newId: () => `dsp-${(n += 1)}` }))
    await dispatchAndSettle(service)

    const midTurn = await service.dispatch('agent-1', { text: 'next' })
    expect(midTurn.status).toBe(409)
    expect(midTurn.body).toMatchObject({ error: 'busy', dispatchId: 'dsp-1' })

    service.completeTurn('dsp-1', { turnIndex: 1, reply: 'done' })
    const again = await service.dispatch('agent-1', { text: 'next' })
    expect(again.status).toBe(202)
    await service.settled(String((again.body as { dispatchId: string }).dispatchId))
  })

  it('refuses the dispatch outright when the tracker still holds a live stamp', async () => {
    // Belt to the reservation's braces: whatever the reservation map thinks,
    // one terminal produces one turn, so a second stamp cannot be honoured.
    // Refused BEFORE the record is written — a refused request costs nothing
    // and leaves no row.
    const persisted: DispatchRecord[] = []
    const service = new DispatchService(
      deps({
        noteDispatch: () => false,
        persist: (record) => {
          persisted.push(record)
          return true
        }
      })
    )
    const response = await service.dispatch('agent-1', { text: PROMPT })
    expect(response.status).toBe(409)
    expect(persisted).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// F2: stalled → submitted, confirmed against the transcript. Never blind.
// ---------------------------------------------------------------------------

describe('F2 — a stalled report is confirmed, never retried blind', () => {
  it('confirms a submitted prompt from the transcript tail and stops there', async () => {
    let prompts = 0
    let fallbacks = 0
    const service = new DispatchService(
      deps({
        promptAgent: async () => {
          prompts += 1
          return 'submitted'
        },
        // The pane echo: the prompt IS there, herdr just did not see it land.
        capture: () => `⏺ working\n> ${PROMPT}\n`,
        reattachFallback: async () => {
          fallbacks += 1
          return true
        }
      })
    )
    await dispatchAndSettle(service)

    const record = service.get('dsp-1')
    expect(record?.state).toBe('running')
    expect(record?.confirmed).toBe(true)
    // THE assertion of this lane: exactly one delivery, and no PTY.
    expect(prompts).toBe(1)
    expect(fallbacks).toBe(0)
  })

  it('falls back ONLY once the transcript shows the prompt never landed', async () => {
    let fallbacks = 0
    const service = new DispatchService(
      deps({
        promptAgent: async () => 'submitted',
        capture: () => 'a totally unrelated screen\n> ',
        reattachFallback: async () => {
          fallbacks += 1
          return true
        }
      })
    )
    await dispatchAndSettle(service)

    // Not a blind retry: the transcript was READ first and disagreed with
    // herdr. Re-sending is now evidence-based, which is the only kind allowed.
    expect(fallbacks).toBe(1)
    const record = service.get('dsp-1')
    expect(record?.confirmed).toBe(false)
    expect(record?.via).toBe('pty-fallback')
    expect(record?.state).toBe('running')
  })

  it('gives up rather than guess when there is no fallback to fall back to', async () => {
    const service = new DispatchService(
      deps({ promptAgent: async () => 'submitted', capture: () => 'unrelated' })
    )
    await dispatchAndSettle(service)
    const record = service.get('dsp-1')
    expect(record?.state).toBe('failed')
    expect(record?.error).toMatch(/never appeared/i)
  })

  it('a failed delivery reattaches — the one PTY in the design, last', async () => {
    let fallbacks = 0
    const service = new DispatchService(
      deps({
        promptAgent: async () => 'failed',
        reattachFallback: async () => {
          fallbacks += 1
          return true
        }
      })
    )
    await dispatchAndSettle(service)
    expect(fallbacks).toBe(1)
    expect(service.get('dsp-1')?.via).toBe('pty-fallback')
  })

  it('marks the dispatch failed when even the fallback cannot deliver', async () => {
    const service = new DispatchService(
      deps({ promptAgent: async () => 'failed', reattachFallback: async () => false })
    )
    await dispatchAndSettle(service)
    expect(service.get('dsp-1')?.state).toBe('failed')
  })

  it('promptLanded matches on a normalized prefix, not a byte compare', () => {
    // A TUI rewraps and re-indents what it echoes; an exact compare would
    // report every wrapped prompt as never delivered and send it twice.
    expect(promptLanded('> Run   the F2\n  simulation and report', PROMPT)).toBe(true)
    // Still specific enough to tell two briefs apart at the same agent.
    expect(promptLanded('> Run the F3 simulation and report the counts.', PROMPT)).toBe(false)
    expect(promptLanded('', PROMPT)).toBe(false)
  })

  it('does NOT confirm a prompt the TUI collapsed into a paste placeholder', () => {
    // The honest limit of reading a screen: a long brief shows as
    // "[Pasted text #1 +40 lines]" and no prefix of it is on the pane. That
    // must read as unconfirmed — which routes to the evidence-based fallback,
    // not to a blind re-send. Confirming here would be inventing the evidence.
    expect(promptLanded('> [Pasted text #1 +40 lines]', PROMPT)).toBe(false)
  })

  it('a TIMED-OUT wait is not a failed delivery — no second copy of the brief', async () => {
    // F2, the guaranteed double-send: herdr's `agent prompt --wait` submits and
    // THEN blocks, so a ten-minute wait expiring over a longer turn used to
    // report 'failed' with the prompt already in the pane. promptViaHerdr now
    // maps a timeout to 'submitted', and the transcript check runs on EVERY
    // non-done outcome — including 'failed' — so neither route re-sends.
    for (const outcome of ['submitted', 'failed'] as const) {
      let fallbacks = 0
      const service = new DispatchService(
        deps({
          promptAgent: async () => outcome,
          capture: () => `⏺ thinking for 11 minutes\n> ${PROMPT}\n`,
          reattachFallback: async () => {
            fallbacks += 1
            return true
          }
        })
      )
      await dispatchAndSettle(service)
      expect(fallbacks).toBe(0)
      expect(service.get('dsp-1')).toMatchObject({ state: 'running', confirmed: true })
    }
  })

  it('promptViaHerdr maps a wait timeout to submitted, never to failed', async () => {
    const timedOut = async (): Promise<void> => {
      throw Object.assign(new Error('Command failed: herdr agent wait'), {
        stdout: '{"error":{"code":"agent_wait_timeout"}}'
      })
    }
    const killed = async (): Promise<void> => {
      throw Object.assign(new Error('spawn herdr ETIMEDOUT'), { code: 'ETIMEDOUT' })
    }
    const call = (exec: () => Promise<void>): Promise<PromptOutcome> =>
      promptViaHerdr({
        session: 's',
        configPath: '/tmp/herdr.toml',
        target: 'w1:p2',
        prompt: PROMPT,
        timeoutMs: 1000,
        exec
      })
    expect(await call(timedOut)).toBe('submitted')
    expect(await call(killed)).toBe('submitted')
    // A real delivery failure is still a delivery failure.
    expect(
      await call(async () => {
        throw new Error('unknown agent')
      })
    ).toBe('failed')
  })

  it('reads scrollback for the landing check and the SCREEN for context-full', async () => {
    // Depth answers one question and lies about the other: a prompt that
    // scrolled away is still delivered, but a "100% context used" footer from
    // before a /compact is stale history. Mixing them up refuses a perfectly
    // serviceable agent forever.
    let fallbacks = 0
    const service = new DispatchService(
      deps({
        promptAgent: async () => 'submitted',
        capture: () => '⏵⏵ 12% context used\n> ',
        captureDeep: () => `…scrollback…\n> ${PROMPT}\n⏺ 100% context used (an hour ago)\n`,
        reattachFallback: async () => {
          fallbacks += 1
          return true
        }
      })
    )
    const response = await dispatchAndSettle(service)
    expect(response.status).toBe(202)
    expect(fallbacks).toBe(0)
    expect(service.get('dsp-1')).toMatchObject({ state: 'running', confirmed: true })
  })

  it('does NOT re-send merely because the prompt is not on screen (F3)', async () => {
    // The inversion. A capture is bounded and the TUI collapses long pastes, so
    // "not on screen" is routinely true of a prompt that landed perfectly. The
    // pane MOVED after the submission — something is happening in there — and
    // re-sending on top of it is the double-submit.
    let fallbacks = 0
    let submitted = false
    const service = new DispatchService(
      deps({
        promptAgent: async () => {
          submitted = true
          return 'submitted'
        },
        // The brief went in as a paste the TUI collapsed, so no prefix of it is
        // on the screen — but the screen MOVED, which nothing but a delivered
        // prompt explains.
        capture: () => (submitted ? '> [Pasted text #1 +40 lines]\n⏺ working' : '> '),
        reattachFallback: async () => {
          fallbacks += 1
          return true
        }
      })
    )
    await dispatchAndSettle(service)
    expect(fallbacks).toBe(0)
    // Honest about the grade of evidence rather than inventing either verdict.
    expect(service.get('dsp-1')).toMatchObject({ confirmed: false, via: 'herdr' })
    expect(service.get('dsp-1')?.state).toBe('submitted')
  })

  it('does NOT re-send while the lifecycle feed says the agent is working', async () => {
    let fallbacks = 0
    const service = new DispatchService(
      deps({
        promptAgent: async () => 'failed',
        // A frozen pane and a working agent: the screen simply has not been
        // repainted yet. herdr's own status outranks the absence of an echo.
        capture: () => 'idle\n> ',
        agentStatus: () => 'working',
        reattachFallback: async () => {
          fallbacks += 1
          return true
        }
      })
    )
    await dispatchAndSettle(service)
    expect(fallbacks).toBe(0)
    expect(service.get('dsp-1')?.confirmed).toBe(false)
  })

  it('nonDeliveryProven demands all three signals, and refuses to guess', () => {
    const base = { before: '> ', after: '> ', prompt: PROMPT, idle: null }
    // Pane unchanged, prompt absent, nothing says the agent is busy.
    expect(nonDeliveryProven(base)).toBe(true)
    expect(nonDeliveryProven({ ...base, idle: true })).toBe(true)
    // Any one signal against it is enough to stop the re-send.
    expect(nonDeliveryProven({ ...base, idle: false })).toBe(false)
    expect(nonDeliveryProven({ ...base, after: '> ⏺ working' })).toBe(false)
    expect(nonDeliveryProven({ ...base, after: `> ${PROMPT}` })).toBe(false)
    // No view of the pane proves nothing in either direction.
    expect(nonDeliveryProven({ ...base, after: null })).toBe(false)
    expect(nonDeliveryProven({ ...base, before: null })).toBe(false)
  })

  it('logs a failed submission WITHOUT the brief it was carrying (F16)', () => {
    // execFile builds its message from the full argv, so `herdr agent prompt
    // <pane> <prompt>` puts the caller's entire brief in the app log and in
    // the record's error field, which is served over HTTP.
    const message = describeSubmissionError(
      Object.assign(
        new Error(`Command failed: herdr agent prompt w1:p2 ${PROMPT} --wait`),
        { code: 1 }
      ),
      PROMPT.length
    )
    expect(message).not.toContain('F2 simulation')
    expect(message).toContain('code=1')
    expect(message).toContain('herdr agent prompt')
    expect(message).toContain(`promptLength=${PROMPT.length}`)
  })

  it('contextExhausted reads the pane banner, and only when it is really full', () => {
    expect(contextExhausted('  100% context used ')).toBe(true)
    expect(contextExhausted('98% context used')).toBe(true)
    expect(contextExhausted('42% context used')).toBe(false)
    expect(contextExhausted('all good here')).toBe(false)
    expect(contextExhausted(null)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Idempotency: one key, one dispatch, however many times it is pressed.
// ---------------------------------------------------------------------------

describe('idempotencyKey — a repeated dispatch is the SAME dispatch', () => {
  it('returns the original dispatchId and does not deliver twice', async () => {
    let prompts = 0
    const service = new DispatchService(
      deps({
        promptAgent: async () => {
          prompts += 1
          return 'done'
        }
      })
    )
    const first = await dispatchAndSettle(service, 'agent-1', {
      text: PROMPT,
      idempotencyKey: 'key-a'
    })
    const second = await service.dispatch('agent-1', { text: PROMPT, idempotencyKey: 'key-a' })

    expect(first.body.dispatchId).toBe('dsp-1')
    expect(second.body).toMatchObject({ dispatchId: 'dsp-1' })
    expect(second.status).toBe(200) // a replay, not a new 202
    expect(prompts).toBe(1)
  })

  it('replays while the original is STILL in flight — not a 409', async () => {
    // The retry a flaky network produces arrives before the first finishes.
    // Answering 409 busy would tell the caller to back off from its own work.
    let release = (): void => undefined
    const held = new Promise<void>((resolve) => (release = resolve))
    const service = new DispatchService(
      deps({
        promptAgent: async () => {
          await held
          return 'done'
        }
      })
    )
    await service.dispatch('agent-1', { text: PROMPT, idempotencyKey: 'key-a' })
    const replay = await service.dispatch('agent-1', { text: PROMPT, idempotencyKey: 'key-a' })
    expect(replay.status).toBe(200)
    expect(replay.body).toMatchObject({ dispatchId: 'dsp-1' })
    release()
    await service.settled('dsp-1')
  })

  it('a DIFFERENT key on a free agent is a new dispatch', async () => {
    let n = 0
    const service = new DispatchService(deps({ newId: () => `dsp-${(n += 1)}` }))
    await dispatchAndSettle(service, 'agent-1', { text: PROMPT, idempotencyKey: 'key-a' })
    // Free means the TURN closed, not that the submission returned (F6).
    service.completeTurn('dsp-1', { turnIndex: 1 })
    const second = await dispatchAndSettle(service, 'agent-1', {
      text: PROMPT,
      idempotencyKey: 'key-b'
    })
    expect(second.body.dispatchId).toBe('dsp-2')
  })

  it('one key fronting BYTE-distinct briefs is refused — case and whitespace are semantic (Sol r4 P0-2)', async () => {
    // The lossy fingerprint aliased `build:\n\tmake all` with `BUILD: make
    // all`: same normalized hash, different work — a replay answered 200 for
    // a brief the caller never sent. Exact request bytes are the identity.
    let n = 0
    const service = new DispatchService(deps({ newId: () => `dsp-${(n += 1)}` }))
    await dispatchAndSettle(service, 'agent-1', {
      text: 'build:\n\tmake all',
      idempotencyKey: 'key-a'
    })
    for (const variant of ['BUILD: make all', 'build:\n    make all', 'build: make all']) {
      const reused = await service.dispatch('agent-1', { text: variant, idempotencyKey: 'key-a' })
      expect(reused.status).toBe(409)
      expect(reused.body).toMatchObject({ error: 'idempotency key reused for different work' })
    }
    // The byte-exact retry is still the replay it always was.
    const replay = await service.dispatch('agent-1', {
      text: 'build:\n\tmake all',
      idempotencyKey: 'key-a'
    })
    expect(replay.status).toBe(200)
    expect(replay.body).toMatchObject({ dispatchId: 'dsp-1', replay: true })
  })

  it('delivers the caller EXACT bytes — no trim before delivery (Sol r4 P0-2)', async () => {
    const delivered: string[] = []
    const service = new DispatchService(
      deps({
        promptAgent: async (_session, prompt) => {
          delivered.push(prompt)
          return 'done'
        }
      })
    )
    const brief = '  indented first line\n\trecipe line\n'
    await dispatchAndSettle(service, 'agent-1', { text: brief })
    expect(delivered).toEqual([brief])
  })

  it('a legacy lossy (v1) fingerprint cannot prove difference — replay, not 409', async () => {
    // Pre-upgrade rows carry bare-hex v1 hashes of a normalized prompt.
    // Measuring a v2 exact-bytes hash against one proves nothing in either
    // direction, so the key's promise wins: replay. A one-time miss window,
    // documented on fingerprintsConflict, that ages out with the 90-day TTL.
    const NOW = 1_700_000_000_000
    const service = new DispatchService(
      deps({
        now: () => NOW,
        loadRecords: () => [
          {
            id: 'dsp-old',
            agentId: 'agent-1',
            agentName: 'Forge',
            workspaceId: 'ws-1',
            state: 'done',
            via: 'herdr',
            createdAt: NOW - 1000,
            updatedAt: NOW - 1000,
            idempotencyKey: 'key-legacy',
            promptHash: 'deadbeef'.repeat(8) // bare hex = v1, lossy
          } as DispatchRecord
        ]
      })
    )
    const replay = await service.dispatch('agent-1', {
      text: 'entirely different bytes than whatever v1 hashed',
      idempotencyKey: 'key-legacy'
    })
    expect(replay.status).toBe(200)
    expect(replay.body).toMatchObject({ dispatchId: 'dsp-old', replay: true })
  })

  it('scopes the key by consumer — one tenant cannot replay another', async () => {
    // The scope is (consumer, key), so tenant B pressing tenant A's key gets
    // its OWN dispatch, never a replay describing somebody else's work.
    // Consumers require the native-file observer grade (Sol r3 P0-5).
    let n = 0
    const service = new DispatchService(
      deps({ newId: () => `dsp-${(n += 1)}`, beginWork: () => 'native-file' })
    )
    await dispatchAndSettle(service, 'agent-1', {
      text: PROMPT,
      idempotencyKey: 'key-a',
      consumer: 'tenant-a'
    })
    service.completeTurn('dsp-1', { turnIndex: 1 })

    const other = await dispatchAndSettle(service, 'agent-1', {
      text: PROMPT,
      idempotencyKey: 'key-a',
      consumer: 'tenant-b'
    })
    expect(other.status).toBe(202)
    expect(other.body.dispatchId).toBe('dsp-2')

    // The same tenant's retry is still the replay it always was.
    const replay = await service.dispatch('agent-1', {
      text: PROMPT,
      idempotencyKey: 'key-a',
      consumer: 'tenant-a'
    })
    expect(replay.status).toBe(200)
    expect(replay.body).toMatchObject({ dispatchId: 'dsp-1', replay: true })
  })
})

// ---------------------------------------------------------------------------
// GET /api/dispatches/:id — the correlated lifecycle.
// ---------------------------------------------------------------------------

describe('GET /api/dispatches/:id', () => {
  it('404s an id that was never issued', () => {
    expect(new DispatchService(deps()).lookup('nope').status).toBe(404)
  })

  it('walks submitted → running → done with the turn that answered it', async () => {
    const service = new DispatchService(deps({ promptAgent: async () => 'done' }))
    await dispatchAndSettle(service)
    expect(service.get('dsp-1')?.state).toBe('running')

    service.completeTurn('dsp-1', { turnIndex: 12, reply: 'counts reported' })

    const view = service.lookup('dsp-1')
    expect(view.status).toBe(200)
    expect(view.body).toMatchObject({ state: 'done', turnIndex: 12, hasReply: true })
  })

  it('does NOT serve the agent’s answer over the dispatch id (F4)', async () => {
    // The record correlates work; it is not a transcript endpoint. The reply
    // reaches its owner through the turn ledger, behind the same gate as every
    // other route that carries agent output — one leaked dispatch id must not
    // be a read of what the agent said.
    const service = new DispatchService(deps())
    await dispatchAndSettle(service)
    service.completeTurn('dsp-1', { turnIndex: 3, reply: 'the secret answer' })

    expect(JSON.stringify(service.lookup('dsp-1').body)).not.toContain('secret')
    // Still recorded, still correlated — just not projected over HTTP.
    expect(service.get('dsp-1')?.reply).toBe('the secret answer')
  })

  it('stamps interrupted for a dispatch whose agent died mid-turn', async () => {
    const service = new DispatchService(deps())
    await dispatchAndSettle(service)
    service.interrupt('dsp-1', 'herdr session ended')
    expect(service.get('dsp-1')?.state).toBe('interrupted')
  })

  it('ignores a completion for a dispatch already in a terminal state', async () => {
    const service = new DispatchService(deps())
    await dispatchAndSettle(service)
    service.completeTurn('dsp-1', { turnIndex: 1, reply: 'first' })
    service.completeTurn('dsp-1', { turnIndex: 2, reply: 'second' })
    expect(service.get('dsp-1')).toMatchObject({ turnIndex: 1, reply: 'first' })
  })
})

// ---------------------------------------------------------------------------
// The append-only registry.
// ---------------------------------------------------------------------------

describe('~/.cookrew/dispatches.jsonl — append only', () => {
  const record = (over: Partial<DispatchRecord> = {}): DispatchRecord => ({
    id: 'dsp-1',
    agentId: 'agent-1',
    agentName: 'Forge',
    workspaceId: 'ws-1',
    state: 'submitted',
    via: 'herdr',
    createdAt: 1,
    updatedAt: 1,
    ...over
  })

  it('appends every transition rather than rewriting the row', () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'cookrew-dsp-')), 'dispatches.jsonl')
    appendDispatchRecord(file, record())
    appendDispatchRecord(file, record({ state: 'running', updatedAt: 2 }))
    appendDispatchRecord(file, record({ state: 'done', updatedAt: 3, turnIndex: 4 }))

    const rows = readDispatchRecords(file)
    expect(rows.map((r) => r.state)).toEqual(['submitted', 'running', 'done'])
  })

  it('survives a torn line instead of losing the file', () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'cookrew-dsp-')), 'dispatches.jsonl')
    appendDispatchRecord(file, record())
    require('node:fs').appendFileSync(file, '{"id":"tor\n', 'utf8')
    appendDispatchRecord(file, record({ state: 'done' }))
    expect(readDispatchRecords(file).map((r) => r.state)).toEqual(['submitted', 'done'])
  })

  it('reads an absent registry as empty, not as an error', () => {
    expect(readDispatchRecords(path.join(tmpdir(), 'cookrew-no-such-dispatches.jsonl'))).toEqual([])
  })

  // D3 — the file is owner-only, and the reply is not in it at all.

  it('creates the ledger 0600 inside a 0700 directory', () => {
    const dir = path.join(mkdtempSync(path.join(tmpdir(), 'cookrew-dsp-')), 'nested')
    const file = path.join(dir, 'dispatches.jsonl')
    appendDispatchRecord(file, record())
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(statSync(dir).mode & 0o777).toBe(0o700)
  })

  it('tightens a ledger that already exists — mode applies at CREATE only', () => {
    // Every machine that has already run this has a 0644 file; a mode on the
    // append does nothing for them, so the permissions are re-asserted.
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'cookrew-dsp-')), 'dispatches.jsonl')
    writeFileSync(file, '', { mode: 0o644 })
    chmodSync(file, 0o644)
    appendDispatchRecord(file, record())
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  it('never writes the agent’s reply to disk — only that there was one', () => {
    // Same argument as the HTTP projection (F4): the dispatch ledger is a
    // correlation trace, not a second transcript store with its own lifetime
    // and no reader. turnIndex points at the turn that has it.
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'cookrew-dsp-')), 'dispatches.jsonl')
    appendDispatchRecord(
      file,
      record({ state: 'done', turnIndex: 4, reply: 'the whole confidential answer' })
    )
    expect(readFileSync(file, 'utf8')).not.toContain('confidential')

    const [row] = readDispatchRecords(file)
    expect(row.reply).toBeUndefined()
    expect(row).toMatchObject({ turnIndex: 4, hasReply: true })
  })

  it('says hasReply after a restart rather than implying silence', () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'cookrew-dsp-')), 'dispatches.jsonl')
    // Inside the retention window, or the prune sweep drops it before lookup.
    const at = 1_700_000_000_000
    appendDispatchRecord(
      file,
      record({ state: 'done', turnIndex: 4, reply: 'answered', createdAt: at, updatedAt: at })
    )
    const rebooted = new DispatchService(deps({ loadRecords: () => readDispatchRecords(file) }))
    expect(rebooted.lookup('dsp-1').body).toMatchObject({ hasReply: true, turnIndex: 4 })
  })
})

// ---------------------------------------------------------------------------
// D1 — the missing trigger: a dispatch whose turn never arrives.
// ---------------------------------------------------------------------------

describe('sweep — nothing holds an agent’s slot forever', () => {
  const TEN_MINUTES = 10 * 60 * 1000
  const START = 1_700_000_000_000

  /** A service whose clock the test drives. */
  function aging(over: Partial<DispatchDeps> = {}): {
    service: DispatchService
    tick: (ms: number) => void
  } {
    let clock = START
    const service = new DispatchService(deps({ now: () => clock, ...over }))
    return { service, tick: (ms) => (clock += ms) }
  }

  it('stamps a dispatch whose turn never completed, and frees the agent', async () => {
    // The gap release() could not close: only a completed turn and an app quit
    // reach the terminal edge. An agent killed mid-turn reaches neither, so
    // its slot answered 409 busy forever.
    const { service, tick } = aging()
    await dispatchAndSettle(service)
    expect(service.get('dsp-1')?.state).toBe('running')

    tick(TEN_MINUTES - 1)
    expect(service.sweep()).toEqual([])

    tick(2)
    expect(service.sweep()).toEqual(['dsp-1'])
    expect(service.get('dsp-1')).toMatchObject({ state: 'interrupted' })
    expect(service.get('dsp-1')?.error).toMatch(/no outcome within/i)
    expect(service.openDispatchIds()).toEqual([])

    const next = await service.dispatch('agent-1', { text: 'the agent is free again' })
    expect(next.status).toBe(202)
    await service.settled(String((next.body as { dispatchId: string }).dispatchId))
  })

  it('spares an agent the lifecycle feed says is still WORKING', async () => {
    // Positive evidence outranks age — the same rule the delivery path uses.
    // A long turn is not an abandoned one.
    let status: 'working' | 'idle' = 'working'
    const { service, tick } = aging({ agentStatus: () => status })
    await dispatchAndSettle(service)
    tick(TEN_MINUTES * 3)
    expect(service.sweep()).toEqual([])
    expect(service.get('dsp-1')?.state).toBe('running')

    status = 'idle'
    expect(service.sweep()).toEqual(['dsp-1'])
  })

  it('leaves closed records alone, however old', async () => {
    const { service, tick } = aging()
    await dispatchAndSettle(service)
    service.completeTurn('dsp-1', { turnIndex: 1 })
    tick(TEN_MINUTES * 10)
    expect(service.sweep()).toEqual([])
    expect(service.get('dsp-1')?.state).toBe('done')
  })

  it('a proven durable outcome is COMMITTED, never converted to a timeout interrupt (Sol r4 P0-3)', async () => {
    // The inversion this replaces: hasFinalAnswer used to be a boolean that
    // merely ended the working-status veto, after which the sweep stamped
    // `interrupted: no outcome within 10 minutes` OVER a parser-proven final
    // answer. The probe now returns the matching record's own payload and
    // the sweep commits THAT outcome through the normal completion path.
    const asked: [string, string, number][] = []
    let final: { turnIndex: number; uuid?: string; reply?: string } | null = null
    const { service, tick } = aging({
      agentStatus: () => 'working',
      hasFinalAnswer: (agentId, prompt, armedAt) => {
        asked.push([agentId, prompt, armedAt])
        return final
      }
    })
    await dispatchAndSettle(service)
    tick(TEN_MINUTES + 1)
    // No final row: the working spare stands, as it always did.
    expect(service.sweep()).toEqual([])
    expect(asked.at(-1)).toEqual(['agent-1', PROMPT, START])

    // A matching final durable record exists: the sweep closes the dispatch
    // with the record's OWN outcome and identity — done, not interrupted.
    final = { turnIndex: 12, uuid: 'uuid-12', reply: 'the actual answer' }
    expect(service.sweep()).toEqual(['dsp-1'])
    expect(service.get('dsp-1')).toMatchObject({
      state: 'done',
      turnIndex: 12,
      turnUuid: 'uuid-12'
    })
    expect(service.get('dsp-1')?.error).toBeUndefined()
  })

  it('a durable FAILED outcome sweeps as failed — the record speaks, not the clock', async () => {
    const { service, tick } = aging({
      hasFinalAnswer: () => ({ turnIndex: 4, outcome: 'failed' as const })
    })
    await dispatchAndSettle(service)
    tick(TEN_MINUTES + 1)
    expect(service.sweep()).toEqual(['dsp-1'])
    expect(service.get('dsp-1')).toMatchObject({
      state: 'failed',
      turnIndex: 4,
      error: 'agent aborted/errored'
    })
  })

  it('timeout-interrupt fires ONLY when no matching durable terminal record exists', async () => {
    const { service, tick } = aging({ hasFinalAnswer: () => null })
    await dispatchAndSettle(service)
    tick(TEN_MINUTES + 1)
    expect(service.sweep()).toEqual(['dsp-1'])
    expect(service.get('dsp-1')?.state).toBe('interrupted')
    expect(service.get('dsp-1')?.error).toMatch(/no outcome within/i)
  })

  it('the working spare stands when hasFinalAnswer is not wired', async () => {
    const { service, tick } = aging({ agentStatus: () => 'working' })
    await dispatchAndSettle(service)
    tick(TEN_MINUTES * 3)
    expect(service.sweep()).toEqual([])
  })

  // Sol r3 P1-17 — observer probation: a path-shaped watch spec is a promise,
  // not a proven observer. A native-file dispatch whose observer never
  // MATERIALIZES is interrupted promptly, not left for the ten-minute sweep.

  it('interrupts a native-file dispatch whose observer never materialized', async () => {
    let live = false
    let n = 0
    const { service, tick } = aging({
      beginWork: () => 'native-file',
      observerLive: () => live,
      newId: () => `dsp-${(n += 1)}`
    })
    await dispatchAndSettle(service)
    // Inside the probation window: a fresh session file gets its grace.
    tick(59_000)
    expect(service.sweep()).toEqual([])

    tick(2_000)
    expect(service.sweep()).toEqual(['dsp-1'])
    expect(service.get('dsp-1')).toMatchObject({
      state: 'interrupted',
      error: 'interrupted: observer never materialized'
    })

    // Healthy path: the observer went live — no probation interrupt, ever.
    live = true
    const next = await service.dispatch('agent-1', { text: PROMPT })
    await service.settled(String((next.body as { dispatchId: string }).dispatchId))
    tick(TEN_MINUTES - 1)
    expect(service.sweep()).toEqual([])
  })

  it('scrape-grade acceptances are not on observer probation', async () => {
    // A scrape acceptance has a live PTY witness by definition; probation is
    // for the file observer that was only ever a computed path.
    const { service, tick } = aging({
      beginWork: () => 'scrape',
      observerLive: () => false
    })
    await dispatchAndSettle(service)
    tick(61_000)
    expect(service.sweep()).toEqual([])
    expect(service.get('dsp-1')?.state).toBe('running')
  })

  it('a late delivery cannot resurrect a swept dispatch', async () => {
    // The herdr call that never returns: its `running` patch lands after the
    // sweep gave the slot away, and a terminal record is final.
    let release = (): void => undefined
    const held = new Promise<void>((resolve) => (release = resolve))
    const { service, tick } = aging({
      promptAgent: async () => {
        await held
        return 'done'
      }
    })
    await service.dispatch('agent-1', { text: PROMPT })
    tick(TEN_MINUTES + 1)
    expect(service.sweep()).toEqual(['dsp-1'])

    release()
    await service.settled('dsp-1')
    expect(service.get('dsp-1')?.state).toBe('interrupted')
  })

  it('runs on hydrate, so a restart never inherits an open record', () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'cookrew-dsp-')), 'dispatches.jsonl')
    appendDispatchRecord(file, {
      id: 'dsp-old',
      agentId: 'agent-1',
      agentName: 'Forge',
      workspaceId: 'ws-1',
      state: 'running',
      via: 'herdr',
      createdAt: START - TEN_MINUTES * 5,
      updatedAt: START - TEN_MINUTES * 5
    })
    const service = new DispatchService(deps({ loadRecords: () => readDispatchRecords(file) }))
    expect(service.get('dsp-old')?.state).toBe('interrupted')
    expect(service.openDispatchIds()).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// F5 — the ledger is the state, so a restart is not an amnesia event.
// ---------------------------------------------------------------------------

describe('a restart rehydrates from the ledger', () => {
  /** A service whose registry is a real file, as index.ts wires it. */
  const onDisk = (file: string, over: Partial<DispatchDeps> = {}): DispatchService =>
    new DispatchService(
      deps({
        persist: (record) => appendDispatchRecord(file, record),
        loadRecords: () => readDispatchRecords(file),
        ...over
      })
    )

  const ledger = (): string =>
    path.join(mkdtempSync(path.join(tmpdir(), 'cookrew-dsp-')), 'dispatches.jsonl')

  it('replays the same idempotencyKey instead of dispatching again', async () => {
    const file = ledger()
    let prompts = 0
    const count = async (): Promise<'done'> => {
      prompts += 1
      return 'done'
    }
    const first = onDisk(file, { promptAgent: count })
    await dispatchAndSettle(first, 'agent-1', { text: PROMPT, idempotencyKey: 'key-a' })
    first.completeTurn('dsp-1', { turnIndex: 1, reply: 'answered' })

    // The process dies. The caller retries the key it already submitted.
    const rebooted = onDisk(file, { promptAgent: count, newId: () => 'dsp-2' })
    const replay = await rebooted.dispatch('agent-1', { text: PROMPT, idempotencyKey: 'key-a' })

    expect(replay.status).toBe(200)
    expect(replay.body).toMatchObject({ dispatchId: 'dsp-1', replay: true })
    expect(prompts).toBe(1)
  })

  it('answers GET for work that predates the restart, rather than 404ing it', async () => {
    const file = ledger()
    const first = onDisk(file)
    await dispatchAndSettle(first)
    first.completeTurn('dsp-1', { turnIndex: 7 })

    const rebooted = onDisk(file)
    expect(rebooted.lookup('dsp-1')).toMatchObject({
      status: 200,
      body: { id: 'dsp-1', state: 'done', turnIndex: 7 }
    })
  })

  it('stamps a row that was still open INTERRUPTED, not failed', async () => {
    // Nothing survived the process that was watching that turn, so no
    // correlation can ever arrive — but the agent may well have done the work.
    // `failed` would say "we never delivered this", which is a lie a caller
    // would act on by re-sending.
    const file = ledger()
    let release = (): void => undefined
    const held = new Promise<void>((resolve) => (release = resolve))
    const first = onDisk(file, {
      promptAgent: async () => {
        await held
        return 'done'
      }
    })
    await first.dispatch('agent-1', { text: PROMPT, idempotencyKey: 'key-a' })

    const rebooted = onDisk(file)
    expect(rebooted.get('dsp-1')).toMatchObject({ state: 'interrupted' })
    expect(rebooted.get('dsp-1')?.error).toMatch(/restart/i)
    // And the agent is free again: nothing holds a slot across a restart.
    const next = await rebooted.dispatch('agent-1', { text: 'new work' })
    expect(next.status).toBe(202)
    await rebooted.settled('dsp-1')

    release()
    await first.settled('dsp-1')
  })
})

// ---------------------------------------------------------------------------
// F1 — the fallback is provably not herdr.
// ---------------------------------------------------------------------------

describe('the reattach fallback never re-enters the multiplexer', () => {
  it('index.ts submits through pasteAndSubmit, not askTerminal', () => {
    // Structural, because this is the bug: askTerminal asks the multiplexer
    // FIRST, so using it to recover from "herdr could not deliver this" hands
    // the same prompt straight back to herdr — a second identical submission,
    // and a third if it fails again. A dep seam cannot express that; the
    // import list can.
    const wiring = readFileSync(path.join(__dirname, '..', 'src', 'main', 'index.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
    const fallback = /reattachFallback: async[\s\S]*?\n  \}/.exec(wiring)?.[0] ?? ''
    expect(fallback).toContain('pasteAndSubmit')
    expect(fallback).not.toContain('askTerminal')
    expect(wiring).not.toContain("import { askTerminal }")
  })

  it('pasteAndSubmit types the prompt and submits it, touching nothing else', async () => {
    vi.useFakeTimers()
    const writes: string[] = []
    const session = { write: (data: string) => writes.push(data) } as unknown as PtySession
    const done = pasteAndSubmit(session, PROMPT)
    expect(writes).toEqual([`\x1b[200~${PROMPT}\x1b[201~`])
    await vi.advanceTimersByTimeAsync(2000)
    await done
    expect(writes).toEqual([`\x1b[200~${PROMPT}\x1b[201~`, '\r'])
    vi.useRealTimers()
  })
})

// ---------------------------------------------------------------------------
// F8 — nothing is left holding a slot or an armed stamp.
// ---------------------------------------------------------------------------

describe('an ended dispatch lets go of the agent', () => {
  it('disarms the tracker when the dispatch ends without a turn (F8)', async () => {
    // Otherwise the id stays armed and the agent's next HUMAN turn is stamped
    // against a dispatch nobody is waiting on.
    const cleared: [string, string][] = []
    const service = new DispatchService(
      deps({
        promptAgent: async () => 'failed',
        reattachFallback: async () => false,
        clearDispatch: (agentId, dispatchId) => cleared.push([agentId, dispatchId])
      })
    )
    await dispatchAndSettle(service)
    expect(service.get('dsp-1')?.state).toBe('failed')
    expect(cleared).toEqual([['agent-1', 'dsp-1']])
  })

  it('the tracker refuses to overwrite a live stamp', () => {
    const tracker = new TurnTracker(async () => null, null)
    expect(tracker.noteDispatch('agent-1', 'dsp-1', PROMPT)).toBe(true)
    expect(tracker.noteDispatch('agent-1', 'dsp-2', 'other work')).toBe(false)
    // Re-stamping the SAME dispatch is a no-op, not a conflict.
    expect(tracker.noteDispatch('agent-1', 'dsp-1', PROMPT)).toBe(true)
    // A superseded dispatch cannot disarm the one that replaced it.
    tracker.clearDispatch('agent-1', 'dsp-2')
    expect(tracker.noteDispatch('agent-1', 'dsp-3', 'third')).toBe(false)
    tracker.clearDispatch('agent-1', 'dsp-1')
    expect(tracker.noteDispatch('agent-1', 'dsp-3', 'third')).toBe(true)
    tracker.disposeAll()
  })

  it('interrupts everything still open at quit', async () => {
    const service = new DispatchService(deps())
    await dispatchAndSettle(service)
    expect(service.interruptAll('app quit')).toEqual(['dsp-1'])
    expect(service.get('dsp-1')?.error).toBe('app quit')
    // Idempotent: a terminal record is not re-stamped by a second sweep.
    expect(service.interruptAll('app quit')).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// F17 — the maps stay bounded once the ledger feeds them.
// ---------------------------------------------------------------------------

describe('closed dispatches are pruned, open ones never', () => {
  it('drops CLOSED records past the retention window and keeps open ones', () => {
    const day = 24 * 60 * 60 * 1000
    const now = 1_700_000_000_000
    const row = (over: Partial<DispatchRecord>): DispatchRecord => ({
      id: 'x',
      agentId: 'agent-1',
      agentName: 'Forge',
      workspaceId: 'ws-1',
      state: 'done',
      via: 'herdr',
      createdAt: now - 30 * day,
      updatedAt: now - 30 * day,
      ...over
    })
    const service = new DispatchService(
      deps({
        now: () => now,
        loadRecords: () => [
          row({ id: 'old', idempotencyKey: 'key-old' }),
          row({ id: 'recent', updatedAt: now - day, idempotencyKey: 'key-recent' }),
          // Open, and older than everything — an unanswered dispatch is still
          // somebody's outstanding work, so age alone cannot retire it. (It
          // hydrates as interrupted, which is terminal but stamped NOW.)
          row({ id: 'stuck', state: 'submitted' })
        ]
      })
    )

    expect(service.get('old')).toBeUndefined()
    expect(service.get('recent')).toBeDefined()
    expect(service.get('stuck')).toMatchObject({ state: 'interrupted' })
  })
})

// ---------------------------------------------------------------------------
// v5 — beginWork/endWork: the dispatch creates its own tracking, once.
// ---------------------------------------------------------------------------

describe('beginWork on accept, endWork exactly once per terminal state', () => {
  /** A service whose work hooks are counted, per agent. */
  function counted(over: Partial<DispatchDeps> = {}): {
    service: DispatchService
    events: string[]
    begins: number
    ends: () => number
  } {
    const events: string[] = []
    const counters = { begins: 0, ends: 0 }
    const service = new DispatchService(
      deps({
        promptAgent: async () => {
          events.push('deliver')
          return 'done'
        },
        beginWork: (agentId) => {
          counters.begins += 1
          events.push(`beginWork:${agentId}`)
          return true
        },
        endWork: (agentId) => {
          counters.ends += 1
          events.push(`endWork:${agentId}`)
        },
        ...over
      })
    )
    return { service, events, get begins() { return counters.begins }, ends: () => counters.ends }
  }

  it('beginWork runs at accept, after the reservation and before delivery', async () => {
    const { service, events } = counted()
    const response = await dispatchAndSettle(service)
    expect(response.status).toBe(202)
    // Order is the contract: the session-file watch and drain pin must exist
    // before the prompt whose turn they are there to observe goes out.
    expect(events.indexOf('beginWork:agent-1')).toBeGreaterThanOrEqual(0)
    expect(events.indexOf('beginWork:agent-1')).toBeLessThan(events.indexOf('deliver'))
  })

  it('a refused dispatch never begins work', async () => {
    const { service, events } = counted({ sessionExists: () => false })
    expect((await service.dispatch('agent-1', { text: PROMPT })).status).toBe(503)
    expect((await service.dispatch('ghost', { text: PROMPT })).status).toBe(404)
    expect(events).toEqual([])
  })

  it('done via turn correlation ends work exactly once', async () => {
    const { service, ends } = counted()
    await dispatchAndSettle(service)
    expect(ends()).toBe(0) // running is not terminal — the pin must hold
    service.completeTurn('dsp-1', { turnIndex: 1, reply: 'ok' })
    expect(ends()).toBe(1)
    // A late second completion or an interrupt cannot double-release the pin.
    service.completeTurn('dsp-1', { turnIndex: 2 })
    service.interrupt('dsp-1', 'too late')
    expect(ends()).toBe(1)
  })

  it('a failed delivery ends work exactly once', async () => {
    const { service, ends } = counted({
      promptAgent: async () => 'failed',
      capture: () => '> '
    })
    await dispatchAndSettle(service)
    expect(service.get('dsp-1')?.state).toBe('failed')
    expect(ends()).toBe(1)
  })

  it('interruptAll at quit ends work exactly once', async () => {
    const { service, ends } = counted()
    await dispatchAndSettle(service)
    service.interruptAll('app quit')
    expect(ends()).toBe(1)
    service.interruptAll('app quit')
    expect(ends()).toBe(1)
  })

  it('the sweep ends work for the dispatch it closes', async () => {
    let clock = 1_700_000_000_000
    const { service, ends } = counted({ now: () => clock })
    await dispatchAndSettle(service)
    clock += 10 * 60 * 1000 + 1
    expect(service.sweep()).toEqual(['dsp-1'])
    expect(ends()).toBe(1)
  })

  it('hydrate ends work for every row a restart closes', () => {
    const open = (id: string): DispatchRecord => ({
      id,
      agentId: 'agent-1',
      agentName: 'Forge',
      workspaceId: 'ws-1',
      state: 'running',
      via: 'herdr',
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000
    })
    const { service, ends } = counted({
      loadRecords: () => [open('dsp-a'), { ...open('dsp-b'), state: 'done' }]
    })
    // Only the OPEN row is closed by hydration; the done one was already
    // released by the process that closed it.
    expect(service.get('dsp-a')?.state).toBe('interrupted')
    expect(ends()).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// The two route literals, over real HTTP plumbing.
// ---------------------------------------------------------------------------

function stubRequest(method: string, body?: unknown): http.IncomingMessage {
  const raw = body === undefined ? undefined : JSON.stringify(body)
  const request = Readable.from(raw ? [raw] : []) as http.IncomingMessage
  request.method = method
  request.headers = {}
  return request
}

function stubResponse(): {
  response: http.ServerResponse
  captured: { status: number; body: Record<string, unknown> }
} {
  const captured = { status: 0, body: {} as Record<string, unknown> }
  const response = {
    writeHead(status: number) {
      captured.status = status
      return this
    },
    end(raw?: string) {
      captured.body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
    }
  } as unknown as http.ServerResponse
  return { response, captured }
}

const url = (raw: string): URL => new URL(raw, 'http://lan.local')

describe('the routes themselves', () => {
  it('POST /api/agents/:id/dispatch hands the body to the engine', async () => {
    const service = new DispatchService(deps())
    const { response, captured } = stubResponse()
    const handled = await handleMobileApi(
      stubRequest('POST', { text: PROMPT, idempotencyKey: 'k' }),
      response,
      url('/api/agents/agent-1/dispatch'),
      { dispatch: service } as unknown as MobileApiDeps
    )
    expect(handled).toBe(true)
    expect(captured.status).toBe(202)
    expect(captured.body).toMatchObject({ dispatchId: 'dsp-1' })
    await service.settled('dsp-1')
  })

  it('GET /api/dispatches/:id reports the lifecycle', async () => {
    const service = new DispatchService(deps())
    await dispatchAndSettle(service)
    const { response, captured } = stubResponse()
    await handleMobileApi(
      stubRequest('GET'),
      response,
      url('/api/dispatches/dsp-1'),
      { dispatch: service } as unknown as MobileApiDeps
    )
    expect(captured.status).toBe(200)
    expect(captured.body).toMatchObject({ id: 'dsp-1', agentName: 'Forge', state: 'running' })
  })

  it('401s the GET without a token — the write gate never covered it (F4)', async () => {
    // The choke point fires on non-GET only, so this read was open on the
    // 0.0.0.0 listener: any id, from anyone on the LAN, described commissioned
    // work at a named agent. Same exposure argument as /api/board, same gate.
    const service = new DispatchService(deps())
    await dispatchAndSettle(service)
    const { response, captured } = stubResponse()
    const handled = await handleMobileApi(
      stubRequest('GET'),
      response,
      url('/api/dispatches/dsp-1'),
      { dispatch: service, pairingToken: 'secret' } as unknown as MobileApiDeps
    )
    expect(handled).toBe(true)
    expect(captured.status).toBe(401)
    expect(JSON.stringify(captured.body)).not.toContain('Forge')
  })

  it('serves the GET to the pairing token, and 403s the read-only one', async () => {
    // Following a dispatch is part of commissioning work, and the wall's token
    // is scoped to the curated read projections. 403 rather than 401 — the
    // token is known, its scope is not enough.
    const service = new DispatchService(deps())
    await dispatchAndSettle(service)
    const tokens = { pairingToken: 'secret', wallToken: 'wall' }

    const wall = stubResponse()
    await handleMobileApi(
      stubRequest('GET'),
      wall.response,
      url('/api/dispatches/dsp-1?token=wall'),
      { dispatch: service, ...tokens } as unknown as MobileApiDeps
    )
    expect(wall.captured.status).toBe(403)

    const phone = stubResponse()
    await handleMobileApi(
      stubRequest('GET'),
      phone.response,
      url('/api/dispatches/dsp-1?token=secret'),
      { dispatch: service, ...tokens } as unknown as MobileApiDeps
    )
    expect(phone.captured.status).toBe(200)
    expect(phone.captured.body).toMatchObject({ id: 'dsp-1' })
  })

  it('answers 503 — not 404 — when the engine is not wired', async () => {
    // A consumer holding a catalog entry for this route must be able to tell
    // "this deployment cannot serve it right now" from "no such route".
    const { response, captured } = stubResponse()
    const handled = await handleMobileApi(
      stubRequest('POST', { text: PROMPT }),
      response,
      url('/api/agents/agent-1/dispatch'),
      {} as unknown as MobileApiDeps
    )
    expect(handled).toBe(true)
    expect(captured.status).toBe(503)
  })
})

// ---------------------------------------------------------------------------
// dispatchId threading — tracker → CompletedTurn → turn.completed details.
// ---------------------------------------------------------------------------

class FakeSession extends EventEmitter {
  terminalId = 'agent-1'
  full = ''
  idle = 0
  fullText(): string {
    return this.full
  }
  viewportText(): string {
    return this.full
  }
  idleFor(): number {
    return this.idle
  }
}

async function runTurn(session: FakeSession, prompt: string): Promise<void> {
  session.emit('input', `${prompt}\r`)
  session.full = '⏺ done'
  session.idle = 99_999
  await vi.advanceTimersByTimeAsync(3000)
}

describe('dispatchId rides the turn it caused', () => {
  afterEach(() => vi.useRealTimers())

  it('stamps the next completed turn and only that one', async () => {
    vi.useFakeTimers()
    const tracker = new TurnTracker(async () => null, null)
    const session = new FakeSession()
    const seen: CompletedTurn[] = []
    tracker.on('turn', (t: CompletedTurn) => seen.push(t))
    tracker.track(session as unknown as PtySession, true)

    tracker.noteDispatch('agent-1', 'dsp-1', 'first')
    await runTurn(session, 'first')
    await runTurn(session, 'second')

    expect(seen).toHaveLength(2)
    expect(seen[0].dispatchId).toBe('dsp-1')
    // Consumed, not sticky: the agent's own next turn is not the API's work,
    // and attributing it to the caller would be a fabricated correlation.
    expect(seen[1].dispatchId).toBeUndefined()
    tracker.disposeAll()
  })

  it('leaves an undispatched turn unmarked', async () => {
    vi.useFakeTimers()
    const tracker = new TurnTracker(async () => null, null)
    const session = new FakeSession()
    const seen: CompletedTurn[] = []
    tracker.on('turn', (t: CompletedTurn) => seen.push(t))
    tracker.track(session as unknown as PtySession, true)

    await runTurn(session, 'typed by a human')
    expect(seen[0].dispatchId).toBeUndefined()
    tracker.disposeAll()
  })

  it('does not claim a turn already in flight when the dispatch armed', async () => {
    // The armedAt guard: a human turn running when the dispatch arrives is not
    // the dispatch's answer. The stamp waits for the NEXT turn — the one the
    // dispatched prompt, queued in the input box, actually starts.
    vi.useFakeTimers()
    const tracker = new TurnTracker(async () => null, null)
    const session = new FakeSession()
    const seen: CompletedTurn[] = []
    tracker.on('turn', (t: CompletedTurn) => seen.push(t))
    tracker.track(session as unknown as PtySession, true)

    session.emit('input', 'a human question\r')
    session.full = '⏺ thinking'
    await vi.advanceTimersByTimeAsync(50)
    tracker.noteDispatch('agent-1', 'dsp-1', 'the dispatched brief')
    session.full = '⏺ done'
    session.idle = 99_999
    await vi.advanceTimersByTimeAsync(3000)

    expect(seen).toHaveLength(1)
    expect(seen[0].dispatchId).toBeUndefined()

    await runTurn(session, 'the dispatched brief')
    expect(seen).toHaveLength(2)
    expect(seen[1].dispatchId).toBe('dsp-1')
    tracker.disposeAll()
  })

  it('turnDetails carries the id into the event log, and nothing else', () => {
    expect(turnDetails('dsp-1')).toBe('dispatch=dsp-1')
    expect(turnDetails(undefined)).toBeUndefined()
  })

  it('does not let a late delivery observation regress done back to running', async () => {
    let finish!: (outcome: 'done') => void
    const outcome = new Promise<'done'>((resolve) => (finish = resolve))
    const service = new DispatchService(
      deps({ promptAgent: async () => outcome })
    )

    const response = await service.dispatch('agent-1', { text: PROMPT })
    const dispatchId = String(response.body.dispatchId)
    service.completeTurn(dispatchId, { turnIndex: 9, reply: 'already final' })
    finish('done')
    await service.settled(dispatchId)

    expect(service.get(dispatchId)).toMatchObject({
      state: 'done',
      turnIndex: 9,
      reply: 'already final'
    })
  })
})
