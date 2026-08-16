// Acceptance, durability, replay and death (Sol P0s 3–4, P1s 5–7).
//
// The themes, in order:
// - an acceptance must be OBSERVABLE (beginWork can now say no) — never a pin
//   with no watch that only the ten-minute sweep would close;
// - the submitted row must be ON DISK before the prompt goes out, and a
//   ledger that cannot record work refuses it;
// - a replay outranks every refusal — 404 and 400 included — and a pruned
//   key leaves a tombstone instead of silently becoming new work;
// - a dead backend interrupts open dispatches, it does not strand or fail
//   them;
// - the consumer principal comes from the route's auth, never the body, and
//   a foreign principal's id reads as nonexistent.

import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import type http from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { handleMobileApi, type MobileApiDeps } from '../src/main/mobile-api'
import {
  DispatchService,
  appendDispatchRecord,
  appendDispatchTombstone,
  promptFingerprint,
  readDispatchRecords,
  readDispatchTombstones,
  type DispatchDeps,
  type DispatchRecord,
  type DispatchTombstone
} from '../src/main/dispatch'

const PROMPT = 'Run the F2 simulation and report the counts.'
const NOW = 1_700_000_000_000
const DAY = 24 * 60 * 60 * 1000

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
// Fix 3 — acceptance must be observable or refused.
// ---------------------------------------------------------------------------

describe('beginWork can refuse: never a pin with no watch', () => {
  it('503s when no durable observer exists, and leaves NO half-state', async () => {
    const cleared: string[] = []
    const persisted: DispatchRecord[] = []
    let ends = 0
    let observable = false
    const service = new DispatchService(
      deps({
        beginWork: () => observable,
        endWork: () => {
          ends += 1
        },
        clearDispatch: (_agentId, dispatchId) => cleared.push(dispatchId),
        persist: (record) => {
          persisted.push(record)
          return true
        }
      })
    )
    const refused = await service.dispatch('agent-1', { text: PROMPT })
    expect(refused.status).toBe(503)
    expect(refused.body).toMatchObject({ error: 'agent has no durable observer' })
    // Complete rollback: no row, disarmed stamp, and no endWork — a false
    // beginWork promises it left nothing behind itself.
    expect(persisted).toEqual([])
    expect(cleared).toEqual(['dsp-1'])
    expect(ends).toBe(0)
    expect(service.get('dsp-1')).toBeUndefined()

    // The reservation was released too: the agent is dispatchable the moment
    // an observer CAN be installed, not answering 409 to a ghost.
    observable = true
    const accepted = await dispatchAndSettle(service)
    expect(accepted.status).toBe(202)
  })
})

// ---------------------------------------------------------------------------
// Fix 4 — fail-open durability.
// ---------------------------------------------------------------------------

