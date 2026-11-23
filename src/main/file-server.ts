import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'
import { inside, safeRelative } from '../shared/shared-roots'
import { mimeOf } from './artifact-view'

/**
 * THIS COMPUTER AS A FILE SOURCE FOR ITS OWN DEVICES (owner, 2026-11-23).
 *
 * A person looking at what an agent made should not need the screen streamed to
 * them. The bytes travel instead, over the sealed link, and the device draws or
 * saves them locally. This module is the serving half: what folders exist, what
 * is in one, and one file's bytes.
 *
 * WHAT MAY BE READ IS THE OWNER'S LIST, never the client's: a request names a
 * root that must already be shared, and a relative path that is resolved (links
 * followed) and then checked to still be inside that root. `..` is refused before
 * anything touches the disk. A directory listing shows names, never follows them.
 *
 * Sizes are capped, and a refusal says which kind it was, in words a card can
 * show. Nothing here writes.
 */

/** A file this big is not something to look at on a phone. */
export const FILE_MAX_BYTES = 64 * 1024 * 1024
/** A listing stops here and says it did. */
export const FILE_LIST_MAX = 2_000

export interface FileRoot {
  /** The path as shared (absolute). */
  readonly path: string
  /** What to call it on a device: its own folder name. */
  readonly name: string
}

export interface FileEntry {
  readonly name: string
  readonly kind: 'dir' | 'file' | 'other'
  readonly size: number
  readonly mtimeMs: number
  /** For a file, by extension: what a device should do with it. */
  readonly mime?: string
}

export type FilesRefusal = { readonly error: 'outside' | 'missing' | 'not-file' | 'not-dir' | 'too-large' | 'unreadable'; readonly why: string }

const REFUSALS: Readonly<Record<FilesRefusal['error'], string>> = {
  outside: 'That file is outside the folders this computer shares.',
  missing: 'That file is no longer on this computer.',
  'not-file': 'That is not a file.',
  'not-dir': 'That is not a folder.',
  'too-large': `That file is larger than ${Math.round(FILE_MAX_BYTES / 1024 / 1024)} MB, so it is not sent to this device.`,
  unreadable: 'That file cannot be read right now.'
}

export const refusal = (error: FilesRefusal['error']): FilesRefusal => ({ error, why: REFUSALS[error] })

export interface FileDeps {
  readonly realpath?: (file: string) => string
  readonly stat?: (file: string) => { readonly size: number; readonly mtimeMs: number; isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }
  readonly readdir?: (dir: string) => string[]
  readonly read?: (file: string) => Buffer
  readonly maxBytes?: number
}

const depsOf = (deps: FileDeps) => ({
  realpath: deps.realpath ?? ((file: string) => realpathSync(file)),
  stat: deps.stat ?? ((file: string) => statSync(file)),
  readdir: deps.readdir ?? ((dir: string) => readdirSync(dir)),
  read: deps.read ?? ((file: string) => readFileSync(file)),
  maxBytes: deps.maxBytes ?? FILE_MAX_BYTES
})

/** The roots as a device sees them: the path it names back, and a name to show. */
export function fileRoots(paths: readonly string[]): FileRoot[] {
  return paths.map((p) => ({ path: p, name: path.basename(p) || p }))
}

/**
 * Resolve a request's root and relative path to a real path, or refuse. The root
 * must be one of `shared` (compared after resolving); the child must still be
 * inside it after links are followed.
 */
export function resolveShared(
  shared: readonly string[],
  root: string,
  rel: string,
  deps: FileDeps = {}
): { ok: true; root: string; file: string } | { ok: false; refusal: FilesRefusal } {
  const d = depsOf(deps)
  const safe = safeRelative(rel)
  if (safe === null) return { ok: false, refusal: refusal('outside') }
  let realRoot: string
  let matched = false
  for (const candidate of shared) {
    if (candidate !== root) continue
    try {
      realRoot = d.realpath(candidate)
      matched = true
      break
    } catch {
      return { ok: false, refusal: refusal('missing') }
    }
  }
  if (!matched) return { ok: false, refusal: refusal('outside') }
  let real: string
  try {
    real = d.realpath(safe === '' ? realRoot! : path.join(realRoot!, safe))
  } catch {
    return { ok: false, refusal: refusal('missing') }
  }
  if (!inside(realRoot!, real)) return { ok: false, refusal: refusal('outside') }
  return { ok: true, root: realRoot!, file: real }
}

export interface Listing {
  readonly path: string
  readonly entries: readonly FileEntry[]
  readonly truncated: boolean
}

/** One folder, as a device draws it. Names only: a link is listed, never followed. */
export function listFolder(shared: readonly string[], root: string, rel: string, deps: FileDeps = {}): Listing | FilesRefusal {
  const d = depsOf(deps)
  const at = resolveShared(shared, root, rel, deps)
  if (!at.ok) return at.refusal
  let facts
  try {
    facts = d.stat(at.file)
  } catch {
    return refusal('missing')
  }
  if (!facts.isDirectory()) return refusal('not-dir')
  let names: string[]
  try {
    names = d.readdir(at.file)
  } catch {
    return refusal('unreadable')
  }
  const entries: FileEntry[] = []
  let truncated = false
  for (const name of [...names].sort((a, b) => a.localeCompare(b))) {
    if (entries.length >= FILE_LIST_MAX) {
      truncated = true
      break
    }
    let one
    try {
      one = d.stat(path.join(at.file, name))
    } catch {
      continue
    }
    const kind = one.isDirectory() ? 'dir' : one.isFile() ? 'file' : 'other'
    entries.push({
      name,
      kind,
      size: one.isFile() ? one.size : 0,
      mtimeMs: one.mtimeMs,
      ...(kind === 'file' ? { mime: mimeOf(name) } : {})
    })
  }
  return { path: rel, entries, truncated }
}

export interface FileBytes {
  readonly name: string
  readonly mime: string
  readonly hash: string
  readonly size: number
  readonly mtimeMs: number
  readonly bytes: Buffer
}

/** One file's bytes, with what a device needs to cache and to draw it. */
export function readShared(shared: readonly string[], root: string, rel: string, deps: FileDeps = {}): FileBytes | FilesRefusal {
  const d = depsOf(deps)
  const at = resolveShared(shared, root, rel, deps)
  if (!at.ok) return at.refusal
  let facts
  try {
    facts = d.stat(at.file)
  } catch {
    return refusal('missing')
  }
  if (!facts.isFile()) return refusal('not-file')
  if (facts.size > d.maxBytes) return refusal('too-large')
  let bytes: Buffer
  try {
    bytes = d.read(at.file)
  } catch {
    return refusal('unreadable')
  }
  return {
    name: path.basename(at.file),
    mime: mimeOf(at.file),
    hash: createHash('sha256').update(bytes).digest('hex'),
    size: bytes.length,
    mtimeMs: facts.mtimeMs,
    bytes
  }
}

export const isRefusal = <T extends object>(value: T | FilesRefusal): value is FilesRefusal => 'error' in value
