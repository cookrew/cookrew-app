// Sol r6 P0-1 / P0-2 — the delivery legs under the producer lease.
//
// Three properties:
// - a dispatch arming while an owner submission is in flight (inside its own
//   blocking promptAgent) is REFUSED by the lease at delivery time — the
//   r5 deliveryLive check saw only dispatch state and would have submitted a
//   second producer's bytes beside the owner's;
// - the fallback holds the lease across paste → delay → CR and threads a
//   stillValid check into the reattach wiring, so a cancellation inside the
//   delay window stops the sequence before the submitting Enter;
// - every leg releases in a finally, so the terminal's window frees whether
//   the delivery succeeded, failed or was displaced.

import { describe, expect, it } from 'vitest'
import {
  DispatchService,
  type DispatchDeps,
  type DispatchGeneration
} from '../src/main/dispatch'
import { ProducerLease, ownerHolder } from '../src/main/producer-lease'

const PROMPT = 'Run the F2 simulation and report the counts.'
const NOW = 1_700_000_000_000

function deps(over: Partial<DispatchDeps> = {}): DispatchDeps {
  return {
    resolveAgent: (id) => (id === 'agent-1' ? { name: 'Forge', workspaceId: 'ws-1' } : null),
    sessionNameFor: (id) => `cookrew_${id}`,
    sessionExists: () => true,
    capture: () => 'idle\n> ',
    promptAgent: async () => 'done',
    noteDispatch: () => true,
    beginWork: () => true,
    endWork: () => undefined,
    persist: () => true,
    newId: () => 'dsp-1',
    now: () => NOW,
    ...over
  }
}

async function settle(service: DispatchService, dispatchId = 'dsp-1'): Promise<void> {
  await service.settled(dispatchId)
}

describe('a dispatch racing an in-flight owner submission (Sol r6 P0-1)', () => {
  it('arm between guard and promptAgent: the delivery is refused by the lease', async () => {
    // The owner ask acquired the lease and sits inside its blocking
    // promptAgent; the dispatch arms and its leg reaches the submit site.
    // Nothing in dispatch state says stop — the LEASE does.
    const lease = new ProducerLease()
    const owner = ownerHolder()
    lease.acquire('agent-1', owner)
    let prompts = 0
    const delivered: Array<{ prompt: string; gen: DispatchGeneration }> = []
    const retracted: Array<{ prompt: string; gen: DispatchGeneration }> = []
    const cleared: string[] = []
    const service = new DispatchService(
      deps({
        lease,
        promptAgent: async () => {
          prompts += 1
          return 'done'
        },
        noteDelivered: (_agentId, prompt, gen) => delivered.push({ prompt, gen }),
        retractDelivered: (_agentId, prompt, gen) => retracted.push({ prompt, gen }),
        clearDispatch: (_agentId, dispatchId) => cleared.push(dispatchId)
      })
    )
    const response = await service.dispatch('agent-1', { text: PROMPT })
    expect(response.status).toBe(202)
    await settle(service)

    // No prompt went out, the attempted fact was taken back, and the record
    // closed with an honest, retryable failure.
    expect(prompts).toBe(0)
    expect(retracted).toEqual(delivered)
    expect(service.get('dsp-1')).toMatchObject({
      state: 'failed',
      error: 'an owner submission was in flight at delivery time'
    })
    // The terminal transition released the slot and disarmed the stamp.
    expect(cleared).toEqual(['dsp-1'])
    // The owner still holds the window — the refused leg released nothing it
    // did not own.
    expect(lease.holderOf('agent-1')).toBe(owner)
  })

  it('after the owner releases, a fresh dispatch delivers normally', async () => {
    const lease = new ProducerLease()
    const owner = ownerHolder()
    lease.acquire('agent-1', owner)
    let prompts = 0
    let seq = 0
    const service = new DispatchService(
      deps({
        lease,
        newId: () => `dsp-${(seq += 1)}`,
        promptAgent: async () => {
          prompts += 1
          return 'done'
        }
      })
    )
    await service.dispatch('agent-1', { text: PROMPT })
    await settle(service, 'dsp-1')
    expect(service.get('dsp-1')?.state).toBe('failed')
    expect(prompts).toBe(0)

    lease.release('agent-1', owner)
    await service.dispatch('agent-1', { text: PROMPT })
    await settle(service, 'dsp-2')
    expect(prompts).toBe(1)
    expect(service.get('dsp-2')?.state).toBe('running')
    // The leg released its hold at submission acknowledgement.
    expect(lease.holderOf('agent-1')).toBeNull()
  })

  it('the native leg holds the lease WHILE promptAgent blocks and releases on resolve', async () => {
    const lease = new ProducerLease()
    const during: Array<ReturnType<ProducerLease['holderOf']>> = []
    const service = new DispatchService(
      deps({
        lease,
        promptAgent: async () => {
          during.push(lease.holderOf('agent-1'))
          return 'done'
        }
      })
    )
    await service.dispatch('agent-1', { text: PROMPT })
    await settle(service)
    expect(during).toEqual([{ kind: 'dispatch', dispatchId: 'dsp-1' }])
    expect(lease.holderOf('agent-1')).toBeNull()
    expect(service.get('dsp-1')?.state).toBe('running')
  })
})

