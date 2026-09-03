import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/**
 * STARS — one per account per served team.
 *
 * A star is a sort key for the market and nothing else. It never gates a
 * session, never prices one and never ranks the door's answer; the ladder a
 * caller climbs at the door (401 · 402 · 403) is the whole business logic and
 * a star is not a rung of it.
 *
 * Recorded under the ACCOUNT that made it — the registry handle the passkey
 * proved — so a star cannot be farmed by refreshing, and so "what did I star"
 * is a question with one answer across every machine that account uses.
 */

const HANDLE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/
const NAME = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/

export interface StarRecord {
  account: string
  /** `handle/name`, the door's canonical path without the leading slash. */
  team: string
  at: number
}

export class StarStore {
  private readonly file: string
  /** team → account → when it was starred */
  private readonly byTeam = new Map<string, Map<string, number>>()
  /** Strictly increasing, so two stars in one millisecond still have an order. */
  private last = 0

  constructor(dataDir: string) {
    this.file = path.join(dataDir, 'stars.json')
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.file, 'utf8'))
      if (Array.isArray(parsed)) {
        for (const entry of parsed as StarRecord[]) {
          if (typeof entry.account !== 'string' || typeof entry.team !== 'string') continue
          const at = typeof entry.at === 'number' ? entry.at : 0
          this.last = Math.max(this.last, at)
          this.accountsOf(entry.team).set(entry.account, at)
        }
      }
    } catch {
      // No file is the ordinary case for a fresh registry.
    }
  }

  /** Flip one account's star on one team. Null when any name is malformed. */
  toggle(account: string, handle: string, name: string): { stars: number; starred: boolean } | null {
    if (!HANDLE.test(account) || !HANDLE.test(handle) || !NAME.test(name)) return null
    const team = `${handle}/${name}`
    const accounts = this.accountsOf(team)
    const starred = !accounts.has(account)
    if (starred) accounts.set(account, this.tick())
    else accounts.delete(account)
    this.flush()
    return { stars: accounts.size, starred }
  }

  count(handle: string, name: string): number {
    return this.byTeam.get(`${handle}/${name}`)?.size ?? 0
  }

  starred(account: string, handle: string, name: string): boolean {
    return this.byTeam.get(`${handle}/${name}`)?.has(account) ?? false
  }

  /** Teams one account starred, newest first. */
  byAccount(account: string): string[] {
    const mine: { team: string; at: number }[] = []
    for (const [team, accounts] of this.byTeam) {
      const at = accounts.get(account)
      if (at !== undefined) mine.push({ team, at })
    }
    return mine.sort((a, b) => b.at - a.at || a.team.localeCompare(b.team)).map((m) => m.team)
  }

  private tick(): number {
    this.last = Math.max(Date.now(), this.last + 1)
    return this.last
  }

  private accountsOf(team: string): Map<string, number> {
    const existing = this.byTeam.get(team)
    if (existing) return existing
    const fresh = new Map<string, number>()
    this.byTeam.set(team, fresh)
    return fresh
  }

  /** Written whole and renamed, so a reader never sees a torn file. */
  private flush(): void {
    const records: StarRecord[] = []
    for (const [team, accounts] of this.byTeam) {
      for (const [account, at] of accounts) records.push({ account, team, at })
    }
    mkdirSync(path.dirname(this.file), { recursive: true })
    const tmp = `${this.file}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(records))
    renameSync(tmp, this.file)
  }
}
