import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import path from 'node:path'
import { canonicalJson, type PresetManifest } from '../../src/shared/preset-manifest'

/**
 * REGISTRY STORE (P2-A1) — content-addressed blobs and the manifests that name
 * them. A2: the server is dumb. Nothing here decides who may have something;
 * that is authorize()'s job alone. This only answers "do these bytes exist".
 *
 * Every address is validated before it becomes a path. That is a direct
 * carry-forward of the client review's C1: the same shape of bug (an
 * unvalidated address used to build a filename) was a delete-anything primitive
 * there, and here it would be a read-anything primitive — the server hands the
 * bytes to whoever asked. Neither is acceptable and the fix is the same one.
 */

/** `sha256:<64 hex>` — the only address form this store will touch. */
const ADDRESS = /^sha256:[0-9a-f]{64}$/
/** The on-disk form. Parsed explicitly, never by splitting on a separator. */
const FILENAME = /^([0-9a-f]{64})\.json$/

export function isAddress(value: string): boolean {
  return typeof value === 'string' && ADDRESS.test(value)
}

export function addressOf(bytes: Buffer): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

/**
 * A preset as browse/search returns it. Derived from stored manifests — the
 * registry keeps no separate catalogue that could disagree with them.
 */
export interface PresetSummary {
  id: string
  name: string
  version: number
  author: string
  /** Public presets answer 200 to anyone; identified ones answer 401 first. */
  visibility: 'public' | 'identified'
  /**
   * Stable across versions, derived (see LINEAGE below) rather than stored, so
   * this needs no schema change to cookrew.preset/1.
   */
  lineage: string
  /** Highest version seen in this lineage — what a HEAD answers with (R3). */
  latestVersion: number
}

/**
 * LINEAGE — the identity that OWNS a preset, plus its name.
 *
 * `id` is the content address of team.json, so every version has a different
 * one and an id cannot answer "is there a newer". R3's update check needs
 * something that survives a version bump, and so does A3's TOFU.
 *
 * A1 derived this as (authorKeyId, name). That was WRONG, and A3 is what
 * exposed it: including the key makes "same lineage, different key" impossible
 * by construction, so a key rotation would silently start a NEW lineage — TOFU
 * could never refuse a swapped key, and a buyer holding v2 would never be
 * offered v3 because the update check would no longer recognise it as the same
 * preset. Two features fail the same way, quietly.
 *
 * The passkey identity is the durable owner; the ed25519 key is a credential it
 * holds and may rotate. So the identity keys the lineage and the author key
 * lives INSIDE it, which is exactly what makes a rotation expressible: the
 * lineage persists while its key changes, under a countersignature from the
 * identity that already held it.
 *
 * Still derived rather than added to the manifest — a schema field would need
 * every published manifest re-signed before the first update check could work.
 */
export function lineageOf(identityId: string, teamName: string): string {
  return `${identityId}::${teamName}`
}

interface StoredEntry {
  manifest: PresetManifest
  teamName: string
  visibility: 'public' | 'identified'
  /** The publishing identity — what keys the lineage. See lineageOf. */
  identityId: string
}

export class RegistryStore {
  private readonly blobs: string
  private readonly manifests: string

  constructor(base: string) {
    this.blobs = path.join(base, 'blobs')
    this.manifests = path.join(base, 'manifests')
    mkdirSync(this.blobs, { recursive: true })
    mkdirSync(this.manifests, { recursive: true })
  }

  /**
   * Resolve an address to a path inside `dir`, or null. Two independent
   * checks — the pattern, and a containment assert on the resolved path —
   * because one of them being loosened later must not be enough.
   */
  private pathFor(dir: string, address: string): string | null {
    if (!isAddress(address)) return null
    const file = path.resolve(path.join(dir, `${address.slice('sha256:'.length)}.json`))
    const root = path.resolve(dir)
    if (!file.startsWith(root + path.sep)) return null
    return file
  }