describe('the fallback under the lease (Sol r6 P0-1 + P0-2)', () => {
  it('holds the lease across the fallback and hands it a live stillValid check', async () => {
    const lease = new ProducerLease()
    const verdicts: boolean[] = []
    const holdsDuringFallback: Array<ReturnType<ProducerLease['holderOf']>> = []
    const service = new DispatchService(
      deps({
        lease,
        promptAgent: async () => 'failed',
        capture: () => '> ', // pane never moved, no echo → non-delivery proven
        agentStatus: () => 'idle',
        reattachFallback: async (_agentId, _prompt, stillValid) => {
          holdsDuringFallback.push(lease.holderOf('agent-1'))
          verdicts.push(stillValid?.() ?? true)
          // Cancellation lands INSIDE the paste delay window: the wiring's
          // next stillValid consult (before the CR) must say stop.
          service.interruptAgent('agent-1', 'owner preempted mid-fallback')
          verdicts.push(stillValid?.() ?? true)
          return false
        }
      })
    )
    await service.dispatch('agent-1', { text: PROMPT })
    await settle(service)

    expect(holdsDuringFallback).toEqual([{ kind: 'dispatch', dispatchId: 'dsp-1' }])
    // Live before the cancellation, dead after — the exact verdict sequence
    // pasteAndSubmit consults around its delayed CR.
    expect(verdicts).toEqual([true, false])
    // The canceller owns the outcome; the fallback's own failure update
    // no-ops against the terminal record.
    expect(service.get('dsp-1')).toMatchObject({
      state: 'interrupted',
      error: 'owner preempted mid-fallback'
    })
    expect(lease.holderOf('agent-1')).toBeNull()
  })

  it('terminal retirement (lease generation bump) also flips stillValid false', async () => {
    // With displacement gone (Sol r7 P0-1), the only ways a leg loses its
    // hold mid-fallback are its own cancellation and RETIREMENT — the
    // terminal's permanent ending bumping the lease generation (Sol r7 P1).
    const lease = new ProducerLease()
    const verdicts: boolean[] = []
    const service = new DispatchService(
      deps({
        lease,
        promptAgent: async () => 'failed',
        capture: () => '> ',
        agentStatus: () => 'idle',
        reattachFallback: async (_agentId, _prompt, stillValid) => {
          verdicts.push(stillValid?.() ?? true)
          service.interruptAgent('agent-1', 'terminal removed')
          lease.retire('agent-1')
          verdicts.push(stillValid?.() ?? true)
          return false
        }
      })
    )
    await service.dispatch('agent-1', { text: PROMPT })
    await settle(service)
    expect(verdicts).toEqual([true, false])
    // The dead leg's finally-release was a no-op against the reborn
    // terminal: its window is simply free.
    expect(lease.holderOf('agent-1')).toBeNull()
  })

  it('a partial-paste cancellation CONTAMINATES the terminal, and the next delivery refuses', async () => {
    // The full state machine (Sol r7 P0-1): the fallback's paste goes out,
    // the leg is cancelled inside the delay window, the CR is withheld — and
    // the cancelled prompt is now sitting in the shared input box. The
    // wiring (index.ts reattachFallback → pasteAndSubmit) marks the lease
    // contaminated; every later submit-capable producer refuses until the
    // owner clears the box.
    const lease = new ProducerLease()
    let seq = 0
    let deliverNatively = false
    const service = new DispatchService(
      deps({
        lease,
        newId: () => `dsp-${(seq += 1)}`,
        promptAgent: async () => (deliverNatively ? 'done' : 'failed'),
        capture: () => '> ',
        agentStatus: () => 'idle',
        reattachFallback: async (_agentId, _prompt, stillValid) => {
          // Model exactly what pasteAndSubmit does: paste written, THEN the
          // cancellation check fails — contaminated, CR never written.
          service.interruptAgent('agent-1', 'cancelled mid-fallback')
          if (stillValid !== undefined && !stillValid()) {
            lease.markContaminated('agent-1', lease.generationOf('agent-1'))
            return false
          }
          return true
        }
      })
    )
    await service.dispatch('agent-1', { text: PROMPT })
    await settle(service, 'dsp-1')
    expect(lease.isContaminated('agent-1')).toBe(true)

    // The NEXT dispatch — a fresh producer — refuses at the delivery leg:
    // its native submission would type into the same dirty box. The refusal
    // names the one real remedy (Sol r8 P0-2): restart the terminal.
    const response = await service.dispatch('agent-1', { text: 'fresh brief' })
    expect(response.status).toBe(202)
    await settle(service, 'dsp-2')
    expect(service.get('dsp-2')).toMatchObject({
      state: 'failed',
      error: 'input box contaminated by a cancelled delivery — restart the terminal to clear it'
    })

    // ONLY the terminal generation reset (restart) readmits deliveries —
    // no control byte, no owner acknowledgment (Sol r8 P0-2).
    lease.retire('agent-1')
    deliverNatively = true
    await service.dispatch('agent-1', { text: 'after the restart' })
    await settle(service, 'dsp-3')
    expect(service.get('dsp-3')?.state).toBe('running')
  })

  it('contamination refuses the FALLBACK leg too', async () => {
    const lease = new ProducerLease()
    let reattaches = 0
    const service = new DispatchService(
      deps({
        lease,
        promptAgent: async () => 'failed',
        capture: () => '> ',
        // Contamination lands between the native attempt and the fallback
        // (a concurrent cancellation at the same terminal), modeled inside
        // the evidence pass — the last read before the fallback's acquire.
        agentStatus: () => {
          lease.markContaminated('agent-1')
          return 'idle'
        },
        reattachFallback: async () => {
          reattaches += 1
          return true
        }
      })
    )
    await service.dispatch('agent-1', { text: PROMPT })
    await settle(service)
    expect(reattaches).toBe(0)
    expect(String(service.get('dsp-1')?.error)).toContain('restart the terminal to clear it')
  })

  it('an owner taking the window between promptAgent and the fallback refuses the fallback', async () => {
    const lease = new ProducerLease()
    const owner = ownerHolder()
    let reattaches = 0
    const service = new DispatchService(
      deps({
        lease,
        promptAgent: async () => 'failed',
        capture: () => '> ',
        // The evidence pass runs between the native release and the fallback
        // acquire — the exact gap an owner submission can land in.
        agentStatus: () => {
          lease.acquire('agent-1', owner)
          return 'idle'
        },
        reattachFallback: async () => {
          reattaches += 1
          return true
        }
      })
    )
    await service.dispatch('agent-1', { text: PROMPT })
    await settle(service)

    expect(reattaches).toBe(0)
    expect(service.get('dsp-1')?.state).toBe('failed')
    expect(String(service.get('dsp-1')?.error)).toContain(
      'an owner submission was in flight at fallback time'
    )
    expect(lease.holderOf('agent-1')).toBe(owner)
  })
})

