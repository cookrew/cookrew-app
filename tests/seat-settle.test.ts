import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  SeatSettleQueue,
  loadUnsettled,
  settleBackoffMs,
  unsettledSeatsPath,
  writeUnsettled,
  type SeatSettleApi,
  type UnsettledSeat
} from '../src/main/seat-settle'
import type { AccountResult } from '../src/shared/account-v2'
import type { SeatFace } from '../src/shared/seats'

/**
 * A PURCHASE MUST OUTLIVE A REGISTRY OUTAGE.
 *
 * The door already took the money when this queue is called, so the only
 * failure mode that matters is losing the fact of it. Every test here is a way
 * that could happen: the registry is down, the session expired, the app was
 * killed between the charge and the report, the same charge arrived twice.
 */

const TEAM = '@drej/cookrew-alpha'
const NOW = 1_800_000_000_000

const seat: SeatFace = {
  id: 'seat-1',
  team: TEAM,
  account: 'mira',
  source: 'bought',
  by: 'stripe',
  createdAt: NOW
}

interface Stub extends SeatSettleApi {
  calls: { team: string; username: string; by: string; receipt: string }[]
}

function stub(answers: AccountResult<SeatFace>[]): Stub {
  const calls: Stub['calls'] = []
  return {
    calls,
    settle: async (team, input) => {
      calls.push({ team, ...input })
      return answers[Math.min(calls.length - 1, answers.length - 1)]
    }
  }
}

const ok: AccountResult<SeatFace> = { ok: true, value: seat }
const offline: AccountResult<SeatFace> = { ok: false, reason: 'offline' }

describe('the unsettled-receipt file', () => {
  let base = ''
  beforeEach(() => {
    base = mkdtempSync(path.join(tmpdir(), 'seat-settle-'))
  })
  afterEach(() => rmSync(base, { recursive: true, force: true }))

  it('lives beside the account and is written 0600 — it names who paid what', () => {
    const entry: UnsettledSeat = {
      team: TEAM,
      username: 'mira',
      by: 'stripe',
      receipt: 'cs_1',
      at: NOW,
      tries: 0
    }
    writeUnsettled([entry], base)
    expect(unsettledSeatsPath(base)).toBe(path.join(base, 'seats-unsettled.json'))
    expect(statSync(unsettledSeatsPath(base)).mode & 0o777).toBe(0o600)
    expect(loadUnsettled(base)).toEqual([entry])
  })

  it('reads a missing or corrupt file as an empty queue, never as a crash', () => {
    expect(loadUnsettled(base)).toEqual([])
    writeFileSync(unsettledSeatsPath(base), 'not json at all')
    expect(loadUnsettled(base)).toEqual([])
    writeFileSync(unsettledSeatsPath(base), JSON.stringify([{ nonsense: true }, 42]))
    expect(loadUnsettled(base)).toEqual([])
  })

  it('backs off 1s, 4s, 9s — three tries inside fifteen seconds, then disk', () => {
    expect([1, 2, 3].map(settleBackoffMs)).toEqual([1000, 4000, 9000])
  })
})