describe('the ledger is consulted before work, not after', () => {
  afterEach(() => vi.restoreAllMocks())

  it('refuses 503 and rolls back fully when the accept append fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const cleared: string[] = []
    let ends = 0
    let prompts = 0
    const service = new DispatchService(
      deps({
        persist: () => false,
        promptAgent: async () => {
          prompts += 1
          return 'done'
        },
        endWork: () => {
          ends += 1
        },
        clearDispatch: (_agentId, dispatchId) => cleared.push(dispatchId)
      })
    )
    const refused = await service.dispatch('agent-1', { text: PROMPT })
    expect(refused.status).toBe(503)
    expect(refused.body).toMatchObject({ error: 'dispatch ledger unavailable' })
    // Delivery NEVER fired: an unrecorded prompt is work a replayed key would
    // happily run a second time.
    expect(prompts).toBe(0)
    // beginWork had run, so endWork unwinds it — exactly once.
    expect(ends).toBe(1)
    expect(cleared).toEqual(['dsp-1'])
    expect(service.get('dsp-1')).toBeUndefined()
    // And the agent is free: the failure closed cleanly.
    const next = await service.dispatch('agent-1', { text: PROMPT })
    expect(next.status).toBe(503) // persist still down — refused again, not busy
  })

  it('a throwing persist is a failing persist', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const service = new DispatchService(
      deps({
        persist: () => {
          throw new Error('disk full')
        }
      })
    )
    const refused = await service.dispatch('agent-1', { text: PROMPT })
    expect(refused.status).toBe(503)
    expect(refused.body).toMatchObject({ error: 'dispatch ledger unavailable' })
  })

  it('a NON-terminal transition append failure retries once, then reports the id loudly', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    let appends = 0
    const service = new DispatchService(
      deps({
        // The accept append succeeds; every transition append fails.
        persist: () => {
          appends += 1
          return appends === 1
        }
      })
    )
    await dispatchAndSettle(service)
    // `running` is an observation, not a settlement: memory advances and the
    // fault is loud, naming the dispatch. (Terminal transitions fail CLOSED —
    // the suite below.)
    expect(service.get('dsp-1')?.state).toBe('running')
    expect(appends).toBe(3) // accept + transition + its one retry
    const said = error.mock.calls.map((call) => String(call[0])).join('\n')
    expect(said).toContain('dsp-1')
  })

  it('a TERMINAL transition is durable before it is visible or releases (fail closed)', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    let ends = 0
    let ledgerUp = true
    let n = 0
    const service = new DispatchService(
      deps({
        newId: () => `dsp-${(n += 1)}`,
        persist: () => ledgerUp,
        endWork: () => {
          ends += 1
        }
      })
    )
    await dispatchAndSettle(service)
    expect(service.get('dsp-1')?.state).toBe('running')

    ledgerUp = false
    service.completeTurn('dsp-1', { turnIndex: 3, reply: 'answered' })
    // The done row never landed, so `done` does not exist anywhere a caller
    // can observe: GET reports the current OPEN state, marked with the fault.
    expect(service.get('dsp-1')?.state).toBe('running')
    expect(service.lookup('dsp-1').body).toMatchObject({ state: 'running', ledgerFault: true })
    // Nothing released: not the pin, not the agent's slot.
    expect(ends).toBe(0)
    expect((await service.dispatch('agent-1', { text: 'a second brief' })).status).toBe(409)
    expect(error.mock.calls.map((call) => String(call[0])).join('\n')).toContain('dsp-1')

    // A sweep while the ledger is still down retries, fails, changes nothing —
    // and does NOT re-interrupt a record whose outcome is already decided.
    expect(service.sweep()).toEqual([])
    expect(service.get('dsp-1')?.state).toBe('running')
    expect(ends).toBe(0)

    // The pass after the ledger recovers lands the row, then — and only
    // then — the terminal state becomes visible and the release fires once.
    ledgerUp = true
    service.sweep()
    expect(service.get('dsp-1')).toMatchObject({ state: 'done', turnIndex: 3 })
    expect(service.get('dsp-1')?.ledgerFault).toBeUndefined()
    expect(ends).toBe(1)
    const next = await service.dispatch('agent-1', { text: 'a second brief' })
    expect(next.status).toBe(202)
    await service.settled(String((next.body as { dispatchId: string }).dispatchId))
  })

  it('a parked done outranks a later infrastructure interrupt (Sol r3 P0-3)', async () => {
    // The evidence lattice: parser-proven done > failed > interrupted. The
    // done append fails and parks; the backend then dies. The retried row
    // must be the done — recovery must never persist the weaker verdict over
    // the stronger unpersisted fact.
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    let ends = 0
    let ledgerUp = true
    const service = new DispatchService(
      deps({
        persist: () => ledgerUp,
        endWork: () => {
          ends += 1
        }
      })
    )
    await dispatchAndSettle(service)
    ledgerUp = false
    service.completeTurn('dsp-1', { turnIndex: 3, reply: 'proven done' })
    expect(service.get('dsp-1')?.state).toBe('running') // parked, fail-closed
    service.onBackendDeath('herdr server died')
    expect(service.get('dsp-1')?.state).toBe('running') // done still parked
    ledgerUp = true
    service.sweep()
    expect(service.get('dsp-1')).toMatchObject({ state: 'done', turnIndex: 3 })
    expect(ends).toBe(1)
  })

  it('the weaker verdict is discarded even when the ledger recovered first', async () => {
    // The sharper race: done parks while the ledger is down, the ledger
    // recovers, THEN the death event arrives. Without the lattice gate the
    // interrupted append would now succeed and land the wrong outcome.
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    let ledgerUp = true
    const service = new DispatchService(deps({ persist: () => ledgerUp }))
    await dispatchAndSettle(service)
    ledgerUp = false
    service.completeTurn('dsp-1', { turnIndex: 3, reply: 'proven done' })
    ledgerUp = true
    service.onBackendDeath('herdr server died')
    // The interrupt was refused before any append; the sweep lands the done.
    service.sweep()
    expect(service.get('dsp-1')).toMatchObject({ state: 'done', turnIndex: 3 })
  })

  it('a STRONGER transition replaces a parked ledger fault — lattice up, one release', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    let ends = 0
    let ledgerUp = true
    const service = new DispatchService(
      deps({
        persist: () => ledgerUp,
        endWork: () => {
          ends += 1
        }
      })
    )
    await dispatchAndSettle(service)
    ledgerUp = false
    service.interrupt('dsp-1', 'first verdict, never durable')
    expect(service.get('dsp-1')?.state).toBe('running')
    // The turn actually completes while the interrupt is still parked: done
    // outranks interrupted on the evidence lattice and replaces the intent.
    service.completeTurn('dsp-1', { turnIndex: 5, reply: 'made it after all' })
    ledgerUp = true
    service.sweep()
    expect(service.get('dsp-1')).toMatchObject({ state: 'done', turnIndex: 5 })
    expect(ends).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Sol r3 P0-4 — a fail-closed restart fault keeps its agent reserved.
// ---------------------------------------------------------------------------

describe('hydration reserves every loaded open record (Sol r3 P0-4)', () => {
  afterEach(() => vi.restoreAllMocks())

  const openRow: DispatchRecord = {
    id: 'dsp-open',
    agentId: 'agent-1',
    agentName: 'Forge',
    workspaceId: 'ws-1',
    state: 'running',
    via: 'herdr',
    createdAt: NOW - 60_000,
    updatedAt: NOW - 60_000
  }

  it('restart with the ledger down → a second dispatch on that agent is 409 busy', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    let ledgerUp = false
    const service = new DispatchService(
      deps({
        loadRecords: () => [openRow],
        persist: () => ledgerUp,
        newId: () => 'dsp-new'
      })
    )
    // The restart interrupt could not land: fail closed — the record stays
    // open with its ledger fault, and the reservation holds with it. New
    // work must not be admitted beside an unresolved commercial record.
    expect(service.get('dsp-open')?.state).toBe('running')
    const refused = await service.dispatch('agent-1', { text: PROMPT })
    expect(refused.status).toBe(409)
    expect(refused.body).toMatchObject({ error: 'busy', dispatchId: 'dsp-open' })

    // The ledger recovers; the sweep lands the interrupt, and only THEN is
    // the agent dispatchable again.
    ledgerUp = true
    service.sweep()
    expect(service.get('dsp-open')?.state).toBe('interrupted')
    const accepted = await service.dispatch('agent-1', { text: PROMPT })
    expect(accepted.status).toBe(202)
    await service.settled('dsp-new')
  })

  it('a clean restart still releases the reservation the moment the row lands', async () => {
    const service = new DispatchService(deps({ loadRecords: () => [openRow] }))
    expect(service.get('dsp-open')?.state).toBe('interrupted')
    const accepted = await service.dispatch('agent-1', { text: PROMPT })
    expect(accepted.status).toBe(202)
    await service.settled('dsp-1')
  })
})

