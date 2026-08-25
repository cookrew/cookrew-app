import { describe, expect, it, beforeEach } from 'vitest'
import {
  SessionInstantiator,
  type InstantiatorDeps,
  type ResolvedTemplate,
  type SessionIdentity
} from '../src/main/session-instantiator'

/**
 * THE INSTANTIATOR'S DECISIONS, with no filesystem, PTY or network — which is
 * the whole reason it is built behind seams. Every hazard the design names is a
 * test here: the pin resolved once, the ordinal never reused after END, the cut
 * before the cleanup, and a failed mint that burns nothing.
 */

// A template whose "current" pin the test can move, to prove a running session
// keeps the version it started on while a new one gets the latest.
class FakeTemplates {
  version = 1
  pinAddress = 'sha256:v1'
  read(serviceId: string): ResolvedTemplate {
    return { snapshot: { serviceId }, version: this.version, pinAddress: this.pinAddress }
  }
  bumpTo(version: number, pinAddress: string): void {
    this.version = version
    this.pinAddress = pinAddress
  }
}

// Records every mint; can be told to fail the next one, to prove a failed mint
// consumes no ordinal; can be gated to hold a mint open, to drive the race.
class FakeMinter {
  readonly minted: { sessionId: string; version: number }[] = []
  private failNext = false
  private gate: Promise<void> | null = null
  private release: (() => void) | null = null
  failOnce(): void {
    this.failNext = true
  }
  /** Hold every mint open until `let()` is called — to interleave two admits. */
  block(): void {
    this.gate = new Promise<void>((resolve) => {
      this.release = resolve
    })
  }
  let(): void {
    this.release?.()
    this.gate = null
  }
  async mint(input: { identity: SessionIdentity; template: ResolvedTemplate }): Promise<string> {
    if (this.failNext) {
      this.failNext = false
      throw new Error('mint failed')
    }
    if (this.gate) await this.gate
    this.minted.push({ sessionId: input.identity.sessionId, version: input.template.version })
    return `ws-${input.identity.sessionId}`
  }
}

class FakeRoute {
  present = true
  conductorOf(workspaceId: string): string | null {
    return this.present ? `orch-${workspaceId}` : null
  }
}

// Shares one order log so a test can assert cut-happened-before-cleanup.
class FakeEnder {
  readonly order: string[] = []
  stopped = 2
  cut(sessionId: string): number {
    this.order.push(`cut:${sessionId}`)
    return this.stopped
  }
  cleanup(input: { workspaceId: string; sessionId: string }): void {
    this.order.push(`cleanup:${input.sessionId}`)
  }
}

let templates: FakeTemplates
let minter: FakeMinter
let route: FakeRoute
let ender: FakeEnder
let inst: SessionInstantiator

beforeEach(() => {
  templates = new FakeTemplates()
  minter = new FakeMinter()
  route = new FakeRoute()
  ender = new FakeEnder()
  const deps: InstantiatorDeps = { templates, minter, route, ender }
  inst = new SessionInstantiator(deps)
})

describe('admit — first call mints, second reuses', () => {
  it('mints on the first call and reuses on the second', async () => {
    const first = await inst.admit('svc', 'ana')
    const second = await inst.admit('svc', 'ana')
    expect(first.created).toBe(true)
    expect(second.created).toBe(false)
    expect(second.session.identity.sessionId).toBe(first.session.identity.sessionId)
    // Reuse means EXACTLY one mint — no second workspace was made.
    expect(minter.minted).toHaveLength(1)
  })

  it('gives two different accounts their own sessions and slugs', async () => {
    const ana = await inst.admit('svc', 'ana')
    const bob = await inst.admit('svc', 'bob')
    expect(ana.session.identity.sessionId).not.toBe(bob.session.identity.sessionId)
    expect(ana.session.identity.slug).not.toBe(bob.session.identity.slug)
    expect(inst.sessions()).toHaveLength(2)
  })
})

describe('concurrent first-calls join one mint (no TOCTOU)', () => {
  it('two admits for the same account before either resolves make ONE session', async () => {
    minter.block()
    const a = inst.admit('svc', 'ana')
    const b = inst.admit('svc', 'ana')
    // Both are now past the "is there an open session" check with none open.
    minter.let()
    const [first, second] = await Promise.all([a, b])
    // Exactly one workspace was minted, both calls got the same session, and
    // exactly one of them reports it created it.
    expect(minter.minted).toHaveLength(1)
    expect(first.session.identity.sessionId).toBe(second.session.identity.sessionId)
    expect([first.created, second.created].filter(Boolean)).toHaveLength(1)
    expect(inst.sessions()).toHaveLength(1)
  })

  it('two startNew before either resolves take DISTINCT ordinals', async () => {
    minter.block()
    const a = inst.startNew('svc', 'ana')
    const b = inst.startNew('svc', 'ana')
    minter.let()
    const [one, two] = await Promise.all([a, b])
    expect(new Set([one.ordinal, two.ordinal]).size).toBe(2)
    expect(inst.sessions()).toHaveLength(2)
  })
})

