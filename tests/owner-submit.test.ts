// Sol r7 P0-2 — ONE submit primitive, and every producer routed through it.
//
// The r6 lease was consulted by two producer classes (askTerminal and the
// dispatch legs); raw CLI input, mobile /input and /raw, routines and fork
// injection still wrote straight through PtySession.write, splitting their
// paste and Enter across an unguarded window. `ownerSubmit` is the missing
// door: it classifies bytes with the tracker's own feedPromptBuffer model,
// acquires the lease as one owner holder for submit-capable sequences, holds
// it across the multi-write paste+CR, and returns an explicit verdict — a
// refusal is an answer, never a silent byte drop.
//
// Also pinned here: the r7 P0-1 contamination marking inside pasteAndSubmit
// (a paste whose CR was cancelled strands the prompt in the shared input
// box), and its generation scoping (a retire that raced the cancellation
// must not stain the reborn terminal).

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import type http from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ownerSubmit, pasteAndSubmit } from '../src/main/ask'
import {
  ProducerLease,
  defaultProducerLease,
  ownerHolder,
  type ProducerHolder
} from '../src/main/producer-lease'
import { injectWhenReady } from '../src/main/fork'
import { RoutineScheduler } from '../src/main/routines'
import { handleMobileApi, type MobileApiDeps } from '../src/main/mobile-api'
import type { PtySession } from '../src/main/pty'
import type { RoutineSpec } from '../src/shared/model'
import type { WorkspaceStore } from '../src/main/store'
import type { PtyManager } from '../src/main/pty'

const paste = (body: string): string => `\x1b[200~${body}\x1b[201~`
const dispatchHolder = (dispatchId: string): ProducerHolder => ({ kind: 'dispatch', dispatchId })

interface Fake {
  session: PtySession
  /** Untagged writes — the guarded PtySession.write path. */
  writes: string[]
  /** Tagged owner writes — the primitive's own delivery path. */
  owned: string[]
}

function fakeSession(terminalId: string, over: Record<string, unknown> = {}): Fake {
  const writes: string[] = []
  const owned: string[] = []
  const session = {
    terminalId,
    idleFor: () => 99_999,
    viewportText: () => '',
    fullText: () => '',
    write: (data: string) => {
      writes.push(data)
      return 'allow' as const
    },
    writeFromOwner: (data: string) => {
      owned.push(data)
    },
    ...over
  } as unknown as PtySession
  return { session, writes, owned }
}

describe('ownerSubmit — classification and delivery', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('a body + Enter is delivered as paste + delayed CR through the TAGGED path only', async () => {
    vi.useFakeTimers()
    const lease = new ProducerLease()
    const { session, writes, owned } = fakeSession('os-1')
    const promise = ownerSubmit(session, 'fix the bug\r', { lease })
    // The paste went out tagged; nothing crossed the guarded write.
    expect(owned).toEqual([paste('fix the bug')])
    expect(writes).toEqual([])
    // The lease is HELD across the delay — the exact window competing
    // producers used to slip into.
    expect(lease.holderOf('os-1')?.kind).toBe('owner')
    await vi.advanceTimersByTimeAsync(2000)
    await expect(promise).resolves.toEqual({ ok: true, submitted: true })
    expect(owned).toEqual([paste('fix the bug'), '\r'])
    expect(lease.holderOf('os-1')).toBeNull()
  })

  it('a bare Enter is one synchronous tagged write — acquire, submit, release, no async window', async () => {
    const lease = new ProducerLease()
    const { session, writes, owned } = fakeSession('os-2')
    await expect(ownerSubmit(session, '\r', { lease })).resolves.toEqual({
      ok: true,
      submitted: true
    })
    expect(owned).toEqual(['\r'])
    expect(writes).toEqual([])
    expect(lease.holderOf('os-2')).toBeNull()
  })

  it('non-submitting bytes go through the ordinary guarded write and report ok', async () => {
    const lease = new ProducerLease()
    const { session, writes, owned } = fakeSession('os-3')
    await expect(ownerSubmit(session, '\x1b[A', { lease })).resolves.toEqual({
      ok: true,
      submitted: false
    })
    await expect(ownerSubmit(session, 'typing without enter', { lease })).resolves.toEqual({
      ok: true,
      submitted: false
    })
    expect(writes).toEqual(['\x1b[A', 'typing without enter'])
    expect(owned).toEqual([])
  })

  it("a refused guarded write surfaces the refusal — never a silent drop", async () => {
    const lease = new ProducerLease()
    const { session } = fakeSession('os-4', {
      write: () => 'refused' as const
    })
    const verdict = await ownerSubmit(session, 'typing', { lease })
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.reason).toContain('submission window')
  })

  it('consults the armed-dispatch guard with the FULL submitting bytes before any write', async () => {
    vi.useFakeTimers()
    const lease = new ProducerLease()
    const events: string[] = []
    const { session } = fakeSession('os-5', {
      beforeOwnerInput: (terminalId: string, data: string) => {
        events.push(`guard:${terminalId}:${JSON.stringify(data)}`)
        return 'allow' as const
      },
      writeFromOwner: (data: string) => events.push(`write:${JSON.stringify(data)}`)
    })
    const promise = ownerSubmit(session, 'take over\r', { lease })
    await vi.advanceTimersByTimeAsync(2000)
    await promise
    expect(events).toEqual([
      'guard:os-5:"take over\\r"',
      `write:${JSON.stringify(paste('take over'))}`,
      'write:"\\r"'
    ])
  })
})