// ---------------------------------------------------------------------------
// Sol r3 P0-5 — consumer settlement requires the native-file observer grade.
// ---------------------------------------------------------------------------

describe('consumer dispatch needs native file finality (Sol r3 P0-5)', () => {
  it('refuses a consumer on scrape grade with a complete rollback', async () => {
    const cleared: string[] = []
    const persisted: DispatchRecord[] = []
    let ends = 0
    const service = new DispatchService(
      deps({
        beginWork: () => 'scrape',
        endWork: () => {
          ends += 1
        },
        clearDispatch: (_agentId, dispatchId) => cleared.push(dispatchId),
        persist: (record) => {
          persisted.push(record)
          return true
        }
      })
    )
    const refused = await service.dispatch('agent-1', { text: PROMPT, consumer: 'tenant-a' })
    expect(refused.status).toBe(503)
    expect(refused.body).toMatchObject({ error: 'consumer dispatch needs native file finality' })
    // Refused BEFORE any row exists, and beginWork's effects are unwound.
    expect(persisted).toEqual([])
    expect(cleared).toEqual(['dsp-1'])
    expect(ends).toBe(1)
    expect(service.get('dsp-1')).toBeUndefined()

    // The owner is still served on scrape grade — the person at the keyboard
    // can accept screen-quiescence evidence for their own work.
    const owner = await dispatchAndSettle(service)
    expect(owner.status).toBe(202)
  })

  it('accepts a consumer on the native-file grade', async () => {
    const service = new DispatchService(deps({ beginWork: () => 'native-file' }))
    const accepted = await dispatchAndSettle(service, 'agent-1', {
      text: PROMPT,
      consumer: 'tenant-a'
    })
    expect(accepted.status).toBe(202)
  })

  it('treats a legacy boolean beginWork as scrape — fail closed for consumers', async () => {
    // Until every wiring reports its grade, `true` cannot be trusted to mean
    // durable native finality. Owners proceed; consumers are refused.
    const service = new DispatchService(deps({ beginWork: () => true }))
    const refused = await service.dispatch('agent-1', { text: PROMPT, consumer: 'tenant-a' })
    expect(refused.status).toBe(503)
    const owner = await dispatchAndSettle(service)
    expect(owner.status).toBe(202)
  })

  it('the explicit owner principal is served on scrape grade', async () => {
    const service = new DispatchService(deps({ beginWork: () => 'scrape' }))
    const accepted = await dispatchAndSettle(service, 'agent-1', {
      text: PROMPT,
      consumer: 'owner'
    })
    expect(accepted.status).toBe(202)
  })
})