describe('reuse targets the newest open session, and END never strands another', () => {
  it('after startNew, a bare admit lands on the newer session', async () => {
    await inst.admit('svc', 'ana') // ana-1
    const ana2 = await inst.startNew('svc', 'ana') // ana-2
    const reuse = await inst.admit('svc', 'ana')
    expect(reuse.created).toBe(false)
    expect(reuse.session.ordinal).toBe(2)
    expect(reuse.session.identity.sessionId).toBe(ana2.identity.sessionId)
  })

  it('ending the newer session falls back to reusing the older OPEN one, not a fresh mint', async () => {
    const ana1 = await inst.admit('svc', 'ana')
    const ana2 = await inst.startNew('svc', 'ana')
    inst.end(ana2.identity.sessionId)
    const reuse = await inst.admit('svc', 'ana')
    // ana-1 is still open, so it is reused — not orphaned into a new ana-3.
    expect(reuse.created).toBe(false)
    expect(reuse.session.identity.sessionId).toBe(ana1.session.identity.sessionId)
    expect(inst.sessions()).toHaveLength(1)
  })
})

describe('the pair key cannot alias two different accounts (opaque ids)', () => {
  it('keeps distinct opaque accounts on distinct sessions and ledgers', async () => {
    // Real ids are opaque and already safe; the ledger key is JSON-structured
    // rather than a space-join, so no pair can alias another's ordinal ledger.
    const acc1 = await inst.admit('svc', 'acct_9f2')
    const acc2 = await inst.admit('svc', 'acct_1ab')
    expect(acc1.session.identity.sessionId).not.toBe(acc2.session.identity.sessionId)
    expect(minter.minted).toHaveLength(2)
    expect(inst.sessions()).toHaveLength(2)
    // And a second call from each reuses, so the ledgers did not cross.
    expect((await inst.admit('svc', 'acct_9f2')).created).toBe(false)
    expect((await inst.admit('svc', 'acct_1ab')).created).toBe(false)
    expect(minter.minted).toHaveLength(2)
  })
})

describe('the pin is resolved once, at mint', () => {
  it('keeps a running session on its version while a new one gets the latest', async () => {
    const ana1 = await inst.admit('svc', 'ana')
    expect(ana1.session.version).toBe(1)

    // The author cuts V2 after ana-1 is already running.
    templates.bumpTo(2, 'sha256:v2')

    // A reuse must NOT re-read the template — ana-1 stays on V1.
    const reused = await inst.admit('svc', 'ana')
    expect(reused.session.version).toBe(1)
    expect(reused.session.pinAddress).toBe('sha256:v1')

    // An explicit new session gets V2 — ana-1 on V1 and ana-2 on V2, at once.
    const ana2 = await inst.startNew('svc', 'ana')
    expect(ana2.version).toBe(2)
    expect(ana2.ordinal).toBe(2)
  })
})

describe('ordinals are never reused, because END destroys sandboxes', () => {
  it('bumps past an ended session rather than resurrecting its path', async () => {
    const ana1 = await inst.admit('svc', 'ana')
    expect(ana1.session.ordinal).toBe(1)
    inst.end(ana1.session.identity.sessionId)

    // A fresh session for the same account must not be ana-1 again — that path
    // was just deleted. It is ana-2.
    const ana2 = await inst.admit('svc', 'ana')
    expect(ana2.created).toBe(true)
    expect(ana2.session.ordinal).toBe(2)
  })
})

describe('END — cuts in-flight first, then cleans up (design S4)', () => {
  it('cuts BEFORE cleanup, so a stop is never a crash', async () => {
    const ana = await inst.admit('svc', 'ana')
    const id = ana.session.identity.sessionId
    const { stopped } = inst.end(id)
    expect(stopped).toBe(2)
    // The order is load-bearing: cut the running agent, THEN remove its sandbox.
    expect(ender.order).toEqual([`cut:${id}`, `cleanup:${id}`])
  })

  it('drops the session from the table so a concurrent admit mints afresh', async () => {
    const ana = await inst.admit('svc', 'ana')
    inst.end(ana.session.identity.sessionId)
    expect(inst.sessions()).toHaveLength(0)
    const again = await inst.admit('svc', 'ana')
    expect(again.created).toBe(true)
  })

  it('is idempotent — ending an unknown or already-ended session stops nothing', () => {
    expect(inst.end('svc-nobody-1')).toEqual({ stopped: 0 })
  })

  it('a second END on the same session is a no-op, not a double cut', async () => {
    const ana = await inst.admit('svc', 'ana')
    const id = ana.session.identity.sessionId
    inst.end(id)
    ender.order.length = 0
    expect(inst.end(id)).toEqual({ stopped: 0 })
    expect(ender.order).toEqual([]) // nothing cut the second time
  })
})

describe('a failed mint burns nothing', () => {
  it('consumes no ordinal, so a retry reuses the same clean one', async () => {
    minter.failOnce()
    await expect(inst.admit('svc', 'ana')).rejects.toThrow('mint failed')
    // No session was recorded, and the next attempt is still ordinal 1.
    expect(inst.sessions()).toHaveLength(0)
    const retry = await inst.admit('svc', 'ana')
    expect(retry.session.ordinal).toBe(1)
    expect(minter.minted).toHaveLength(1)
  })
})

describe('conductorFor — only the orch answers (design S5)', () => {
  it('routes an open session to its conductor', async () => {
    const ana = await inst.admit('svc', 'ana')
    expect(inst.conductorFor(ana.session.identity.sessionId)).toBe(
      `orch-${ana.session.workspaceId}`
    )
  })

  it('is null for an unknown or ended session', async () => {
    const ana = await inst.admit('svc', 'ana')
    inst.end(ana.session.identity.sessionId)
    expect(inst.conductorFor(ana.session.identity.sessionId)).toBeNull()
    expect(inst.conductorFor('svc-nobody-9')).toBeNull()
  })

  it('is null when the workspace has no conductor', async () => {
    route.present = false
    const ana = await inst.admit('svc', 'ana')
    expect(inst.conductorFor(ana.session.identity.sessionId)).toBeNull()
  })
})
