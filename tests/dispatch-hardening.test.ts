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
  compareTerminalIntents,
  promptFingerprint,
  readDispatchRecords,
  readDispatchTombstones,
  type DispatchDeps,
  type DispatchGeneration,
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

describe('delivery prompt facts: attempted BEFORE the blocking submit (Sol r4 P1)', () => {
  it('registers the attempted fact before promptAgent runs, then confirms on done', async () => {
    // herdr `agent prompt` blocks until the agent leaves working — a fact
    // registered only on return can arrive after the scrape already settled
    // the turn. The ordering is the contract: fact first, submission second.
    const events: string[] = []
    const service = new DispatchService(
      deps({
        promptAgent: async () => {
          events.push('submit')
          return 'done'
        },
        noteDelivered: (agentId, prompt) => events.push(`note:${agentId}:${prompt === PROMPT}`)
      })
    )
    await dispatchAndSettle(service)
    // Attempted registration precedes the submission; done re-confirms.
    expect(events[0]).toBe('note:agent-1:true')
    expect(events.indexOf('submit')).toBe(1)
    expect(events.filter((e) => e.startsWith('note:'))).toHaveLength(2)
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
    // The attempted registration plus the landing confirmation.
    expect(delivered).toEqual([PROMPT, PROMPT])
  })

  it('keeps the fact when non-delivery is unproven (Sol r3 P1-9)', async () => {
    // The common collapsed-echo path: the submission almost certainly landed
    // but the screen cannot show it. The exchange still needs its exact
    // prompt fact — without it, scrape closure depends on recovering identity
    // from "[Pasted text #1 …]", which proves nothing. The confidence
    // distinction stays on the record (`confirmed: false`), not on the fact.
    const delivered: string[] = []
    const retracted: string[] = []
    let submitted = false
    const service = new DispatchService(
      deps({
        promptAgent: async () => {
          submitted = true
          return 'submitted'
        },
        // Screen moved but no echo: honest grade is unconfirmed.
        capture: () => (submitted ? '> [Pasted text #1 +40 lines]\n⏺ working' : '> '),
        noteDelivered: (_agentId, prompt) => delivered.push(prompt),
        retractDelivered: (_agentId, prompt) => retracted.push(prompt)
      })
    )
    await dispatchAndSettle(service)
    expect(service.get('dsp-1')?.confirmed).toBe(false)
    expect(delivered.length).toBeGreaterThanOrEqual(1)
    expect(retracted).toEqual([])
  })

  it('RETRACTS the attempted fact when non-delivery is proven (Sol r4 P1)', async () => {
    // Pane unchanged, no echo, agent not busy — positive proof the prompt
    // never arrived. The attempted fact registered before the submission is
    // now false: retract it, or the fallback's re-send would be correlated
    // against a delivery that never happened.
    const delivered: string[] = []
    const retracted: string[] = []
    const service = new DispatchService(
      deps({
        promptAgent: async () => 'submitted',
        capture: () => '> ',
        noteDelivered: (_agentId, prompt) => delivered.push(prompt),
        retractDelivered: (agentId, prompt) => retracted.push(`${agentId}:${prompt}`),
        reattachFallback: async () => true
      })
    )
    await dispatchAndSettle(service)
    expect(service.get('dsp-1')?.via).toBe('pty-fallback')
    expect(delivered).toEqual([PROMPT]) // the attempted registration
    expect(retracted).toEqual([`agent-1:${PROMPT}`]) // taken back on proof
  })

  it('a context-full refusal never registers a fact — nothing was attempted', async () => {
    const delivered: string[] = []
    const service = new DispatchService(
      deps({
        capture: () => '100% context used',
        noteDelivered: (_agentId, prompt) => delivered.push(prompt)
      })
    )
    await dispatchAndSettle(service)
    expect(service.get('dsp-1')?.error).toBe('context-full')
    expect(delivered).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Sol r4 P1 — terminal evidence carries provenance: parser outranks
// infrastructure at equal state; equal evidence merges metadata.
// ---------------------------------------------------------------------------

describe('terminal intents rank provenance, not just state (Sol r4 P1)', () => {
  afterEach(() => vi.restoreAllMocks())

  it('a parked PARSER interrupted survives an equal-state infrastructure interruption', async () => {
    // The review's exact shape: a parser-proven interrupted completion (with
    // its answering turn identity) parks on a ledger fault; a backend death
    // then projects to the same state. Equal strength used to REPLACE the
    // parked parser row — the generic interruption landed without its turn
    // evidence. Provenance now keeps the parser verdict.
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    let ledgerUp = true
    const service = new DispatchService(deps({ persist: () => ledgerUp }))
    await dispatchAndSettle(service)
    ledgerUp = false
    service.completeTurn('dsp-1', { turnIndex: 7, uuid: 'uuid-7', outcome: 'interrupted' })
    expect(service.get('dsp-1')?.state).toBe('running') // parked, fail-closed
    service.onBackendDeath('herdr server died')
    ledgerUp = true
    service.sweep()
    expect(service.get('dsp-1')).toMatchObject({
      state: 'interrupted',
      turnIndex: 7,
      turnUuid: 'uuid-7',
      error: 'interrupted: the agent turn was interrupted'
    })
  })

  it('a PARSER interrupted replaces a parked infrastructure interruption — the other direction', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    let ledgerUp = true
    const service = new DispatchService(deps({ persist: () => ledgerUp }))
    await dispatchAndSettle(service)
    ledgerUp = false
    service.interrupt('dsp-1', 'backend hiccup, never durable')
    expect(service.get('dsp-1')?.state).toBe('running')
    // The parser lane lands its own interrupted verdict for the same
    // dispatch: equal state, stronger provenance — it takes the park.
    service.completeTurn('dsp-1', { turnIndex: 9, uuid: 'uuid-9', outcome: 'interrupted' })
    ledgerUp = true
    service.sweep()
    expect(service.get('dsp-1')).toMatchObject({
      state: 'interrupted',
      turnIndex: 9,
      turnUuid: 'uuid-9'
    })
  })

  it('equal provenance and state MERGES metadata rather than erasing it', async () => {
    // Two infrastructure interruptions: the later reason lands, but nothing
    // the earlier intent knew is thrown away — and the release still fires
    // exactly once when the row finally lands.
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
    service.interrupt('dsp-1', 'first infrastructure verdict')
    service.onBackendDeath('second infrastructure verdict')
    ledgerUp = true
    service.sweep()
    expect(service.get('dsp-1')).toMatchObject({
      state: 'interrupted',
      error: 'second infrastructure verdict'
    })
    expect(ends).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Sol r4 P1 — the answering identity is persisted beside the display index.
// ---------------------------------------------------------------------------

describe('turnUuid — a rewind-reused index stays distinguishable', () => {
  it('persists the uuid through completeTurn and serves it on lookup', async () => {
    const persisted: DispatchRecord[] = []
    const service = new DispatchService(
      deps({
        persist: (record) => {
          persisted.push(record)
          return true
        }
      })
    )
    await dispatchAndSettle(service)
    service.completeTurn('dsp-1', { turnIndex: 3, uuid: 'uuid-life-1', reply: 'first answer' })
    expect(service.lookup('dsp-1').body).toMatchObject({ turnIndex: 3, turnUuid: 'uuid-life-1' })
    // On disk too — an audit resolves by identity, not by a reusable ordinal.
    expect(persisted.at(-1)).toMatchObject({ turnIndex: 3, turnUuid: 'uuid-life-1' })
  })

  it('two dispatches answered at the SAME index differ by uuid after a rewind', async () => {
    let n = 0
    const service = new DispatchService(deps({ newId: () => `dsp-${(n += 1)}` }))
    await dispatchAndSettle(service)
    service.completeTurn('dsp-1', { turnIndex: 3, uuid: 'uuid-before-rewind' })
    // A /rewind reuses index 3 for entirely different work; the next
    // dispatch's answer lands at the same ordinal.
    await dispatchAndSettle(service)
    service.completeTurn('dsp-2', { turnIndex: 3, uuid: 'uuid-after-rewind' })

    expect(service.get('dsp-1')).toMatchObject({ turnIndex: 3, turnUuid: 'uuid-before-rewind' })
    expect(service.get('dsp-2')).toMatchObject({ turnIndex: 3, turnUuid: 'uuid-after-rewind' })
  })

  it('tolerates absence — a scrape closure without a uuid persists none', async () => {
    const service = new DispatchService(deps())
    await dispatchAndSettle(service)
    service.completeTurn('dsp-1', { turnIndex: 3 })
    expect(service.get('dsp-1')?.turnUuid).toBeUndefined()
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

// ---------------------------------------------------------------------------
// Sol r5 P0-2 — a queued delivery does not survive interruption: every
// irreversible submission revalidates that its dispatch is still open, still
// owns the reservation, and was not aborted.
// ---------------------------------------------------------------------------

describe('interruption cancels the queued delivery before any prompt write (Sol r5 P0-2)', () => {
  it('202 → interrupt in the setImmediate gap → promptAgent never runs, no fact lingers', async () => {
    // The 202 leaves, the delivery leg sits queued on its macrotask hop, and
    // the owner preempts (interruptAgent) in that gap. The captured callback
    // used to submit unconditionally — the cancelled consumer brief landed
    // beside the owner's work. Now the leg revalidates and writes nothing.
    let prompts = 0
    const delivered: string[] = []
    const retracted: string[] = []
    const service = new DispatchService(
      deps({
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
    expect(service.interruptAgent('agent-1', 'owner preempted the dispatch')).toEqual(['dsp-1'])
    await service.settled('dsp-1')

    expect(prompts).toBe(0)
    // The attempted-delivery fact either never registered or was retracted —
    // nothing about a prompt that never went out survives in the tracker.
    expect(delivered).toEqual(retracted)
    expect(service.get('dsp-1')).toMatchObject({
      state: 'interrupted',
      error: 'owner preempted the dispatch'
    })
  })

  it('a cancellation between the attempted fact and the submission retracts exactly that fact', async () => {
    // The tightest race: the leg has already registered its attempted fact
    // when the interrupt lands. Modeled via the noteDelivered dep itself —
    // since Sol r11 the deep capture is followed by a revalidation, so the
    // fact's own registration is the last injectable point inside the
    // synchronous pre-submission stretch. The revalidation immediately
    // before promptAgent catches it: no submission, and the attempted fact
    // is taken back under its own generation.
    let prompts = 0
    const delivered: Array<{ prompt: string; gen: DispatchGeneration }> = []
    const retracted: Array<{ prompt: string; gen: DispatchGeneration }> = []
    let service!: DispatchService
    service = new DispatchService(
      deps({
        promptAgent: async () => {
          prompts += 1
          return 'done'
        },
        noteDelivered: (_agentId, prompt, gen) => {
          delivered.push({ prompt, gen })
          // The owner preempts in the beat after the fact registers and
          // before the irreversible submission.
          if (delivered.length === 1) service.interruptAgent('agent-1', 'owner preempted')
        },
        retractDelivered: (_agentId, prompt, gen) => retracted.push({ prompt, gen })
      })
    )
    await dispatchAndSettle(service)

    expect(prompts).toBe(0)
    expect(delivered).toEqual([
      { prompt: PROMPT, gen: { dispatchId: 'dsp-1', armedAt: NOW } }
    ])
    // Retracted under the SAME generation — its own attempted fact, nothing
    // a successor might have registered.
    expect(retracted).toEqual(delivered)
    expect(service.get('dsp-1')?.state).toBe('interrupted')
  })

  it('a cancellation while promptAgent blocks stops the reattach fallback too', async () => {
    // promptAgent fails after the owner already preempted: the evidence path
    // would prove non-delivery and reach for the PTY fallback — the OTHER
    // irreversible submission. The revalidation before reattach refuses it.
    let reattaches = 0
    let interruptNow = (): void => undefined
    const gate = new Promise<void>((resolve) => (interruptNow = resolve))
    const service = new DispatchService(
      deps({
        promptAgent: async () => {
          await gate
          return 'failed'
        },
        capture: () => '> ', // pane never moved, no echo
        agentStatus: () => 'idle',
        reattachFallback: async () => {
          reattaches += 1
          return true
        }
      })
    )
    const response = await service.dispatch('agent-1', { text: PROMPT })
    expect(response.status).toBe(202)
    // Let the leg reach its blocking submission, then preempt mid-await.
    await new Promise((resolve) => setImmediate(resolve))
    service.interruptAgent('agent-1', 'owner preempted mid-submission')
    interruptNow()
    await service.settled('dsp-1')

    expect(reattaches).toBe(0)
    expect(service.get('dsp-1')).toMatchObject({
      state: 'interrupted',
      error: 'owner preempted mid-submission'
    })
  })

  it('backend death in the gap cancels the delivery the same way', async () => {
    let prompts = 0
    const service = new DispatchService(
      deps({
        promptAgent: async () => {
          prompts += 1
          return 'done'
        }
      })
    )
    await service.dispatch('agent-1', { text: PROMPT })
    expect(service.onBackendDeath('herdr server died')).toEqual(['dsp-1'])
    await service.settled('dsp-1')
    expect(prompts).toBe(0)
    expect(service.get('dsp-1')?.state).toBe('interrupted')
  })

  it('endWork-via-release (turn completes in the gap) cancels the queued delivery', async () => {
    // A file-closer completion can land between the 202 and the macrotask
    // hop. The record settles done — and the queued leg must not then type
    // the already-answered brief into the pane.
    let prompts = 0
    const service = new DispatchService(
      deps({
        promptAgent: async () => {
          prompts += 1
          return 'done'
        }
      })
    )
    await service.dispatch('agent-1', { text: PROMPT })
    service.completeTurn('dsp-1', { turnIndex: 2, uuid: 'uuid-2', reply: 'already answered' })
    await service.settled('dsp-1')
    expect(prompts).toBe(0)
    expect(service.get('dsp-1')).toMatchObject({ state: 'done', turnIndex: 2 })
  })

  it('an owner preemption whose interrupt row PARKS still cancels the write (fail closed)', async () => {
    // The interrupt's append fails, so the record is held open with a ledger
    // fault — the outcome is decided, merely not yet durable. The queued leg
    // must treat a parked terminal intent exactly like a terminal state.
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    let prompts = 0
    let ledgerUp = true
    const service = new DispatchService(
      deps({
        persist: () => ledgerUp,
        promptAgent: async () => {
          prompts += 1
          return 'done'
        }
      })
    )
    await service.dispatch('agent-1', { text: PROMPT })
    ledgerUp = false
    service.interruptAgent('agent-1', 'owner preempted, ledger down')
    await service.settled('dsp-1')
    expect(prompts).toBe(0)
    // The parked intent lands once the ledger recovers.
    ledgerUp = true
    service.sweep()
    expect(service.get('dsp-1')?.state).toBe('interrupted')
    vi.restoreAllMocks()
  })

  it('the healthy path is untouched: no cancellation, normal delivery and closure', async () => {
    const delivered: Array<{ prompt: string; gen: DispatchGeneration }> = []
    let prompts = 0
    const service = new DispatchService(
      deps({
        promptAgent: async () => {
          prompts += 1
          return 'done'
        },
        noteDelivered: (_agentId, prompt, gen) => delivered.push({ prompt, gen })
      })
    )
    await dispatchAndSettle(service)
    expect(prompts).toBe(1)
    // Attempted + confirmed, both under the arming generation.
    expect(delivered).toEqual([
      { prompt: PROMPT, gen: { dispatchId: 'dsp-1', armedAt: NOW } },
      { prompt: PROMPT, gen: { dispatchId: 'dsp-1', armedAt: NOW } }
    ])
    expect(service.get('dsp-1')?.state).toBe('running')
    service.completeTurn('dsp-1', { turnIndex: 1 })
    expect(service.get('dsp-1')?.state).toBe('done')
  })
})

// ---------------------------------------------------------------------------
// Sol r11 P0-4 / P1 — the delivery AbortController exists from the FIRST
// awaited preflight, and every awaited preflight is followed by a
// revalidation in the same synchronous stretch as what comes next. The r10
// shape created the controller only after the captures: a cancellation that
// fired while a capture (or the registry resolution inside submitAgent) ran
// had no token to fire, and the leg marched on to the irreversible
// submission.
// ---------------------------------------------------------------------------

describe('the abort seam covers the awaited preflights (Sol r11)', () => {
  it('the controller is registered BEFORE the first capture, and an interrupt during it submits nothing', async () => {
    let releaseCapture!: (view: string) => void
    const captureGate = new Promise<string>((resolve) => (releaseCapture = resolve))
    let prompts = 0
    const delivered: string[] = []
    const service = new DispatchService(
      deps({
        capture: () => captureGate, // the context-full look, hanging
        promptAgent: async () => {
          prompts += 1
          return 'done'
        },
        noteDelivered: (_agentId, prompt) => delivered.push(prompt)
      })
    )
    const response = await service.dispatch('agent-1', { text: PROMPT })
    expect(response.status).toBe(202)
    // Let the leg off its setImmediate hop and into the hanging capture —
    // the abort entry must ALREADY exist there (Sol r11 P1): this is the
    // token every cancellation path fires, and the signal submitAgent
    // revalidates across its own awaited resolution.
    await new Promise((resolve) => setImmediate(resolve))
    const aborts = (service as unknown as { deliveryAborts: Map<string, AbortController> })
      .deliveryAborts
    expect(aborts.has('dsp-1')).toBe(true)
    const signal = aborts.get('dsp-1')!.signal
    expect(signal.aborted).toBe(false)

    service.interruptAgent('agent-1', 'owner preempted mid-capture')
    expect(signal.aborted).toBe(true) // cancelDelivery reached a live token
    releaseCapture('99% context used\n> ')
    await service.settled('dsp-1')

    // The revalidation after the capture stood the leg down: no submission,
    // no fact, and the canceller's verdict untouched — not even the
    // context-full 'failed' the released capture would have argued for.
    expect(prompts).toBe(0)
    expect(delivered).toEqual([])
    expect(service.get('dsp-1')).toMatchObject({
      state: 'interrupted',
      error: 'owner preempted mid-capture'
    })
    expect(aborts.size).toBe(0) // the entry died with the leg
  })

  it('an interrupt during the PRE-SUBMISSION deep capture stands down the same way', async () => {
    let releaseDeep!: (view: string) => void
    const deepGate = new Promise<string>((resolve) => (releaseDeep = resolve))
    let prompts = 0
    const delivered: string[] = []
    const service = new DispatchService(
      deps({
        captureDeep: () => deepGate,
        promptAgent: async () => {
          prompts += 1
          return 'done'
        },
        noteDelivered: (_agentId, prompt) => delivered.push(prompt)
      })
    )
    await service.dispatch('agent-1', { text: PROMPT })
    await new Promise((resolve) => setImmediate(resolve))
    service.interruptAgent('agent-1', 'owner preempted mid-deep-capture')
    releaseDeep('> ')
    await service.settled('dsp-1')

    // The attempted fact registers AFTER the deep capture — a leg cancelled
    // inside it must assert nothing at all.
    expect(prompts).toBe(0)
    expect(delivered).toEqual([])
    expect(service.get('dsp-1')?.state).toBe('interrupted')
  })

  it('the wired submitAgent receives a signal that is already live through its own awaited resolution', async () => {
    // The dispatch side of the round-11 gap: the signal handed to
    // submitAgent is the same controller cancelDelivery fires, created
    // before any await — so a backend that revalidates it after its `agent
    // get` (the multiplexer does; see herdr-host-multiplexer-wait tests)
    // refuses the submission a mid-resolution interrupt already cancelled.
    let observed: AbortSignal | undefined
    let releaseResolution!: () => void
    const resolutionGate = new Promise<void>((resolve) => (releaseResolution = resolve))
    const service = new DispatchService(
      deps({
        promptAgent: undefined,
        submitAgent: async (_name, _prompt, _timeoutMs, signal) => {
          observed = signal
          await resolutionGate // the backend's own awaited agent-get
          return signal?.aborted ? 'failed' : 'submitted'
        }
      })
    )
    await service.dispatch('agent-1', { text: PROMPT })
    await new Promise((resolve) => setImmediate(resolve))
    expect(observed).toBeInstanceOf(AbortSignal)
    expect(observed?.aborted).toBe(false)
    service.interruptAgent('agent-1', 'interrupted mid-resolution')
    expect(observed?.aborted).toBe(true) // fired WHILE the backend awaited
    releaseResolution()
    await service.settled('dsp-1')
    expect(service.get('dsp-1')?.state).toBe('interrupted')
  })
})

// ---------------------------------------------------------------------------
// Sol r5 P1 — delivery facts are generation-scoped: a confirmation returning
// after the dispatch settled carries its generation and changes no state.
// ---------------------------------------------------------------------------

describe('late confirmation is generation-scoped (Sol r5 P1)', () => {
  it('a confirmation after settlement carries the arming generation and changes no record state', async () => {
    // The blocking native submit outlives a fast file closure: the record is
    // done (and released) by the time `done` returns. The confirmation still
    // goes to the tracker — WITH the generation, so a tracker whose stamp for
    // that dispatchId is gone treats it as history — and the record itself
    // does not move.
    const delivered: Array<{ prompt: string; gen: DispatchGeneration }> = []
    let finish!: (outcome: 'done') => void
    const outcome = new Promise<'done'>((resolve) => (finish = resolve))
    const service = new DispatchService(
      deps({
        promptAgent: async () => outcome,
        noteDelivered: (_agentId, prompt, gen) => delivered.push({ prompt, gen })
      })
    )
    await service.dispatch('agent-1', { text: PROMPT })
    // Let the leg submit, then settle the dispatch while it blocks.
    await new Promise((resolve) => setImmediate(resolve))
    service.completeTurn('dsp-1', { turnIndex: 5, uuid: 'uuid-5', reply: 'fast close' })
    const settled = service.get('dsp-1')
    finish('done')
    await service.settled('dsp-1')

    // Every fact this exchange emitted names the same generation — the stub
    // tracker can prove which dispatch each call belongs to.
    expect(delivered.length).toBeGreaterThanOrEqual(2) // attempted + late confirm
    for (const call of delivered) {
      expect(call.gen).toEqual({ dispatchId: 'dsp-1', armedAt: NOW })
    }
    // And the settled record did not move: no state change, no new timestamps.
    expect(service.get('dsp-1')).toEqual(settled)
  })
})

// ---------------------------------------------------------------------------
// Sol r5 P1 — the lattice ranks AUTHORITY before state: parser evidence
// dominates infrastructure at any state; state strength only breaks equal
// authority; equal both merges deterministically.
// ---------------------------------------------------------------------------

describe('terminal intents rank authority before state (Sol r5 P1)', () => {
  afterEach(() => vi.restoreAllMocks())

  it('compareTerminalIntents: parser dominates infrastructure at ANY state', () => {
    // The Sol r4 miss: stateStrength*2 + parserBit let infra `failed` (4)
    // outscore parser `interrupted` (3). Authority is now the first axis.
    const parked = { state: 'interrupted' as const, evidence: 'parser' as const }
    const infraFailed = { state: 'failed' as const, evidence: 'infrastructure' as const }
    expect(compareTerminalIntents(parked, infraFailed)).toBeGreaterThan(0)
    // Both directions: a parser newcomer takes a stronger-looking infra park.
    expect(
      compareTerminalIntents(
        { state: 'failed', evidence: 'infrastructure' },
        { state: 'interrupted', evidence: 'parser' }
      )
    ).toBeLessThan(0)
    // Equal authority still ranks by state strength…
    expect(
      compareTerminalIntents(
        { state: 'done', evidence: 'parser' },
        { state: 'interrupted', evidence: 'parser' }
      )
    ).toBeGreaterThan(0)
    expect(
      compareTerminalIntents(
        { state: 'interrupted', evidence: 'infrastructure' },
        { state: 'failed', evidence: 'infrastructure' }
      )
    ).toBeLessThan(0)
    // …and equal both is the deterministic-merge tie.
    expect(
      compareTerminalIntents(
        { state: 'interrupted', evidence: 'infrastructure' },
        { state: 'interrupted', evidence: 'infrastructure' }
      )
    ).toBe(0)
  })

  it('the exact Sol scenario: parked parser interrupted survives an infra failed, and lands on recovery', async () => {
    // A parser-native interrupted completion (with its turn identity) parks
    // on a ledger fault; an infrastructure `failed` intent then challenges
    // it; the ledger recovers. The parser row — outcome AND identity — is
    // what must land, never the stronger-looking infrastructure label.
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    let ledgerUp = true
    let deliverFailed!: () => void
    const gate = new Promise<'failed'>((resolve) => (deliverFailed = () => resolve('failed')))
    const service = new DispatchService(
      deps({
        persist: () => ledgerUp,
        promptAgent: async () => gate,
        capture: () => '> ',
        agentStatus: () => 'idle'
      })
    )
    await service.dispatch('agent-1', { text: PROMPT })
    await new Promise((resolve) => setImmediate(resolve))
    // The parser lane proves the turn ended interrupted — append faults, so
    // the verdict parks fail-closed.
    ledgerUp = false
    service.completeTurn('dsp-1', { turnIndex: 7, uuid: 'uuid-7', outcome: 'interrupted' })
    expect(service.get('dsp-1')?.ledgerFault).toBe(true)
    // Infrastructure now asserts `failed` — the delivery leg's own failure
    // path resolves against the parked parser verdict.
    deliverFailed()
    await service.settled('dsp-1')
    // The ledger recovers; the sweep lands what the parser proved.
    ledgerUp = true
    service.sweep()
    expect(service.get('dsp-1')).toMatchObject({
      state: 'interrupted',
      turnIndex: 7,
      turnUuid: 'uuid-7',
      error: 'interrupted: the agent turn was interrupted'
    })
  })

  it('an infrastructure failed never replaces a parked parser interrupt — direct challenge', async () => {
    // Belt to the scenario above: force the infra `failed` through the
    // commit path itself (a failed fallback-less delivery on a live record
    // is 'failed'/infrastructure) and watch the lattice discard it.
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    let ledgerUp = true
    const service = new DispatchService(
      deps({
        persist: () => ledgerUp,
        promptAgent: async () => 'done'
      })
    )
    await dispatchAndSettle(service)
    ledgerUp = false
    service.completeTurn('dsp-1', { turnIndex: 3, uuid: 'uuid-3', outcome: 'interrupted' })
    expect(service.get('dsp-1')?.ledgerFault).toBe(true)
    // onBackendDeath sweeps ALL non-terminal records with an infrastructure
    // interruption; a parked parser verdict must survive it (equal state,
    // lower authority) — and DID before. The new claim: authority holds even
    // against the stronger-looking `failed` label, pinned above at the unit
    // level and here end-to-end through commitTerminal's gate.
    service.onBackendDeath('backend died — infrastructure verdict')
    ledgerUp = true
    service.sweep()
    expect(service.get('dsp-1')).toMatchObject({
      state: 'interrupted',
      turnIndex: 3,
      turnUuid: 'uuid-3',
      error: 'interrupted: the agent turn was interrupted'
    })
  })
})