// ---------------------------------------------------------------------------
// Sol r3 P1-7 / P1-8 — parser outcomes map to terminal states; empty finals
// close honestly.
// ---------------------------------------------------------------------------

describe('completeTurn maps the parser outcome (Sol r3 P1-7, P1-8)', () => {
  it('outcome failed → state failed with reason "agent aborted/errored"', async () => {
    const service = new DispatchService(deps())
    await dispatchAndSettle(service)
    service.completeTurn('dsp-1', { turnIndex: 4, outcome: 'failed', reply: 'partial output' })
    expect(service.get('dsp-1')).toMatchObject({
      state: 'failed',
      turnIndex: 4,
      error: 'agent aborted/errored'
    })
  })

  it('outcome interrupted → state interrupted', async () => {
    const service = new DispatchService(deps())
    await dispatchAndSettle(service)
    service.completeTurn('dsp-1', { turnIndex: 4, outcome: 'interrupted' })
    expect(service.get('dsp-1')).toMatchObject({ state: 'interrupted', turnIndex: 4 })
  })

  it('absent outcome closes done — tolerant until the parser lane lands', async () => {
    const service = new DispatchService(deps())
    await dispatchAndSettle(service)
    service.completeTurn('dsp-1', { turnIndex: 4, reply: 'answered' })
    expect(service.get('dsp-1')).toMatchObject({ state: 'done', turnIndex: 4 })
  })

  it('an EMPTY reply closes done with hasReply false (tool-only final turn)', async () => {
    const service = new DispatchService(deps())
    await dispatchAndSettle(service)
    service.completeTurn('dsp-1', { turnIndex: 4, reply: '' })
    const view = service.lookup('dsp-1')
    expect(view.body).toMatchObject({ state: 'done', turnIndex: 4, hasReply: false })
  })
})

// ---------------------------------------------------------------------------
// Fix 5 — replay outranks everything; keys do not silently expire.
// ---------------------------------------------------------------------------

describe('replay outranks 404 and 400', () => {
  it('replays a key even after the agent was deleted', async () => {
    let exists = true
    const service = new DispatchService(
      deps({
        resolveAgent: (id) =>
          exists && id === 'agent-1' ? { name: 'Forge', workspaceId: 'ws-1' } : null
      })
    )
    await dispatchAndSettle(service, 'agent-1', { text: PROMPT, idempotencyKey: 'key-a' })
    service.completeTurn('dsp-1', { turnIndex: 1 })
    exists = false

    const replay = await service.dispatch('agent-1', { text: PROMPT, idempotencyKey: 'key-a' })
    expect(replay.status).toBe(200)
    expect(replay.body).toMatchObject({ dispatchId: 'dsp-1', replay: true })
    // A key nobody has seen still 404s — the replay short-circuit is not a
    // hole in agent resolution.
    expect((await service.dispatch('agent-1', { text: PROMPT, idempotencyKey: 'key-b' })).status).toBe(
      404
    )
  })

  it('replays a key even on an empty retry body', async () => {
    const service = new DispatchService(deps())
    await dispatchAndSettle(service, 'agent-1', { text: PROMPT, idempotencyKey: 'key-a' })
    const replay = await service.dispatch('agent-1', { idempotencyKey: 'key-a' })
    expect(replay.status).toBe(200)
    expect(replay.body).toMatchObject({ dispatchId: 'dsp-1', replay: true })
  })

  it('409s a key reused for DIFFERENT work (prompt fingerprint)', async () => {
    const service = new DispatchService(deps())
    await dispatchAndSettle(service, 'agent-1', { text: PROMPT, idempotencyKey: 'key-a' })
    const reused = await service.dispatch('agent-1', {
      text: 'an entirely different brief',
      idempotencyKey: 'key-a'
    })
    expect(reused.status).toBe(409)
    expect(reused.body).toMatchObject({ error: 'idempotency key reused for different work' })
    // The honest replay still works.
    const replay = await service.dispatch('agent-1', { text: PROMPT, idempotencyKey: 'key-a' })
    expect(replay.status).toBe(200)
  })
})