describe('reporting a purchase', () => {
  let base = ''
  const slept: number[] = []
  const sleep = async (ms: number): Promise<void> => void slept.push(ms)

  beforeEach(() => {
    base = mkdtempSync(path.join(tmpdir(), 'seat-settle-'))
    slept.length = 0
  })
  afterEach(() => rmSync(base, { recursive: true, force: true }))

  const queue = (seats: SeatSettleApi, over: { onStuck?: (e: UnsettledSeat) => void } = {}) =>
    new SeatSettleQueue({ seats, base, now: () => NOW, sleep, ...over })

  const purchase = { team: TEAM, username: 'mira', by: 'stripe' as const, receipt: 'cs_1' }

  it('settles on the first try and leaves nothing on disk', async () => {
    const seats = stub([ok])
    await expect(queue(seats).record(purchase)).resolves.toBe(true)
    expect(seats.calls).toEqual([{ team: TEAM, username: 'mira', by: 'stripe', receipt: 'cs_1' }])
    expect(loadUnsettled(base)).toEqual([])
    expect(slept).toEqual([])
  })

  it('WRITES THE RECEIPT BEFORE THE FIRST ATTEMPT — a crash mid-report loses nothing', async () => {
    let sawOnDisk: readonly UnsettledSeat[] = []
    const seats: SeatSettleApi = {
      settle: async () => {
        sawOnDisk = loadUnsettled(base)
        return ok
      }
    }
    await queue(seats).record(purchase)
    expect(sawOnDisk).toHaveLength(1)
    expect(sawOnDisk[0]).toMatchObject({ receipt: 'cs_1', username: 'mira', at: NOW })
  })

  it('retries three times with a backoff, then keeps the receipt for the next boot', async () => {
    const seats = stub([offline])
    const stuck: UnsettledSeat[] = []
    await expect(
      queue(seats, { onStuck: (e) => void stuck.push(e) }).record(purchase)
    ).resolves.toBe(false)
    expect(seats.calls).toHaveLength(3)
    expect(slept).toEqual([1000, 4000])
    expect(stuck).toHaveLength(1)
    const left = loadUnsettled(base)
    expect(left).toHaveLength(1)
    expect(left[0].tries).toBe(3)
  })

  it('settles on a later try and clears the file then', async () => {
    const seats = stub([offline, offline, ok])
    await expect(queue(seats).record(purchase)).resolves.toBe(true)
    expect(seats.calls).toHaveLength(3)
    expect(loadUnsettled(base)).toEqual([])
  })

  it('reads ALREADY SEATED as success — it is what the report was asking for', async () => {
    const seats = stub([{ ok: false, reason: 'already_seated' }])
    await expect(queue(seats).record(purchase)).resolves.toBe(true)
    expect(seats.calls).toHaveLength(1)
    expect(loadUnsettled(base)).toEqual([])
  })

  it('stops at once on a username nobody holds, and says so rather than retrying forever', async () => {
    const seats = stub([{ ok: false, reason: 'not_found' }])
    const stuck: UnsettledSeat[] = []
    await expect(
      queue(seats, { onStuck: (e) => void stuck.push(e) }).record(purchase)
    ).resolves.toBe(false)
    expect(seats.calls).toHaveLength(1)
    expect(stuck).toHaveLength(1)
    expect(loadUnsettled(base)).toEqual([])
  })

  it('survives a settle that throws instead of refusing', async () => {
    const seats: SeatSettleApi = {
      settle: () => Promise.reject(new Error('socket hung up'))
    }
    await expect(queue(seats).record(purchase)).resolves.toBe(false)
    expect(loadUnsettled(base)).toHaveLength(1)
  })

  it('is idempotent by receipt — one charge is one row however often it arrives', async () => {
    const seats = stub([offline])
    const q = queue(seats)
    await q.record(purchase)
    await q.record(purchase)
    expect(loadUnsettled(base)).toHaveLength(1)
  })
})

describe('draining at boot', () => {
  let base = ''
  beforeEach(() => {
    base = mkdtempSync(path.join(tmpdir(), 'seat-settle-'))
  })
  afterEach(() => rmSync(base, { recursive: true, force: true }))

  const rows: UnsettledSeat[] = [
    { team: TEAM, username: 'mira', by: 'stripe', receipt: 'cs_1', at: NOW, tries: 3 },
    { team: TEAM, username: 'lin', by: 'x402', receipt: 'x402:abc', at: NOW, tries: 3 }
  ]

  it('reports everything the last run could not, and empties the file', async () => {
    writeUnsettled(rows, base)
    const seats = stub([ok])
    const settled = await new SeatSettleQueue({
      seats,
      base,
      now: () => NOW,
      sleep: async () => undefined
    }).drain()
    expect(settled).toBe(2)
    expect(seats.calls.map((c) => c.receipt)).toEqual(['cs_1', 'x402:abc'])
    expect(loadUnsettled(base)).toEqual([])
  })

  it('leaves a still-unreachable registry\'s receipts exactly where they were', async () => {
    writeUnsettled(rows, base)
    const settled = await new SeatSettleQueue({
      seats: stub([offline]),
      base,
      now: () => NOW,
      sleep: async () => undefined
    }).drain()
    expect(settled).toBe(0)
    expect(loadUnsettled(base).map((r) => r.receipt)).toEqual(['cs_1', 'x402:abc'])
  })

  it('does not run twice at once — a second drain mid-flight is a no-op', async () => {
    writeUnsettled(rows, base)
    let inFlight: Promise<number> | null = null
    const seats: SeatSettleApi = {
      settle: async () => {
        // Re-entering while the first drain is still walking the queue.
        if (inFlight !== null) await expect(inFlight).resolves.toBeDefined()
        return ok
      }
    }
    const q = new SeatSettleQueue({ seats, base, now: () => NOW, sleep: async () => undefined })
    const first = q.drain()
    await expect(q.drain()).resolves.toBe(0)
    inFlight = null
    await expect(first).resolves.toBe(2)
  })

  it('an empty queue is a drain that touches nothing', async () => {
    const seats = stub([ok])
    await expect(
      new SeatSettleQueue({ seats, base, now: () => NOW }).drain()
    ).resolves.toBe(0)
    expect(seats.calls).toEqual([])
  })
})