  /** Store bytes under their own address. Idempotent by construction. */
  putBlob(bytes: Buffer): string {
    const address = addressOf(bytes)
    const file = this.pathFor(this.blobs, address) as string
    // Write-then-rename so a reader never sees a half-written blob at an
    // address that promises exact content.
    const tmp = `${file}.tmp`
    writeFileSync(tmp, bytes)
    renameSync(tmp, file)
    return address
  }

  /**
   * Bytes for an address, or null. Verifies what it read still hashes to what
   * was asked for: a blob store that serves bytes under the wrong address is
   * worse than one that serves nothing, because the client's whole trust model
   * is that an address means its content.
   */
  getBlob(address: string): Buffer | null {
    const file = this.pathFor(this.blobs, address)
    if (file === null || !existsSync(file)) return null
    const bytes = readFileSync(file)
    if (addressOf(bytes) !== address) return null
    return bytes
  }

  putManifest(entry: StoredEntry): void {
    const file = this.pathFor(this.manifests, entry.manifest.id)
    if (file === null) throw new Error('refusing to store a manifest with a non-address id')
    const tmp = `${file}.tmp`
    writeFileSync(tmp, canonicalJson(entry))
    renameSync(tmp, file)
  }

  getManifest(id: string): PresetManifest | null {
    return this.entry(id)?.manifest ?? null
  }

  private entry(id: string): StoredEntry | null {
    const file = this.pathFor(this.manifests, id)
    if (file === null || !existsSync(file)) return null
    try {
      const entry = JSON.parse(readFileSync(file, 'utf8')) as StoredEntry
      // The id in the record must be the id it is filed under, or a rename
      // could make one manifest answer for another.
      if (entry?.manifest?.id !== id) return null
      return entry
    } catch {
      return null
    }
  }

  visibilityOf(id: string): 'public' | 'identified' | null {
    return this.entry(id)?.visibility ?? null
  }

  /**
   * The identity that published this preset, or null.
   *
   * M2 needs it to answer "who gets paid": the payout address is keyed to the
   * identity, not to the author key, because keys rotate (R20) and a payout
   * binding that rotated with them would go stale exactly when money was moving.
   */
  identityOf(id: string): string | null {
    return this.entry(id)?.identityId ?? null
  }

  /** Every stored preset, newest version first within a lineage. */
  list(): PresetSummary[] {
    let files: string[]
    try {
      files = readdirSync(this.manifests)
    } catch {
      return []
    }
    const entries: StoredEntry[] = []
    for (const file of files) {
      const match = FILENAME.exec(file)
      if (match === null) continue
      const entry = this.entry(`sha256:${match[1]}`)
      // A corrupt record is skipped, not thrown: one bad file must not empty
      // the whole catalogue.
      if (entry !== null) entries.push(entry)
    }
    const latest = new Map<string, number>()
    for (const e of entries) {
      const key = lineageOf(e.identityId, e.teamName)
      latest.set(key, Math.max(latest.get(key) ?? 0, e.manifest.version))
    }
    return entries
      .map((e) => ({
        id: e.manifest.id,
        name: e.teamName,
        version: e.manifest.version,
        author: e.manifest.author.handle,
        visibility: e.visibility,
        lineage: lineageOf(e.identityId, e.teamName),
        latestVersion: latest.get(lineageOf(e.identityId, e.teamName)) as number
      }))
      .sort((a, b) => a.name.localeCompare(b.name) || b.version - a.version)
  }

  /**
   * Substring match over name and author, case-insensitive. Deliberately not a
   * ranked index: M1 has a handful of presets, and a scoring function nobody
   * can explain is worse than an obvious one. An empty query lists everything.
   */
  search(query: string): PresetSummary[] {
    const q = query.trim().toLowerCase()
    if (q.length === 0) return this.list()
    return this.list().filter(
      (p) => p.name.toLowerCase().includes(q) || p.author.toLowerCase().includes(q)
    )
  }
}