describe('pruned keys leave tombstones', () => {
  const closedRow = (over: Partial<DispatchRecord> = {}): DispatchRecord => ({
    id: 'dsp-old',
    agentId: 'agent-1',
    agentName: 'Forge',
    workspaceId: 'ws-1',
    state: 'done',
    via: 'herdr',
    createdAt: NOW - 30 * DAY,
    updatedAt: NOW - 30 * DAY,
    idempotencyKey: 'key-old',
    promptHash: promptFingerprint(PROMPT),
    ...over
  })

  it('prune writes a tombstone and its key still replays — honestly thin', async () => {
    const buried: DispatchTombstone[] = []
    const service = new DispatchService(
      deps({
        loadRecords: () => [closedRow()],
        persistTombstone: (tombstone) => {
          buried.push(tombstone)
          return true
        }
      })
    )
    // The record is gone (30 days > the 7-day retention)…
    expect(service.get('dsp-old')).toBeUndefined()
    expect(buried).toHaveLength(1)
    expect(buried[0]).toMatchObject({ kind: 'tombstone', dispatchId: 'dsp-old', state: 'done' })

    // …but the key's promise is not: the retry replays, and says plainly
    // that only the id and how it closed remain.
    const replay = await service.dispatch('agent-1', { text: PROMPT, idempotencyKey: 'key-old' })
    expect(replay.status).toBe(200)
    expect(replay.body).toMatchObject({
      dispatchId: 'dsp-old',
      state: 'done',
      replay: true,
      tombstone: true
    })
  })

  it('a pruned FAILED dispatch replays failed — burial never fabricates success', async () => {
    const service = new DispatchService(
      deps({
        loadRecords: () => [closedRow({ state: 'failed' })],
        persistTombstone: () => true
      })
    )
    const replay = await service.dispatch('agent-1', { text: PROMPT, idempotencyKey: 'key-old' })
    expect(replay.status).toBe(200)
    expect(replay.body).toMatchObject({ dispatchId: 'dsp-old', state: 'failed', tombstone: true })
  })

  it('a legacy stateless tombstone replays closed/unknown, never done', async () => {
    // Lines written before the state field existed cannot know the outcome —
    // and an honest "closed, outcome unknown" is the only answer that does
    // not change the result of commissioned work.
    const service = new DispatchService(
      deps({
        loadTombstones: () => [
          {
            kind: 'tombstone',
            // idempotencyScope(undefined, 'key-old') — the owner scope.
            scope: '\u0000key-old',
            dispatchId: 'dsp-old',
            promptHash: promptFingerprint(PROMPT),
            closedAt: NOW - DAY
          }
        ]
      })
    )
    const replay = await service.dispatch('agent-1', { text: PROMPT, idempotencyKey: 'key-old' })
    expect(replay.status).toBe(200)
    expect(replay.body).toMatchObject({
      dispatchId: 'dsp-old',
      state: 'closed',
      outcome: 'unknown',
      replay: true,
      tombstone: true
    })
  })

  it('retains the record when its tombstone cannot be appended — burial before deletion', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    let buriable = false
    const buried: DispatchTombstone[] = []
    const service = new DispatchService(
      deps({
        loadRecords: () => [closedRow()],
        persistTombstone: (tombstone) => {
          if (!buriable) return false
          buried.push(tombstone)
          return true
        }
      })
    )
    // Burial failed, so NOTHING was pruned: the record (the richer source the
    // tombstone is built from) still answers, and the key replays from it —
    // no tombstone marker, because no tombstone exists.
    expect(service.get('dsp-old')).toBeDefined()
    const replay = await service.dispatch('agent-1', { text: PROMPT, idempotencyKey: 'key-old' })
    expect(replay.status).toBe(200)
    expect(replay.body).toMatchObject({ dispatchId: 'dsp-old', replay: true })
    expect(replay.body.tombstone).toBeUndefined()

    // The next prune pass (sweep cadence) retries, lands the burial, and only
    // THEN deletes the source record.
    buriable = true
    service.sweep()
    expect(buried).toHaveLength(1)
    expect(buried[0]).toMatchObject({ dispatchId: 'dsp-old', state: 'done' })
    expect(service.get('dsp-old')).toBeUndefined()
  })

  it('a tombstoned key still refuses DIFFERENT work', async () => {
    const service = new DispatchService(deps({ loadRecords: () => [closedRow()] }))
    const reused = await service.dispatch('agent-1', {
      text: 'different work under the old key',
      idempotencyKey: 'key-old'
    })
    expect(reused.status).toBe(409)
    expect(reused.body).toMatchObject({ error: 'idempotency key reused for different work' })
  })

  it('tombstones survive a restart through the registry file', async () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'cookrew-dsp-')), 'dispatches.jsonl')
    const onDisk = (at: number): DispatchService =>
      new DispatchService(
        deps({
          now: () => at,
          persist: (record) => appendDispatchRecord(file, record),
          persistTombstone: (tombstone) => appendDispatchTombstone(file, tombstone),
          loadRecords: () => readDispatchRecords(file),
          loadTombstones: () => readDispatchTombstones(file)
        })
      )

    // Life 1: the work happens and closes.
    const first = onDisk(NOW - 30 * DAY)
    await dispatchAndSettle(first, 'agent-1', { text: PROMPT, idempotencyKey: 'key-a' })
    first.completeTurn('dsp-1', { turnIndex: 1 })

    // Life 2: hydration prunes the aged record and buries the key.
    const second = onDisk(NOW)
    expect(second.get('dsp-1')).toBeUndefined()
    expect(readDispatchTombstones(file)).toHaveLength(1)

    // Life 3: a fresh process replays from the tombstone alone.
    const third = onDisk(NOW)
    const replay = await third.dispatch('agent-1', { text: PROMPT, idempotencyKey: 'key-a' })
    expect(replay.status).toBe(200)
    expect(replay.body).toMatchObject({ dispatchId: 'dsp-1', replay: true, tombstone: true })
    // Record lines and tombstone lines share the file without confusion.
    expect(readDispatchRecords(file).every((row) => typeof row.id === 'string')).toBe(true)
  })

  it('repeated hydrations do not grow the file or duplicate burials (Sol r3 P1-13)', async () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'cookrew-dsp-')), 'dispatches.jsonl')
    const onDisk = (at: number): DispatchService =>
      new DispatchService(
        deps({
          now: () => at,
          persist: (record) => appendDispatchRecord(file, record),
          persistTombstone: (tombstone) => appendDispatchTombstone(file, tombstone),
          loadRecords: () => readDispatchRecords(file),
          loadTombstones: () => readDispatchTombstones(file)
        })
      )
    const lines = (): number => readFileSync(file, 'utf8').split('\n').filter(Boolean).length

    // Life 1: the work happens and closes. Life 2: hydration prunes the aged
    // record and buries its key — the ONE legitimate burial.
    const first = onDisk(NOW - 30 * DAY)
    await dispatchAndSettle(first, 'agent-1', { text: PROMPT, idempotencyKey: 'key-a' })
    first.completeTurn('dsp-1', { turnIndex: 1 })
    onDisk(NOW)
    const afterBurial = lines()
    expect(readDispatchTombstones(file)).toHaveLength(1)

    // Lives 3 and 4: the record is already superseded by its tombstone —
    // it is not reloaded as live and NEVER re-buried. The file is stable.
    onDisk(NOW)
    onDisk(NOW)
    expect(lines()).toBe(afterBurial)
    expect(readDispatchTombstones(file)).toHaveLength(1)

    // The key's promise still replays from the tombstone.
    const replay = await onDisk(NOW).dispatch('agent-1', {
      text: PROMPT,
      idempotencyKey: 'key-a'
    })
    expect(replay.status).toBe(200)
    expect(replay.body).toMatchObject({ dispatchId: 'dsp-1', replay: true, tombstone: true })
  })

  it('tombstones expire after the 90-day TTL — long, not forever', async () => {
    const buried: DispatchTombstone[] = []
    const service = new DispatchService(
      deps({
        newId: () => 'dsp-new',
        loadRecords: () => [closedRow({ updatedAt: NOW - 120 * DAY })],
        persistTombstone: (tombstone) => {
          buried.push(tombstone)
          return true
        }
      })
    )
    // The tombstone is written (the prune cannot know the future) but a key
    // older than the TTL is honestly new work again.
    const fresh = await dispatchAndSettle(service, 'agent-1', {
      text: PROMPT,
      idempotencyKey: 'key-old'
    })
    expect(fresh.status).toBe(202)
    expect(fresh.body).toMatchObject({ dispatchId: 'dsp-new' })
  })
})

