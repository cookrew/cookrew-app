import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { canonicalJson } from '../../src/shared/preset-manifest'

/**
 * TRANSPARENCY LOG (P2-A1) — append-only JSONL, hash-chained.
 *
 * WHAT IT GUARANTEES, narrowly, per the approved design note: the registry
 * cannot quietly rewrite what a client already saw. Anyone who kept an earlier
 * head can replay forward and detect an edit or an omission, because every
 * record commits to its predecessor.
 *
 * WHAT IT DOES NOT: prove honesty. A single-operator log can still be FORKED —
 * two readers served two consistent-but-different histories — and nothing here
 * detects that. Witness co-signing and gossip are M3. Stated because a log that
 * is described as tamper-proof gets trusted like one.
 */

export type LogKind = 'publish' | 'key-rotation'

export interface LogRecord {
  seq: number
  at: number
  kind: LogKind
  presetId: string
  version: number
  authorKeyId: string
  identityId: string
  /** WebAuthn assertion binding the identity to the author key (A3). */
  countersig?: string
  /** Hash of the previous record; the empty string for the first. */
  prev: string
  /** sha256 over the canonical form of this record WITHOUT this field. */
  hash: string
}

/** The chain hash for a record, computed over everything but the hash itself. */
export function hashRecord(record: Omit<LogRecord, 'hash'>): string {
  // Canonicalised with the SAME function the manifests use, so a record hashes
  // identically wherever it is checked — a second canonical form here would let
  // the server and a replaying client disagree about a valid chain.
  return `sha256:${createHash('sha256').update(canonicalJson(record)).digest('hex')}`
}

/**
 * Verify a chain. Returns the index of the first broken record, or null when
 * every link holds. Exported because a client replaying the log runs exactly
 * this — the check is not a server-side privilege.
 */
export function verifyChain(records: readonly LogRecord[]): number | null {
  let prev = ''
  for (let i = 0; i < records.length; i++) {
    const { hash, ...rest } = records[i]
    if (rest.seq !== i + 1) return i
    if (rest.prev !== prev) return i
    if (hashRecord(rest) !== hash) return i
    prev = hash
  }
  return null
}

export class TransparencyLog {
  private readonly file: string

  constructor(base: string) {
    mkdirSync(base, { recursive: true })
    this.file = path.join(base, 'log.jsonl')
  }

  /** Every record, oldest first. A malformed line truncates the read. */
  all(): LogRecord[] {
    if (!existsSync(this.file)) return []
    const out: LogRecord[] = []
    for (const line of readFileSync(this.file, 'utf8').split('\n')) {
      if (line.trim().length === 0) continue
      try {
        out.push(JSON.parse(line) as LogRecord)
      } catch {
        // A truncated tail is the expected shape of a crash mid-append. Stop
        // rather than skip: records after a gap have a prev that no longer
        // chains, and serving them would look like tampering.
        break
      }
    }
    return out
  }

  /** Records from a sequence number, for a client catching up. */
  from(seq: number): LogRecord[] {
    return this.all().filter((r) => r.seq >= seq)
  }

  head(): LogRecord | null {
    const all = this.all()
    return all.length > 0 ? all[all.length - 1] : null
  }

  /**
   * Append a record, chained to the current head. Returns what was written.
   * The caller supplies facts; seq, prev and hash are the log's to assign, so
   * no caller can place a record out of order or claim a predecessor.
   */
  append(entry: Omit<LogRecord, 'seq' | 'prev' | 'hash'>): LogRecord {
    const head = this.head()
    const body: Omit<LogRecord, 'hash'> = {
      ...entry,
      seq: (head?.seq ?? 0) + 1,
      prev: head?.hash ?? ''
    }
    const record: LogRecord = { ...body, hash: hashRecord(body) }
    appendFileSync(this.file, `${JSON.stringify(record)}\n`)
    return record
  }
}
