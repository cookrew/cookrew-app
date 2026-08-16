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

  it('a committed owner takeover (lease seized) also flips stillValid false', async () => {
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
          // The owner's acquisition path: durable preemption committed, then
          // displacement. The record interrupt is the preemption's effect...
          service.interruptAgent('agent-1', 'preempted by owner input')
          lease.acquire('agent-1', ownerHolder(), { displaceDispatch: true })
          verdicts.push(stillValid?.() ?? true)
          return false
        }
      })
    )
    await service.dispatch('agent-1', { text: PROMPT })
    await settle(service)
    expect(verdicts).toEqual([true, false])
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