// ---------------------------------------------------------------------------
// Fix 6 — herdr death interrupts, it does not strand.
// ---------------------------------------------------------------------------

describe('backend death interrupts every open dispatch', () => {
  it('onBackendDeath stamps open records interrupted through the release path', async () => {
    let ends = 0
    const service = new DispatchService(
      deps({
        endWork: () => {
          ends += 1
        }
      })
    )
    await dispatchAndSettle(service)
    expect(service.get('dsp-1')?.state).toBe('running')

    const stamped = service.onBackendDeath('herdr server died')
    expect(stamped).toEqual(['dsp-1'])
    expect(service.get('dsp-1')).toMatchObject({
      state: 'interrupted',
      error: 'herdr server died'
    })
    expect(ends).toBe(1)
    // Idempotent, like every other terminal transition.
    expect(service.onBackendDeath('herdr server died')).toEqual([])
    expect(ends).toBe(1)
  })

  it('leaves closed records exactly as they closed', async () => {
    const service = new DispatchService(deps())
    await dispatchAndSettle(service)
    service.completeTurn('dsp-1', { turnIndex: 3 })
    expect(service.onBackendDeath('herdr server died')).toEqual([])
    expect(service.get('dsp-1')?.state).toBe('done')
  })

  it('a failed delivery over a DEAD backend is interrupted, never failed', async () => {
    let fallbacks = 0
    const service = new DispatchService(
      deps({
        promptAgent: async () => {
          throw new Error('connection refused')
        },
        backendAlive: () => false,
        reattachFallback: async () => {
          fallbacks += 1
          return true
        }
      })
    )
    await dispatchAndSettle(service)
    expect(service.get('dsp-1')?.state).toBe('interrupted')
    expect(service.get('dsp-1')?.error).toMatch(/backend died/i)
    // No fallback either: retrying into an outage is how double-sends happen.
    expect(fallbacks).toBe(0)
  })

  it('the same failure over a LIVE backend keeps the ordinary evidence path', async () => {
    const service = new DispatchService(
      deps({
        promptAgent: async () => 'failed',
        backendAlive: () => true,
        capture: () => '> '
      })
    )
    await dispatchAndSettle(service)
    expect(service.get('dsp-1')?.state).toBe('failed')
  })
})

