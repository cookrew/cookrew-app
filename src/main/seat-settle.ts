import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import type { AccountResult } from '../shared/account-v2'
import type { SeatFace } from '../shared/seats'

/**
 * A PURCHASE OUTLIVES A REGISTRY OUTAGE.
 *
 * The door takes the money at its own checkout, with the owner's own keys —
 * and only then tells cookrew.dev who bought a seat. Those are two systems and
 * the second one can be down. If the report is a fire-and-forget POST, a
 * five-minute outage at cookrew.dev turns into a caller who was charged a
 * dollar and has no seat, and nothing on either side remembers it happened.
 *
 * So the receipt goes TO DISK BEFORE THE FIRST ATTEMPT (~/.cookrew/
 * seats-unsettled.json, 0600, temp-and-rename), three tries with backoff run
 * against the registry, and anything still unsettled stays in the file and is
 * drained on the next boot. The cost of the belt-and-braces is one small file;
 * the cost of not having it is somebody's money.
 *
 * IDEMPOTENT BY RECEIPT. The rail's own reference is the key, in the file and
 * on the wire — a drain that runs beside a live settle cannot report the same
 * charge twice, and the registry's own `already_seated` is read as DONE rather
 * than as a failure to retry forever.
 */

/** One reported purchase, waiting for cookrew.dev to acknowledge it. */
export interface UnsettledSeat {
  /** `@owner/team` — the door the seat is for. */
  team: string
  /** Who paid, with no `@`. */
  username: string
  by: 'stripe' | 'x402'
  /** The rail's own reference. The key, here and at the registry. */
  receipt: string
  /** Epoch ms the money moved. */
  at: number
  /** How many times we have asked cookrew.dev to record it. */
  tries: number
}

/** Where unsettled receipts wait. `base` exists so tests never touch a real home. */
export function unsettledSeatsPath(base?: string): string {
  return path.join(base ?? path.join(homedir(), '.cookrew'), 'seats-unsettled.json')
}

/** Three tries, then the file keeps it for the next boot. */
export const SETTLE_TRIES = 3
/** 1s, 4s, 9s. Quadratic rather than doubling: three tries, ~14s, then disk. */
export const settleBackoffMs = (attempt: number): number => attempt * attempt * 1000

/** The one call this queue makes. Narrow so a test needs no registry. */
export interface SeatSettleApi {
  settle(
    team: string,
    input: { username: string; by: 'stripe' | 'x402'; receipt: string }
  ): Promise<AccountResult<SeatFace>>
}

export interface SeatSettleDeps {
  seats: SeatSettleApi
  /** Directory holding seats-unsettled.json. Defaults to ~/.cookrew. */
  base?: string
  now?: () => number
  /** Injected so a test does not wait fourteen seconds to prove a backoff. */
  sleep?: (ms: number) => Promise<void>
  tries?: number
  /** Told about a purchase we could not report, so it is never silent. */
  onStuck?: (entry: UnsettledSeat) => void
}

function looksUnsettled(value: unknown): value is UnsettledSeat {
  if (typeof value !== 'object' || value === null) return false
  const row = value as Record<string, unknown>
  return (
    typeof row.team === 'string' &&
    typeof row.username === 'string' &&
    (row.by === 'stripe' || row.by === 'x402') &&
    typeof row.receipt === 'string' &&
    row.receipt.length > 0
  )
}

/** Read the file, or an empty queue. A corrupt file loses nothing else. */
export function loadUnsettled(base?: string): readonly UnsettledSeat[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(unsettledSeatsPath(base), 'utf8'))
    if (!Array.isArray(parsed)) return []
    return parsed.filter(looksUnsettled).map((row) => ({
      ...row,
      at: typeof row.at === 'number' ? row.at : 0,
      tries: typeof row.tries === 'number' ? row.tries : 0
    }))
  } catch {
    return []
  }
}