describe('ownerSubmit — the refusal matrix', () => {
  it('dispatch-held: refused by name, nothing written (Sol r7 P0-1)', async () => {
    const lease = new ProducerLease()
    lease.acquire('os-6', dispatchHolder('dsp-1'))
    const { session, writes, owned } = fakeSession('os-6')
    await expect(ownerSubmit(session, 'my ask\r', { lease })).resolves.toEqual({
      ok: false,
      reason: 'a dispatch is being delivered — retry in a moment'
    })
    expect(writes).toEqual([])
    expect(owned).toEqual([])
  })

  it('owner-held: refused honestly', async () => {
    const lease = new ProducerLease()
    lease.acquire('os-7', ownerHolder())
    const { session, owned } = fakeSession('os-7')
    await expect(ownerSubmit(session, 'second ask\r', { lease })).resolves.toEqual({
      ok: false,
      reason: 'another owner submission is in flight'
    })
    expect(owned).toEqual([])
  })

  it('contaminated: submits refuse until the box is cleared; typing still passes', async () => {
    const lease = new ProducerLease()
    lease.markContaminated('os-8')
    const { session, writes, owned } = fakeSession('os-8')
    const refused = await ownerSubmit(session, 'fresh work\r', { lease })
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.reason).toContain('cancelled delivery')
    expect(owned).toEqual([])
    // The owner's clearing keys are non-submitting and must pass.
    await expect(ownerSubmit(session, '\x15', { lease })).resolves.toEqual({
      ok: true,
      submitted: false
    })
    expect(writes).toEqual(['\x15'])
  })

  it('a failed armed-dispatch preemption refuses and leaves the window free', async () => {
    const lease = new ProducerLease()
    const { session, owned } = fakeSession('os-9', {
      beforeOwnerInput: () => 'preempt-failed' as const
    })
    await expect(ownerSubmit(session, 'my ask\r', { lease })).resolves.toEqual({
      ok: false,
      reason: 'agent has a dispatch in flight that could not be preempted'
    })
    expect(owned).toEqual([])
    expect(lease.holderOf('os-9')).toBeNull()
  })

  it('retirement inside the paste delay withholds the CR and reports the cancellation', async () => {
    vi.useFakeTimers()
    const lease = new ProducerLease()
    const { session, owned } = fakeSession('os-10')
    const promise = ownerSubmit(session, 'doomed prompt\r', { lease })
    expect(owned).toEqual([paste('doomed prompt')])
    lease.retire('os-10')
    await vi.advanceTimersByTimeAsync(2000)
    const verdict = await promise
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.reason).toContain('cancelled mid-delivery')
    // No CR — and no contamination either: the residue went into a RETIRED
    // process's input box, and the mark is generation-checked.
    expect(owned).toEqual([paste('doomed prompt')])
    expect(lease.isContaminated('os-10')).toBe(false)
  })
})