describe('interruptAgent — one agent retired, its dispatches interrupted', () => {
  it('scopes to the named agent and leaves the rest running', async () => {
    let n = 0
    const service = new DispatchService(
      deps({
        newId: () => `dsp-${(n += 1)}`,
        resolveAgent: (id) =>
          id === 'agent-1' || id === 'agent-2' ? { name: id, workspaceId: 'ws-1' } : null
      })
    )
    await dispatchAndSettle(service, 'agent-1')
    await dispatchAndSettle(service, 'agent-2')

    expect(service.interruptAgent('agent-1', 'node removed')).toEqual(['dsp-1'])
    expect(service.get('dsp-1')).toMatchObject({ state: 'interrupted', error: 'node removed' })
    expect(service.get('dsp-2')?.state).toBe('running')
    // The retired agent's slot is free (relevant to rebind, where the id lives on).
    const again = await service.dispatch('agent-1', { text: PROMPT })
    expect(again.status).toBe(202)
    await service.settled(String((again.body as { dispatchId: string }).dispatchId))
  })
})

// ---------------------------------------------------------------------------
// Fix 7 — the consumer principal seam.
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

describe('the principal comes from the auth, never the body', () => {
  it('the route injects owner and ignores a body-supplied consumer', async () => {
    const service = new DispatchService(deps())
    const { response } = stubResponse()
    await handleMobileApi(
      stubRequest('POST', { text: PROMPT, consumer: 'tenant-evil' }),
      response,
      url('/api/agents/agent-1/dispatch'),
      { dispatch: service } as unknown as MobileApiDeps
    )
    await service.settled('dsp-1')
    expect(service.get('dsp-1')?.consumer).toBe('owner')
  })

  it('a foreign principal reading a dispatch gets 404, not 403', async () => {
    // Consumers require the native-file observer grade (Sol r3 P0-5).
    const service = new DispatchService(deps({ beginWork: () => 'native-file' }))
    await dispatchAndSettle(service, 'agent-1', { text: PROMPT, consumer: 'tenant-a' })
    // The refusal must be indistinguishable from a nonexistent id — 403 would
    // confirm to tenant-b that tenant-a's dispatch exists.
    expect(service.lookup('dsp-1', 'tenant-b')).toEqual(
      service.lookup('no-such-dispatch', 'tenant-b')
    )
    expect(service.lookup('dsp-1', 'tenant-b').status).toBe(404)
    // Its own consumer and the owner both see it.
    expect(service.lookup('dsp-1', 'tenant-a').status).toBe(200)
    expect(service.lookup('dsp-1', 'owner').status).toBe(200)
    expect(service.lookup('dsp-1').status).toBe(200) // in-process default = owner
  })

  it('an owner record is invisible to tenants too', async () => {
    const service = new DispatchService(deps())
    await dispatchAndSettle(service, 'agent-1', { text: PROMPT, consumer: 'owner' })
    expect(service.lookup('dsp-1', 'tenant-a').status).toBe(404)
    expect(service.lookup('dsp-1', 'owner').status).toBe(200)
  })

  it('idempotency scopes do not collide across principals', async () => {
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
  })
})

// ---------------------------------------------------------------------------
// Fix 1 (route half) — HTTP producers are serialized against a live dispatch.
// ---------------------------------------------------------------------------