// ---------------------------------------------------------------------------
// Sol r8 P0-1 — input-buffer ownership. Typing is not a submission, so the
// lease alone let a dispatch acquire the free window while real owner text
// sat half-typed in the shared input box; the delivered paste would ride the
// owner's eventual Enter as one combined principal input. `ownerComposing`
// (wired to TurnTracker.ownerComposing) closes it at admission AND at both
// irreversible submission sites.
// ---------------------------------------------------------------------------

describe('owner composing vs dispatch (Sol r8 P0-1)', () => {
  it('type-then-dispatch: admission refuses 409 — the input box is theirs', async () => {
    let noted = 0
    const service = new DispatchService(
      deps({
        ownerComposing: () => true,
        noteDispatch: () => {
          noted += 1
          return true
        }
      })
    )
    const response = await service.dispatch('agent-1', { text: PROMPT })
    expect(response).toEqual({
      status: 409,
      body: { error: 'owner is composing — the input box is theirs' }
    })
    // Refused before anything was recorded: no stamp, no row, no reservation.
    expect(noted).toBe(0)
    expect(service.get('dsp-1')).toBeUndefined()
    const clear = new DispatchService(deps({ ownerComposing: () => false }))
    expect((await clear.dispatch('agent-1', { text: PROMPT })).status).toBe(202)
  })

  it('dispatch-202-then-type: the delivery leg cancels like an interrupt', async () => {
    // Admission saw a clean box; the owner starts typing while the leg sits
    // on its setImmediate hop. The revalidation immediately before the
    // irreversible promptAgent cancels the delivery and retracts the
    // attempted fact — nothing went out, and the record says whose box it is.
    let composing = false
    let prompts = 0
    const delivered: string[] = []
    const retracted: string[] = []
    const service = new DispatchService(
      deps({
        ownerComposing: () => composing,
        promptAgent: async () => {
          prompts += 1
          return 'done'
        },
        noteDelivered: (_agentId, prompt) => delivered.push(prompt),
        retractDelivered: (_agentId, prompt) => retracted.push(prompt)
      })
    )
    const response = await service.dispatch('agent-1', { text: PROMPT })
    expect(response.status).toBe(202)
    composing = true
    await settle(service)
    expect(prompts).toBe(0)
    expect(retracted).toEqual(delivered)
    expect(service.get('dsp-1')).toMatchObject({
      state: 'interrupted',
      error: 'interrupted: owner took the input box'
    })
  })

  it('buffer cleared: the next dispatch is admitted and delivers', async () => {
    let composing = true
    let prompts = 0
    let seq = 0
    const service = new DispatchService(
      deps({
        ownerComposing: () => composing,
        newId: () => `dsp-${(seq += 1)}`,
        promptAgent: async () => {
          prompts += 1
          return 'done'
        }
      })
    )
    expect((await service.dispatch('agent-1', { text: PROMPT })).status).toBe(409)
    // The owner submitted (or erased) their typing — the reservation lifted.
    composing = false
    expect((await service.dispatch('agent-1', { text: PROMPT })).status).toBe(202)
    await settle(service, 'dsp-1')
    expect(prompts).toBe(1)
    expect(service.get('dsp-1')?.state).toBe('running')
  })

  it('a background terminal is unaffected by the composing owner elsewhere', async () => {
    let prompts = 0
    const service = new DispatchService(
      deps({
        resolveAgent: (id) =>
          id === 'agent-1' || id === 'agent-2' ? { name: 'Forge', workspaceId: 'ws-1' } : null,
        // The owner is typing at agent-1's terminal only.
        ownerComposing: (agentId) => agentId === 'agent-1',
        promptAgent: async () => {
          prompts += 1
          return 'done'
        }
      })
    )
    expect((await service.dispatch('agent-1', { text: PROMPT })).status).toBe(409)
    expect((await service.dispatch('agent-2', { text: PROMPT })).status).toBe(202)
    await settle(service)
    expect(prompts).toBe(1)
    expect(service.get('dsp-1')?.state).toBe('running')
  })

  it('the FALLBACK leg revalidates composing before its paste too', async () => {
    let composing = false
    let reattaches = 0
    const service = new DispatchService(
      deps({
        ownerComposing: () => composing,
        promptAgent: async () => 'failed',
        capture: () => '> ',
        // The compose starts between the failed native attempt and the
        // fallback — modeled in the evidence pass, the last read before it.
        agentStatus: () => {
          composing = true
          return 'idle'
        },
        reattachFallback: async () => {
          reattaches += 1
          return true
        }
      })
    )
    await service.dispatch('agent-1', { text: PROMPT })
    await settle(service)
    expect(reattaches).toBe(0)
    expect(service.get('dsp-1')).toMatchObject({
      state: 'interrupted',
      error: 'interrupted: owner took the input box'
    })
  })
})

