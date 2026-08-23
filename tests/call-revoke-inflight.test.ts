import { describe, expect, it, vi } from 'vitest'
import { CallsInFlight, type CallIdentity } from '../src/main/call-inflight'
import { makeCallRun, type CallRunDeps } from '../src/main/call-run'
import { OwnerGrant } from '../src/main/owner-grant'
import type { AgentExportStore } from '../src/main/agent-export'

/**
 * REVOKE STOPS CALLS ALREADY RUNNING (Velvet's ruling, owner-confirmed).
 *
 * The control someone reaches for in a panic, and the only question they are
 * asking is MAKE IT STOP NOW. So the copy on the button is the specification,
 * and the code meets it — a revoke that quietly let the current call finish
 * would be a string and a behaviour that disagree, which is the one outcome
 * ruled out.
 *
 * "Stop" is two separate promises, and they are worth separating because they
 * fail differently:
 *
 *   THE REPLY NEVER ARRIVES. Guaranteed, unconditionally, at the seam. Even if
 *   the agent's answer resolves a millisecond after the cut, a revoked caller
 *   does not receive it. This is the security property and it does not depend
 *   on anything downstream cooperating.
 *
 *   THE WORK ACTUALLY STOPS. The ask's own cancellation scope is fired, which
 *   already reaches every phase — native leg, typed fallback, the reply waits.
 *   Best-effort by nature: a model mid-token stops when its runner notices.
 *
 * The first is what makes revoke SAFE. The second is what makes it HONEST.
 */

const ID = (over: Partial<CallIdentity> = {}): CallIdentity => ({
  workspaceId: 'w1',
  sub: 'buyer-1',
  nodeId: 'node-1',
  ...over
})