describe('pasteAndSubmit — contamination marking (Sol r7 P0-1)', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('a cancellation AFTER the paste marks the terminal contaminated', async () => {
    vi.useFakeTimers()
    const lease = new ProducerLease()
    const { session, owned } = fakeSession('pc-1')
    let valid = true
    const promise = pasteAndSubmit(
      session,
      'the brief',
      (data) => session.writeFromOwner(data),
      () => valid,
      lease
    )
    expect(owned).toEqual([paste('the brief')])
    valid = false
    await vi.advanceTimersByTimeAsync(2000)
    await expect(promise).resolves.toBe('cancelled')
    expect(lease.isContaminated('pc-1')).toBe(true)
  })

  it('a cancellation BEFORE any write leaves the terminal clean', async () => {
    const lease = new ProducerLease()
    const { session, owned } = fakeSession('pc-2')
    await expect(
      pasteAndSubmit(session, 'the brief', (data) => session.writeFromOwner(data), () => false, lease)
    ).resolves.toBe('cancelled')
    expect(owned).toEqual([])
    expect(lease.isContaminated('pc-2')).toBe(false)
  })

  it('a completed submission leaves the terminal clean', async () => {
    vi.useFakeTimers()
    const lease = new ProducerLease()
    const { session } = fakeSession('pc-3')
    const promise = pasteAndSubmit(
      session,
      'the brief',
      (data) => session.writeFromOwner(data),
      () => true,
      lease
    )
    await vi.advanceTimersByTimeAsync(2000)
    await expect(promise).resolves.toBe('submitted')
    expect(lease.isContaminated('pc-3')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Every producer routed (Sol r7 P0-2). Functional where the producer is
// callable in isolation; structural (source-pinned, per the repo's
// dispatch-route precedent) where the handler is module-private.
// ---------------------------------------------------------------------------

describe('routines submit through the primitive', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('fire() delivers command + Enter as one leased paste, never bare writes', async () => {
    vi.useFakeTimers()
    const { session, writes, owned } = fakeSession('rt-1')
    const store = { terminals: () => [{ id: 'rt-1' }] } as unknown as WorkspaceStore
    const ptys = { get: () => session } as unknown as PtyManager
    const scheduler = new RoutineScheduler(store, ptys)
    const spec: RoutineSpec = {
      id: 'r-1',
      name: 'demo',
      command: 'cookrew status',
      schedule: { type: 'every', ms: 60_000 },
      terminalId: 'rt-1',
      enabled: true,
      fireCount: 0
    }
    // Injected directly: create() persists to the user's real routines file,
    // which a test must never touch.
    ;(scheduler as unknown as { routines: { spec: RoutineSpec; nextFireAt: number }[] }).routines =
      [{ spec, nextFireAt: 0 }]
    scheduler.run('demo')
    await vi.advanceTimersByTimeAsync(2000)
    expect(owned).toEqual([paste('cookrew status'), '\r'])
    expect(writes).toEqual([])
  })
})

describe('fork injection submits through the primitive', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('injectWhenReady waits for boot, then delivers the preamble as one leased paste', async () => {
    vi.useFakeTimers()
    const { session, writes, owned } = fakeSession('fk-1')
    const preamble = 'You are a fork.\nContext line two.'
    const promise = injectWhenReady(session, preamble)
    // Boot poll (300ms) sees the quiet TUI, then the paste and delayed CR.
    await vi.advanceTimersByTimeAsync(5000)
    await promise
    expect(owned).toEqual([paste(preamble), '\r'])
    expect(writes).toEqual([])
  })
})

describe('mobile /raw submits through the primitive', () => {
  const TOKEN = 'pairing-token-123'

  function rawRequest(body: string): http.IncomingMessage {
    const request = Readable.from([body]) as http.IncomingMessage
    request.method = 'POST'
    request.headers = { authorization: `Bearer ${TOKEN}` }
    return request
  }

  function rawResponse(): {
    response: http.ServerResponse
    captured: { status: number; body: unknown }
  } {
    const captured: { status: number; body: unknown } = { status: 0, body: undefined }
    const response = {
      writeHead(status: number) {
        captured.status = status
        return this
      },
      end(raw?: string) {
        captured.body = raw ? JSON.parse(raw) : undefined
      }
    } as unknown as http.ServerResponse
    return { response, captured }
  }

  it('delivers prompt + Enter leased and tagged, and answers 200', async () => {
    const { session, writes, owned } = fakeSession('raw-1')
    const deps = {
      pairingToken: TOKEN,
      ptys: { get: (id: string) => (id === 'raw-1' ? session : undefined) }
    } as unknown as MobileApiDeps
    const { response, captured } = rawResponse()
    const handled = await handleMobileApi(
      rawRequest(JSON.stringify({ data: 'hello agent\r' })),
      response,
      new URL('/api/terminal/raw-1/raw', 'http://lan.local'),
      deps
    )
    expect(handled).toBe(true)
    expect(captured.status).toBe(200)
    expect(owned).toEqual([paste('hello agent'), '\r'])
    expect(writes).toEqual([])
  })

  it('answers 409 with the named refusal while a dispatch delivery holds the window', async () => {
    // /raw uses the process-wide default lease — hold it as a dispatch the
    // way a live delivery leg would, and release in a finally.
    const lease = defaultProducerLease()
    const holder = dispatchHolder('dsp-raw')
    lease.acquire('raw-2', holder)
    try {
      const { session, owned } = fakeSession('raw-2')
      const deps = {
        pairingToken: TOKEN,
        ptys: { get: () => session }
      } as unknown as MobileApiDeps
      const { response, captured } = rawResponse()
      await handleMobileApi(
        rawRequest(JSON.stringify({ data: 'hello agent\r' })),
        response,
        new URL('/api/terminal/raw-2/raw', 'http://lan.local'),
        deps
      )
      expect(captured.status).toBe(409)
      expect(captured.body).toMatchObject({
        error: 'a dispatch is being delivered — retry in a moment'
      })
      expect(owned).toEqual([])
    } finally {
      lease.release('raw-2', holder)
    }
  })
})

describe('the remaining producers are structurally routed (source pins)', () => {
  const read = (file: string): string =>
    readFileSync(path.join(__dirname, '..', 'src', 'main', file), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')

  it('mobile /input submits through ownerSubmit, never bare session.write pairs', () => {
    // The handler is module-private in mobile-server.ts; pin the source the
    // way dispatch-route pins index.ts's fallback wiring.
    const source = read('mobile-server.ts')
    const handler = /inputMatch\[2\] === 'input'[\s\S]*?\n    \}/.exec(source)?.[0] ?? ''
    expect(handler).toContain('ownerSubmit')
    expect(handler).not.toContain('session.write(')
  })

  it('routines and fork no longer call session.write at all', () => {
    for (const file of ['routines.ts', 'fork.ts']) {
      const source = read(file)
      expect(source).toContain('ownerSubmit')
      expect(source).not.toContain('session.write(')
    }
  })

  // Windows: the source-slice regex anchors on LF; CRLF line endings on NTFS defeat the match — macOS/Linux CI covers it.
  it.skipIf(process.platform === 'win32')('mobile /raw routes through ownerSubmit', () => {
    const source = read('mobile-api.ts')
    const handler = /ptyMatch\[2\] === "raw"[\s\S]*?return true;\n\s*\}/.exec(source)?.[0] ?? ''
    expect(handler).toContain('ownerSubmit')
    expect(handler).not.toContain('session.write(')
  })
})