/** Publish the queue: 0600, temp-and-rename. It names who paid what. */
export function writeUnsettled(entries: readonly UnsettledSeat[], base?: string): void {
  const file = unsettledSeatsPath(base)
  const temp = `${file}.tmp`
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  writeFileSync(temp, `${JSON.stringify(entries, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  chmodSync(temp, 0o600)
  try {
    renameSync(temp, file)
  } catch (error) {
    rmSync(temp, { force: true })
    throw error
  }
}

/**
 * Refusals it is pointless to retry.
 *
 * `not_found` is the registry saying nobody holds that username — retrying
 * cannot make one exist. Everything else (offline, rate_limited, an expired
 * session, a 5xx) is a state that ends, so the receipt stays on disk.
 * `already_seated` never reaches here as a failure: see `settleOnce`.
 */
const HOPELESS: ReadonlySet<string> = new Set(['not_found', 'bad_username'])

export class SeatSettleQueue {
  private readonly deps: SeatSettleDeps
  private readonly tries: number
  private draining = false

  constructor(deps: SeatSettleDeps) {
    this.deps = deps
    this.tries = deps.tries ?? SETTLE_TRIES
  }

  /** What is still owed to cookrew.dev, oldest first. */
  pending(): readonly UnsettledSeat[] {
    return loadUnsettled(this.deps.base)
  }

  /**
   * A caller just paid. TO DISK FIRST, then to the registry.
   *
   * Returns when the report is settled or has run out of tries — the caller's
   * admission does not wait on it, because the money has already moved and a
   * slow registry must not hold a door shut.
   */
  async record(input: {
    team: string
    username: string
    by: 'stripe' | 'x402'
    receipt: string
  }): Promise<boolean> {
    const now = this.deps.now?.() ?? Date.now()
    const entry: UnsettledSeat = { ...input, at: now, tries: 0 }
    const queue = loadUnsettled(this.deps.base)
    // Idempotent by receipt: a retried admission with the same charge is one
    // purchase, and two rows would be two seats reported for one dollar.
    if (!queue.some((row) => row.receipt === entry.receipt)) {
      writeUnsettled([...queue, entry], this.deps.base)
    }
    return this.attempt(entry)
  }

  /** Everything the last run could not report. Called once at boot. */
  async drain(): Promise<number> {
    if (this.draining) return 0
    this.draining = true
    try {
      let settled = 0
      for (const entry of loadUnsettled(this.deps.base)) {
        if (await this.attempt(entry)) settled += 1
      }
      return settled
    } finally {
      this.draining = false
    }
  }

  /** One receipt, up to `tries` times, with a backoff between them. */
  private async attempt(entry: UnsettledSeat): Promise<boolean> {
    const sleep = this.deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)))
    for (let attempt = 1; attempt <= this.tries; attempt += 1) {
      const outcome = await this.settleOnce(entry)
      this.bump(entry.receipt)
      if (outcome === 'done') {
        this.drop(entry.receipt)
        return true
      }
      if (outcome === 'hopeless') {
        // Dropped, and said out loud. Keeping it would mean draining a receipt
        // nobody can act on at every boot, forever.
        this.drop(entry.receipt)
        this.deps.onStuck?.(entry)
        return false
      }
      if (attempt < this.tries) await sleep(settleBackoffMs(attempt))
    }
    this.deps.onStuck?.(entry)
    return false
  }

  private async settleOnce(entry: UnsettledSeat): Promise<'done' | 'retry' | 'hopeless'> {
    let result: AccountResult<SeatFace>
    try {
      result = await this.deps.seats.settle(entry.team, {
        username: entry.username,
        by: entry.by,
        receipt: entry.receipt
      })
    } catch {
      return 'retry'
    }
    if (result.ok) return 'done'
    // ALREADY SEATED IS SUCCESS. The registry answers 409 when this person
    // already holds a seat at this team — which is exactly what we were asking
    // it to make true. Retrying it would be asking again for a thing that is
    // already so, at every boot, for as long as the seat lasts.
    if (result.reason === 'already_seated') return 'done'
    return HOPELESS.has(result.reason) ? 'hopeless' : 'retry'
  }

  private drop(receipt: string): void {
    writeUnsettled(
      loadUnsettled(this.deps.base).filter((row) => row.receipt !== receipt),
      this.deps.base
    )
  }

  private bump(receipt: string): void {
    const queue = loadUnsettled(this.deps.base)
    if (!queue.some((row) => row.receipt === receipt)) return
    writeUnsettled(
      queue.map((row) => (row.receipt === receipt ? { ...row, tries: row.tries + 1 } : row)),
      this.deps.base
    )
  }
}
