import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

/**
 * THE DOCK'S CREWS — remote crews this user added by link (import side).
 *
 * A crew in this store is a CHIP, nothing more: adding is free and inert
 * (commitment happens at the gate, money at the sheet, connection at
 * placement). The record carries the public face fetched at add time plus the
 * one thing the gate produces here in M1 — a dev payment reference — so a
 * locked chip knows it is unlocked.
 *
 * Persisted as JSON under ~/.cookrew: a dock that forgot its crews on restart
 * would gaslight the user. No private keys live here — the card's sign-in key
 * is created and held by the card's own script, out of this store entirely.
 */
export interface RemoteCrew {
  id: string
  /** `http(s)://host:port` — where the serving app answers. */
  origin: string
  slug: string
  /** The public face, captured at add. */
  name: string
  door: string
  access: 'account' | 'paid'
  priceUsd?: string
  version: number
  agents: number
  addedAt: number
  /** Dev payment reference from the gate sheet; presence = the chip is unlocked. */
  payRef?: string
  /** The author stopped serving (a fetch failed with gone); the chip dims. */
  ended?: boolean
}

export class RemoteCrewStore {
  private readonly file: string
  private crews: RemoteCrew[] = []

  constructor(base: string = path.join(homedir(), '.cookrew')) {
    this.file = path.join(base, 'remote-crews.json')
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8'))
      if (Array.isArray(parsed)) this.crews = parsed
    } catch {
      this.crews = []
    }
  }

  list(): readonly RemoteCrew[] {
    return [...this.crews]
  }

  get(id: string): RemoteCrew | null {
    return this.crews.find((c) => c.id === id) ?? null
  }

  add(input: Omit<RemoteCrew, 'id' | 'addedAt'>): RemoteCrew {
    // Re-adding the same address refreshes the face instead of duplicating the
    // chip — a dock with two chips for one crew is a question with two answers.
    const existing = this.crews.find((c) => c.origin === input.origin && c.slug === input.slug)
    const crew: RemoteCrew = existing
      ? { ...existing, ...input, ended: false }
      : { ...input, id: randomUUID(), addedAt: Date.now() }
    this.crews = [...this.crews.filter((c) => c.id !== crew.id), crew]
    this.save()
    return crew
  }

  /** Merge a patch into one crew (payRef after the gate, ended on a dead link). */
  patch(id: string, changes: Partial<Pick<RemoteCrew, 'payRef' | 'ended'>>): RemoteCrew | null {
    const crew = this.get(id)
    if (!crew) return null
    const next = { ...crew, ...changes }
    this.crews = this.crews.map((c) => (c.id === id ? next : c))
    this.save()
    return next
  }

  remove(id: string): void {
    this.crews = this.crews.filter((c) => c.id !== id)
    this.save()
  }

  private save(): void {
    mkdirSync(path.dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify(this.crews, null, 2))
    renameSync(tmp, this.file)
  }
}

/**
 * Parse what a user pastes into ADD A CREW. Accepts a bare `host:port/slug`,
 * a full URL, or a local `/slug` (same machine, the dogfood loop). Returns
 * null for anything that does not name exactly an origin + one slug segment.
 */
export function parseCrewLink(raw: string): { origin: string; slug: string } | null {
  const trimmed = raw.trim()
  if (trimmed.length === 0) return null
  const withScheme = /^https?:\/\//.test(trimmed)
    ? trimmed
    : trimmed.startsWith('/')
      ? `http://127.0.0.1:8639${trimmed}`
      : `http://${trimmed}`
  try {
    const url = new URL(withScheme)
    const segments = url.pathname.split('/').filter((s) => s.length > 0)
    if (segments.length !== 1) return null
    return { origin: url.origin, slug: segments[0] }
  } catch {
    return null
  }
}
