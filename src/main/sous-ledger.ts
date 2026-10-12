// THE SOUS LEDGER (HP round, lane hp-decide) — what Sous decided, what the
// owner answered, and how the delivery ended, one JSONL file the owner can
// read and nobody served can: ~/.cookrew/sous-decisions.jsonl, mode 0600,
// every string through scrub(), 30 days, folded by token on read (the newest
// row for a token wins field by field). The inbox's `sous` rows and RETRY are
// read from here, so a brief that never landed can be sent again from the
// text the owner actually saw — never from a pane, never from memory alone.

import { appendFileSync, chmodSync, existsSync, mkdirSync, openSync, closeSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { scrub } from './scrub'

export const SOUS_LEDGER_FILE = 'sous-decisions.jsonl'
export const SOUS_LEDGER_TTL_MS = 30 * 24 * 60 * 60 * 1000

export type SousOutcome = 'pending' | 'delivered' | 'failed' | 'interrupted' | 'cancelled' | 'expired'

/** One decision as the ledger knows it after folding. */
export interface SousLedgerRow {
  token: string
  at: number
  updatedAt: number
  sentence: string
  domain: string
  exposure: number
  mode: string
  /** The card or harness the decision went to, as shown. */
  target: { id: string; name: string } | null
  alternates: string[]
  ownerResponse: 'commit' | 'send-anyway' | 'cancel' | 'expired' | null
  dispatchId: string | null
  outcome: SousOutcome
  /** What RETRY re-sends: the sentence (+ its Boundaries line) as delivered. */
  proposalText: string | null
  /** The card the proposal was delivered to, for RETRY and the inbox row. */
  deliveredTo: string | null
  dismissed: boolean
}

/** A write: the token and whatever changed. Strings are scrubbed on the way in. */
export type SousLedgerPatch = Partial<Omit<SousLedgerRow, 'token' | 'updatedAt'>> & { token: string }

export function sousLedgerPath(home: string = homedir()): string {
  return path.join(home, '.cookrew', SOUS_LEDGER_FILE)
}

const scrubDeep = <T>(value: T): T => {
  if (typeof value === 'string') return scrub(value) as T
  if (Array.isArray(value)) return value.map(scrubDeep) as T
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, scrubDeep(v)])) as T
  return value
}

export class SousLedger extends EventEmitter {
  private readonly file: string
  private cache: { size: number; mtimeMs: number; rows: Map<string, SousLedgerRow> } | null = null

  constructor(file: string = sousLedgerPath(), private readonly now: () => number = Date.now) {
    super()
    this.file = file
  }

  path(): string {
    return this.file
  }

  /** Append one line, 0600 from the first byte; the directory is made 0700 if missing. */
  write(patch: SousLedgerPatch): void {
    const dir = path.dirname(this.file)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
    const fresh = !existsSync(this.file)
    if (fresh) closeSync(openSync(this.file, 'a', 0o600))
    chmodSync(this.file, 0o600)
    const line = JSON.stringify({ ...scrubDeep(patch), updatedAt: this.now() })
    appendFileSync(this.file, `${line}\n`, { mode: 0o600 })
    this.cache = null
    this.emit('change')
  }

  /** Every decision inside the TTL, folded by token, oldest first. */
  rows(): SousLedgerRow[] {
    return [...this.load().values()].sort((a, b) => a.at - b.at)
  }

  get(token: string): SousLedgerRow | undefined {
    return this.load().get(token)
  }

  dismiss(token: string): boolean {
    if (!this.load().has(token)) return false
    this.write({ token, dismissed: true })
    return true
  }

  /** The rows the inbox floats: a delivery that failed or was interrupted, not dismissed, with a proposal to re-send. */
  stuck(): SousLedgerRow[] {
    return this.rows().filter((r) => (r.outcome === 'failed' || r.outcome === 'interrupted') && !r.dismissed && r.proposalText !== null && r.deliveredTo !== null)
  }

  private load(): Map<string, SousLedgerRow> {
    let stat: { size: number; mtimeMs: number } | null = null
    try {
      const s = statSync(this.file)
      stat = { size: s.size, mtimeMs: s.mtimeMs }
    } catch {
      this.cache = null
      return new Map()
    }
    if (this.cache && this.cache.size === stat.size && this.cache.mtimeMs === stat.mtimeMs) return this.cache.rows
    const rows = new Map<string, SousLedgerRow>()
    const floor = this.now() - SOUS_LEDGER_TTL_MS
    for (const line of readFileSync(this.file, 'utf8').split('\n')) {
      if (!line.trim()) continue
      let patch: (SousLedgerPatch & { updatedAt?: number }) | null = null
      try {
        patch = JSON.parse(line) as SousLedgerPatch & { updatedAt?: number }
      } catch {
        continue
      }
      if (!patch || typeof patch.token !== 'string') continue
      const at = typeof patch.updatedAt === 'number' ? patch.updatedAt : 0
      const prior = rows.get(patch.token)
      const base: SousLedgerRow = prior ?? {
        token: patch.token,
        at: typeof patch.at === 'number' ? patch.at : at,
        updatedAt: at,
        sentence: '',
        domain: 'repo',
        exposure: 0,
        mode: 'ticking',
        target: null,
        alternates: [],
        ownerResponse: null,
        dispatchId: null,
        outcome: 'pending',
        proposalText: null,
        deliveredTo: null,
        dismissed: false
      }
      const { token: _t, updatedAt: _u, at: _a, ...fields } = patch
      void _t
      void _u
      void _a
      rows.set(patch.token, { ...base, ...fields, updatedAt: at })
    }
    for (const [token, row] of rows) if (row.updatedAt < floor) rows.delete(token)
    this.cache = { ...stat, rows }
    return rows
  }
}