describe('POST /api/terminal/:id/{input,ask,raw} while a dispatch is armed', () => {
  it('refuses 409 for every HTTP producer while the stamp is armed — raw included', async () => {
    // /raw writes arbitrary bytes (a prompt plus Enter included) straight
    // into the same input box; leaving it outside the choke point was a
    // reservation with a side door.
    for (const route of ['input', 'ask', 'raw']) {
      const { response, captured } = stubResponse()
      const handled = await handleMobileApi(
        stubRequest('POST', { text: 'a competing prompt' }),
        response,
        url(`/api/terminal/term-1/${route}`),
        { hasArmedDispatch: (id: string) => id === 'term-1' } as unknown as MobileApiDeps
      )
      expect(handled).toBe(true)
      expect(captured.status).toBe(409)
      expect(captured.body).toMatchObject({ error: 'agent has a dispatch in flight' })
    }
  })

  it('stands aside (unhandled) when no dispatch is armed — the server route serves it', async () => {
    const { response } = stubResponse()
    const handled = await handleMobileApi(
      stubRequest('POST', { text: 'hello' }),
      response,
      url('/api/terminal/term-1/input'),
      { hasArmedDispatch: () => false } as unknown as MobileApiDeps
    )
    expect(handled).toBe(false)
  })

  it('does not gate other terminals or non-producer routes', async () => {
    const { response } = stubResponse()
    const handled = await handleMobileApi(
      stubRequest('POST', { text: 'hello' }),
      response,
      url('/api/terminal/other-terminal/input'),
      { hasArmedDispatch: (id: string) => id === 'term-1' } as unknown as MobileApiDeps
    )
    expect(handled).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Sol r2 P1 — a confirmed native delivery registers its exact prompt with the
// live tracker (the native path never crosses the PTY input stream).
// ---------------------------------------------------------------------------

describe('confirmed delivery hands the tracker the exact prompt', () => {
  it('notes the delivered prompt on herdr done', async () => {
    const delivered: [string, string][] = []
    const service = new DispatchService(
      deps({ noteDelivered: (agentId, prompt) => delivered.push([agentId, prompt]) })
    )
    await dispatchAndSettle(service)
    expect(delivered).toEqual([['agent-1', PROMPT]])
  })

  it('notes it when the landing check finds the echo (stalled-but-landed)', async () => {
    const delivered: string[] = []
    const service = new DispatchService(
      deps({
        promptAgent: async () => 'submitted',
        capture: () => `⏺ working\n> ${PROMPT}\n`,
        noteDelivered: (_agentId, prompt) => delivered.push(prompt)
      })
    )
    await dispatchAndSettle(service)
    expect(service.get('dsp-1')?.confirmed).toBe(true)
    expect(delivered).toEqual([PROMPT])
  })

  it('notes the ATTEMPTED prompt when non-delivery is unproven (Sol r3 P1-9)', async () => {
    // The common collapsed-echo path: the submission almost certainly landed
    // but the screen cannot show it. The exchange still needs its exact
    // prompt fact — without it, scrape closure depends on recovering identity
    // from "[Pasted text #1 …]", which proves nothing. The confidence
    // distinction stays on the record (`confirmed: false`), not on the fact.
    const delivered: string[] = []
    let submitted = false
    const service = new DispatchService(
      deps({
        promptAgent: async () => {
          submitted = true
          return 'submitted'
        },
        // Screen moved but no echo: honest grade is unconfirmed.
        capture: () => (submitted ? '> [Pasted text #1 +40 lines]\n⏺ working' : '> '),
        noteDelivered: (_agentId, prompt) => delivered.push(prompt)
      })
    )
    await dispatchAndSettle(service)
    expect(service.get('dsp-1')?.confirmed).toBe(false)
    expect(delivered).toEqual([PROMPT])
  })

  it('does NOT note a prompt whose non-delivery was proven', async () => {
    // The one branch that keeps its silence: pane unchanged, no echo, agent
    // not busy — positive proof the prompt never arrived. Registering a
    // prompt fact here would let the fallback's re-send get correlated
    // against a delivery that never happened.
    const delivered: string[] = []
    const service = new DispatchService(
      deps({
        promptAgent: async () => 'submitted',
        capture: () => '> ',
        noteDelivered: (_agentId, prompt) => delivered.push(prompt),
        reattachFallback: async () => true
      })
    )
    await dispatchAndSettle(service)
    expect(service.get('dsp-1')?.via).toBe('pty-fallback')
    expect(delivered).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Sol r2 P1 — acceptance must not block on the delivery leg's pane reads.
// ---------------------------------------------------------------------------

describe('the 202 leaves before the delivery leg starts', () => {
  it('no deepCapture and no promptAgent work has run when dispatch() returns', async () => {
    let deepReads = 0
    let prompts = 0
    const service = new DispatchService(
      deps({
        captureDeep: () => {
          deepReads += 1
          return '> '
        },
        promptAgent: async () => {
          prompts += 1
          return 'done'
        }
      })
    )
    const response = await service.dispatch('agent-1', { text: PROMPT })
    expect(response.status).toBe(202)
    // The delivery leg starts on a setImmediate — its synchronous pane reads
    // (deepCapture is a CLI call in production) have not run yet, so the
    // response never waited on them. The admission's own `capture` read
    // (context-full) is a different, index-cached seam.
    expect(deepReads).toBe(0)
    expect(prompts).toBe(0)
    await service.settled('dsp-1')
    expect(deepReads).toBe(1) // the pre-submission look — taken inside the leg
    expect(prompts).toBe(1)
  })
})