// ---------------------------------------------------------------------------
// Sol r8 P1 — the abort seam. Generation checks already made a late child's
// settlement harmless to STATE; the AbortController makes it harmless to
// RESOURCES: the blocking CLI child is killed at cancellation instead of
// living out the ten-minute timeout.
// ---------------------------------------------------------------------------

describe('the delivery abort seam (Sol r8 P1)', () => {
  it('interruptAgent mid-native-wait kills the child; the leg settles with no state change', async () => {
    const lease = new ProducerLease()
    let observed: AbortSignal | undefined
    const service = new DispatchService(
      deps({
        lease,
        // Model execFile with a signal: block until the abort fires, then
        // reject the way a TERM-killed child settles its callback.
        promptAgent: (_name, _prompt, _timeout, signal) =>
          new Promise((_resolve, reject) => {
            observed = signal
            signal?.addEventListener('abort', () => reject(new Error('AbortError')), {
              once: true
            })
          })
      })
    )
    const response = await service.dispatch('agent-1', { text: PROMPT })
    expect(response.status).toBe(202)
    // Let the leg reach its blocking promptAgent.
    await new Promise((resolve) => setImmediate(resolve))
    expect(observed).toBeDefined()
    expect(observed?.aborted).toBe(false)

    service.interruptAgent('agent-1', 'terminal removed')
    // The interrupt aborted the child NOW — no ten-minute zombie.
    expect(observed?.aborted).toBe(true)
    await settle(service)
    // The canceller owns the outcome; the aborted leg asserted nothing.
    expect(service.get('dsp-1')).toMatchObject({
      state: 'interrupted',
      error: 'terminal removed'
    })
    expect(lease.holderOf('agent-1')).toBeNull()
  })

  it('promptAgent receives the signal on the ordinary path and it never fires', async () => {
    const signals: Array<AbortSignal | undefined> = []
    const service = new DispatchService(
      deps({
        promptAgent: async (_name, _prompt, _timeout, signal) => {
          signals.push(signal)
          return 'done'
        }
      })
    )
    await service.dispatch('agent-1', { text: PROMPT })
    await settle(service)
    expect(signals).toHaveLength(1)
    expect(signals[0]?.aborted).toBe(false)
    expect(service.get('dsp-1')?.state).toBe('running')
  })
})
