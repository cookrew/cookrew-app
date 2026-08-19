import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { writeFileAtomic } from './turn-annotations'
import { blobId, publicKeyFromId, verifyManifest } from './preset-publish'
import type { PresetManifest } from '../shared/preset-manifest'
import type { InstalledPreset } from '../shared/preset-chip'
import type { TeamSnapshot } from './teams'

/**
 * INSTALLED PRESETS (~/.cookrew/presets/<id>/) — manifest.json beside the
 * blobs it addresses. One directory per preset id, and because the id IS the
 * content address of team.json, two versions of the same preset are simply two
 * directories: installing v3 never has to mutate v2's bytes.
 *
 * A2 lives here. This store is a CACHE of things the buyer already owns, not a
 * dependency of anything placed: a preset on the canvas is a plain terminal (or
 * an ordinary pasted team), so removing a directory from here can never reach
 * into a workspace and break it. That is why uninstall is a directory delete
 * and nothing more — there is deliberately no bookkeeping tying a placed node
 * back to the preset it came from, because such a link is exactly what would
 * make an uninstall able to break a canvas.
 */

const PRESETS_DIR = 'presets'

/**
 * A preset id is a CONTENT ADDRESS, and the only one this store will touch.
 * It arrives from the renderer, and the path it used to build ended in
 * rmSync(recursive, force) — so an id like '../../../../tmp/victim' was a
 * delete-anything primitive. Validated here, at the IPC boundary, and again
 * by a containment check below: three places, because one of them being
 * bypassed must not be enough.
 */
const PRESET_ID = /^sha256:[0-9a-f]{64}$/
/** The on-disk form. Parsed explicitly rather than by splitting on a hyphen. */
const PRESET_DIR = /^sha256-([0-9a-f]{64})$/

export function isPresetId(id: string): boolean {
  return typeof id === 'string' && PRESET_ID.test(id)
}

export interface StoredPreset {
  manifest: PresetManifest
  teamBytes: Buffer
}

export class PresetStore {
  private readonly root: string

  /** Base defaults to ~/.cookrew so tests can run against a temp directory. */
  constructor(base: string = path.join(homedir(), '.cookrew')) {
    this.root = path.join(base, PRESETS_DIR)
  }

  /**
   * The directory for an id, or null if the id is not a content address or the
   * resulting path would leave the store. Every caller treats null as "not
   * installed", so a hostile id is indistinguishable from an absent one — it
   * gets no error to probe with and no path to escape through.
   */
  private dirFor(id: string): string | null {
    if (!isPresetId(id)) return null
    const dir = path.resolve(path.join(this.root, `sha256-${id.slice('sha256:'.length)}`))
    const root = path.resolve(this.root)
    // Belt to the regex's braces: even if the pattern were loosened later, a
    // path outside the store is refused.
    if (dir !== root && !dir.startsWith(root + path.sep)) return null
    return dir
  }

  /**
   * Persist a verified preset. Idempotent by content address: re-installing the
   * same bytes rewrites the same two files, so a retried download cannot
   * produce a duplicate chip.
   */
  install(preset: StoredPreset, options: { entitled?: boolean } = {}): void {
    const dir = this.dirFor(preset.manifest.id)
    if (dir === null) throw new Error(`refusing to install a preset with a non-address id`)
    mkdirSync(dir, { recursive: true })
    writeFileAtomic(path.join(dir, 'team.json'), preset.teamBytes)
    writeFileAtomic(path.join(dir, 'manifest.json'), JSON.stringify(preset.manifest, null, 2))
    // H2: PIN THE AUTHOR KEY. Hash self-consistency proves only that a manifest
    // agrees with the blob beside it — an attacker with write access to
    // ~/.cookrew can tamper with both and re-sign under their own key, and a
    // store that trusts disk accepts it. Recording the key the preset actually
    // verified under at install time turns every later read into a real
    // signature check against a key the attacker does not hold.
    writeFileAtomic(path.join(dir, 'author.pub'), preset.manifest.author.keyId)
    // install.json holds LOCAL state about a preset rather than anything the
    // author signed — today just entitlement. It is a CACHE of the gate's last
    // word, never the authority: when the gate lands, a 403 overrides whatever
    // is written here, and nothing may treat a local `true` as proof of a
    // licence. It exists now because otherwise the lock badge is unreachable
    // and nobody can build or test the gated chip.
    if (options.entitled === false) {
      writeFileAtomic(path.join(dir, 'install.json'), JSON.stringify({ entitled: false }, null, 2))
    }
  }