describe('CallsInFlight · a call in flight can be found and cut', () => {
  it('still counts, because liveness fact 3 has not changed', () => {
    const flight = new CallsInFlight()
    const done = flight.enter(ID(), () => undefined)
    expect(flight.count('w1')).toBe(1)
    done()
    expect(flight.count('w1')).toBe(0)
    expect(flight.active()).toEqual([])
  })

  it('cuts only what matches, and says how many', () => {
    const flight = new CallsInFlight()
    const cut: string[] = []
    flight.enter(ID({ sub: 'buyer-1' }), () => cut.push('buyer-1'))
    flight.enter(ID({ sub: 'buyer-2' }), () => cut.push('buyer-2'))
    flight.enter(ID({ sub: 'buyer-1', workspaceId: 'w2' }), () => cut.push('other-workspace'))

    const n = flight.cancelWhere((id) => id.workspaceId === 'w1' && id.sub === 'buyer-1')

    expect(n).toBe(1)
    expect(cut).toEqual(['buyer-1'])
  })

  it('a cut call is not cut twice, and does not decrement someone else', () => {
    // The release is idempotent for the same reason it always was: a double
    // release would drain the workspace out from under a LATER call.
    const flight = new CallsInFlight()
    const cancel = vi.fn()
    const done = flight.enter(ID(), cancel)

    flight.cancelWhere(() => true)
    flight.cancelWhere(() => true)
    expect(cancel).toHaveBeenCalledTimes(1)

    done()
    done()
    expect(flight.count('w1')).toBe(0)
  })

  it('a cancel that throws does not strand the rest of the sweep', () => {
    const flight = new CallsInFlight()
    const second = vi.fn()
    flight.enter(ID({ sub: 'a' }), () => {
      throw new Error('the runner was already gone')
    })
    flight.enter(ID({ sub: 'b' }), second)

    expect(flight.cancelWhere(() => true)).toBe(2)
    expect(second).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------

function runDeps(over: Partial<CallRunDeps> = {}): CallRunDeps {
  return {
    sessionOf: () => ({}),
    ready: () => Promise.resolve(),
    ask: () => Promise.resolve('an answer'),
    inFlight: () => () => undefined,
    wait: () => new Promise(() => undefined),
    ...over
  }
}

describe('call-run · a revoked call stops, and its reply never lands', () => {
  it('serves normally when nobody revokes', async () => {
    const run = makeCallRun(runDeps())
    const outcome = await run({ workspaceId: 'w1', forkId: 'f1', prompt: 'hello', sub: 's', nodeId: 'n' })
    expect(outcome).toMatchObject({ ok: true, text: 'an answer' })
  })

  it('THE REPLY NEVER ARRIVES — even when the agent answers after the cut', async () => {
    // The security property, stated as the race it actually is. The ask is
    // still resolving when the owner revokes; the caller must not get it.
    const flight = new CallsInFlight()
    let answer: (text: string) => void = () => undefined
    const run = makeCallRun(
      runDeps({
        inFlight: (identity, cancel) => flight.enter(identity, cancel),
        ask: () => new Promise<string>((resolve) => { answer = resolve })
      })
    )

    const pending = run({ workspaceId: 'w1', forkId: 'f1', prompt: 'hi', sub: 'buyer-1', nodeId: 'node-1' })
    await Promise.resolve()

    expect(flight.cancelWhere((id) => id.sub === 'buyer-1')).toBe(1)
    // The agent answers anyway, a beat too late.
    answer('the secret the owner did not mean to send')

    expect(await pending).toEqual({ ok: false, reason: 'revoked' })
  })

  it('THE WORK ACTUALLY STOPS — the ask is told to cancel, not just ignored', async () => {
    const flight = new CallsInFlight()
    const aborted = vi.fn()
    // Cut once the ask is genuinely underway, rather than after a fixed number
    // of microtask ticks — the first draft of this test cancelled before `ask`
    // had been reached and proved nothing about the signal at all.
    let started: () => void = () => undefined
    const asking = new Promise<void>((resolve) => { started = resolve })
    const run = makeCallRun(
      runDeps({
        inFlight: (identity, cancel) => flight.enter(identity, cancel),
        ask: (_session, _prompt, signal) => {
          signal?.addEventListener('abort', () => aborted())
          started()
          return new Promise(() => undefined)
        }
      })
    )

    const pending = run({ workspaceId: 'w1', forkId: 'f1', prompt: 'hi', sub: 'buyer-1', nodeId: 'node-1' })
    await asking
    flight.cancelWhere(() => true)

    expect(await pending).toEqual({ ok: false, reason: 'revoked' })
    expect(aborted).toHaveBeenCalledTimes(1)
  })

  it('a cut during the READY wait stops too — the cold-fork window is covered', async () => {
    // A call revoked while its fork is still booting has produced nothing and
    // is the easiest one to forget. It is also the longest window.
    const flight = new CallsInFlight()
    const run = makeCallRun(
      runDeps({
        inFlight: (identity, cancel) => flight.enter(identity, cancel),
        ready: () => new Promise(() => undefined)
      })
    )

    const pending = run({ workspaceId: 'w1', forkId: 'f1', prompt: 'hi', sub: 'buyer-1', nodeId: 'node-1' })
    await Promise.resolve()
    flight.cancelWhere(() => true)

    expect(await pending).toEqual({ ok: false, reason: 'revoked' })
  })

  it('releases the in-flight hold even when cut, so the workspace can drain', async () => {
    const flight = new CallsInFlight()
    const run = makeCallRun(
      runDeps({
        inFlight: (identity, cancel) => flight.enter(identity, cancel),
        ask: () => new Promise(() => undefined)
      })
    )

    const pending = run({ workspaceId: 'w1', forkId: 'f1', prompt: 'hi', sub: 'b', nodeId: 'n' })
    await Promise.resolve()
    flight.cancelWhere(() => true)
    await pending

    expect(flight.count('w1')).toBe(0)
  })
})

// ---------------------------------------------------------------------------

function grantWith(cut: (match: (id: CallIdentity) => boolean) => number): {
  grant: OwnerGrant
  store: AgentExportStore
} {
  const store = {
    enrol: () => ({ ok: true }),
    revoke: () => undefined,
    enrolledKey: () => ({ kty: 'OKP' }),
    exportAgent: () => undefined,
    unexport: () => undefined,
    exportOf: () => null,
    exportsIn: () => []
  } as unknown as AgentExportStore
  return { grant: new OwnerGrant({ store, cancelInFlight: cut }), store }
}

describe('OwnerGrant · revoking is what cuts the call', () => {
  it('revoke cuts that caller, in that workspace, and reports the count', () => {
    const seen: CallIdentity[] = []
    const { grant } = grantWith((match) => {
      for (const id of [
        ID({ sub: 'buyer-1' }),
        ID({ sub: 'buyer-2' }),
        ID({ sub: 'buyer-1', workspaceId: 'w2' })
      ]) {
        if (match(id)) seen.push(id)
      }
      return seen.length
    })

    const result = grant.revoke('w1', 'buyer-1')

    expect(seen).toEqual([ID({ sub: 'buyer-1' })])
    // The number goes back to the owner, because "revoked" and "revoked, and
    // stopped 3 calls that were running" are different things to be told.
    expect(result).toMatchObject({ ok: true, stopped: 1 })
  })

  it('unexport cuts every caller of THAT agent — the address stops answering', () => {
    const seen: CallIdentity[] = []
    const { grant } = grantWith((match) => {
      for (const id of [
        ID({ sub: 'buyer-1', nodeId: 'node-1' }),
        ID({ sub: 'buyer-2', nodeId: 'node-1' }),
        ID({ sub: 'buyer-1', nodeId: 'node-2' })
      ]) {
        if (match(id)) seen.push(id)
      }
      return seen.length
    })

    const result = grant.unexport('w1', 'node-1')

    expect(seen.map((s) => s.sub)).toEqual(['buyer-1', 'buyer-2'])
    expect(result).toMatchObject({ ok: true, stopped: 2 })
  })

  it('enrol and export cut nothing — only taking access away stops work', () => {
    const cut = vi.fn(() => 0)
    const { grant } = grantWith(cut)
    grant.enrol('w1', 'buyer-1', { kty: 'OKP' })
    grant.exportAgent('w1', 'node-1', ['buyer-1'])
    expect(cut).not.toHaveBeenCalled()
  })

  it('a canceller that throws does not undo a revoke the owner already made', () => {
    // Same rule the audit line follows: the decision stands, the side effect
    // is best-effort. A revoke that reported failure because a cleanup threw
    // would leave the owner believing access is still granted when it is not.
    const { grant } = grantWith(() => {
      throw new Error('the in-flight registry is gone')
    })
    expect(grant.revoke('w1', 'buyer-1')).toMatchObject({ ok: true, stopped: 0 })
  })

  it('works with no canceller wired at all', () => {
    const store = { revoke: () => undefined } as unknown as AgentExportStore
    expect(new OwnerGrant({ store }).revoke('w1', 'b')).toMatchObject({ ok: true, stopped: 0 })
  })
})