  /** Local entitlement cache; absent file means owned (the common case). */
  private entitledOf(dir: string): boolean {
    try {
      const raw = JSON.parse(readFileSync(path.join(dir, 'install.json'), 'utf8')) as {
        entitled?: unknown
      }
      return raw.entitled !== false
    } catch {
      return true
    }
  }

  /**
   * Read a preset back. Null when absent OR when the blob no longer matches the
   * manifest that addresses it — a half-written install and a tampered cache
   * are the same thing to a caller, and both must fail closed rather than hand
   * back bytes nobody signed.
   */
  read(id: string): StoredPreset | null {
    const dir = this.dirFor(id)
    if (dir === null) return null
    try {
      const manifest = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as PresetManifest
      const teamBytes = readFileSync(path.join(dir, 'team.json'))
      if (typeof manifest?.id !== 'string') return null
      if (blobId(teamBytes) !== manifest.id) return null
      // H2: the signature, against the key pinned at install. Without this the
      // check above proves only self-consistency, which anyone who can write
      // the directory can manufacture.
      const pinned = readFileSync(path.join(dir, 'author.pub'), 'utf8').trim()
      if (pinned.length === 0 || manifest.author.keyId !== pinned) return null
      if (!verifyManifest(manifest, publicKeyFromId(pinned))) return null
      return { manifest, teamBytes }
    } catch {
      return null
    }
  }

  /**
   * The dock's chip source. A corrupt or tampered entry is SKIPPED rather than
   * thrown: one bad directory must not take the whole chip row — and therefore
   * the whole TERMINAL placement row — down with it.
   */
  list(): InstalledPreset[] {
    let entries: string[]
    try {
      entries = readdirSync(this.root)
    } catch {
      return []
    }
    const out: InstalledPreset[] = []
    for (const entry of entries) {
      // M7: parse the directory name explicitly. Splitting on the first hyphen
      // turned any stray directory into a candidate id.
      const match = PRESET_DIR.exec(entry)
      if (match === null) continue
      const id = `sha256:${match[1]}`
      const stored = this.read(id)
      if (stored === null) continue
      let snapshot: TeamSnapshot
      try {
        snapshot = JSON.parse(stored.teamBytes.toString('utf8')) as TeamSnapshot
      } catch {
        continue
      }
      const members = (snapshot.nodes ?? [])
        .filter((n) => n.kind === 'terminal')
        .map((n) => (n as { preset: string }).preset)
      out.push({
        id: stored.manifest.id,
        name: snapshot.name,
        version: stored.manifest.version,
        members,
        // Local cache of the gate's last word (see install.json). The gate
        // supersedes it the moment it exists.
        entitled: this.entitledOf(path.join(this.root, entry))
        // headVersion is deliberately absent — it is a live HEAD answer (R3),
        // not something to persist and serve stale.
      })
    }
    return out
  }

  /**
   * Remove a preset. A directory delete and nothing else: placed agents are
   * plain canvas nodes with no link back here, so this cannot reach them (A2).
   * Absent id → no-op, because uninstalling something already gone is the
   * outcome the caller wanted.
   */
  uninstall(id: string): void {
    // C1: a non-address id resolves to null and deletes NOTHING. This call
    // ends in a recursive force-delete, so the validation above is the only
    // thing standing between a renderer string and an arbitrary rmSync.
    const dir = this.dirFor(id)
    if (dir === null || !existsSync(dir)) return
    rmSync(dir, { recursive: true, force: true })
  }
}
