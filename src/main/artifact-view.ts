import { createHash } from 'node:crypto'
import { readFileSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'
import type { BrowserNodeData, CanvasNode, NoteNodeData, WorkspaceState } from '../shared/model'
import { activeBrowserTab } from '../shared/model'

/**
 * AN ARTIFACT, READ FOR A DEVICE TO SHOW ITSELF (owner, 2026-11-23).
 *
 * Most of the time a person on a phone or the console only wants to LOOK at
 * what an agent produced. Streaming the desktop's screen for that is expensive
 * and not native, so the bytes travel once over the plane the device already
 * has (relay or direct, sealed) and the device renders locally.
 *
 *   A NOTE travels as markdown: its text is already in the workspace snapshot,
 *   and this is the whole file rather than the card's head.
 *
 *   A FILE CARD travels as bytes, but only when the card points at a file ON
 *   THIS COMPUTER's disk under one of its workspace's own directories. The path
 *   is resolved and checked after following links, so a card cannot be used to
 *   read /etc or a person's keys. Nothing outside those roots is served.
 *
 *   A WEB PAGE is a link: the device opens it itself, natively.
 *
 * Size is capped rather than streamed: an artifact is something to look at, and
 * a 200 MB file is not that. A refusal says why, in words the card can show.
 */

export const ARTIFACT_MAX_BYTES = 16 * 1024 * 1024
/** A markdown body larger than this is a file to download, not a page to render. */
export const ARTIFACT_MAX_NOTE_BYTES = 2 * 1024 * 1024

export type ArtifactView =
  | { readonly kind: 'note'; readonly name: string; readonly title: string; readonly markdown: string }
  | { readonly kind: 'file'; readonly name: string; readonly mime: string; readonly hash: string; readonly bytes: Buffer }
  | { readonly kind: 'link'; readonly name: string; readonly url: string }
  | { readonly kind: 'unavailable'; readonly name: string; readonly why: string }

const MIME: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json',
  '.csv': 'text/csv; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav'
}

export const mimeOf = (file: string): string => MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream'

/** The card's own name, or its first line for a note. */
function nameOf(node: CanvasNode): string {
  if (node.kind === 'note') return node.customName ?? node.name
  return node.name
}

function noteTitle(node: NoteNodeData): string {
  const first = node.content.split('\n').find((line) => line.trim() !== '')
  return (first ?? '').replace(/^#+\s*/, '').trim() || nameOf(node)
}

/** The file a browser card is showing, when that file is on this disk. */
function localFileOf(node: BrowserNodeData): string | null {
  const url = activeBrowserTab(node)?.url ?? node.url
  if (typeof url !== 'string' || !url.startsWith('file://')) return null
  try {
    return decodeURIComponent(new URL(url).pathname)
  } catch {
    return null
  }
}

/** Real paths of the roots a card may read from: this workspace's own directories. */
function rootsOf(state: WorkspaceState, realpath: (file: string) => string): string[] {
  const dirs = [...(state.dirs ?? []), state.dir].filter((dir): dir is string => typeof dir === 'string' && dir !== '')
  const roots: string[] = []
  for (const dir of dirs) {
    try {
      roots.push(realpath(dir))
    } catch {
      // A directory that is gone cannot vouch for anything under it.
    }
  }
  return roots
}

const inside = (root: string, file: string): boolean => file === root || file.startsWith(`${root}${path.sep}`)

export interface ArtifactDeps {
  readonly read?: (file: string) => Buffer
  readonly realpath?: (file: string) => string
  readonly stat?: (file: string) => { readonly size: number; readonly isFile: () => boolean }
  readonly maxBytes?: number
}

/**
 * The artifact a card id names in this workspace, or null when there is no such
 * card. Everything the device is asked to render is decided here, on the
 * computer that holds the file.
 */
export function artifactView(state: WorkspaceState, id: string, deps: ArtifactDeps = {}): ArtifactView | null {
  const node = state.nodes.find((candidate) => candidate.id === id)
  if (node === undefined) return null
  const read = deps.read ?? ((file: string) => readFileSync(file))
  const realpath = deps.realpath ?? ((file: string) => realpathSync(file))
  const stat = deps.stat ?? ((file: string) => statSync(file))
  const maxBytes = deps.maxBytes ?? ARTIFACT_MAX_BYTES

  if (node.kind === 'note') {
    const bytes = Buffer.byteLength(node.content, 'utf8')
    if (bytes > ARTIFACT_MAX_NOTE_BYTES) {
      return { kind: 'unavailable', name: nameOf(node), why: 'This note is too large to show here; open it on the computer that holds it.' }
    }
    return { kind: 'note', name: nameOf(node), title: noteTitle(node), markdown: node.content }
  }

  // A terminal is not a document: it has a transcript, and that is the LIVE view's job.
  if (node.kind !== 'browser') {
    return { kind: 'unavailable', name: nameOf(node), why: 'This card is not showing a document.' }
  }

  const file = localFileOf(node)
  if (file === null) {
    const url = activeBrowserTab(node)?.url ?? node.url
    return typeof url === 'string' && /^https?:\/\//.test(url)
      ? { kind: 'link', name: nameOf(node), url }
      : { kind: 'unavailable', name: nameOf(node), why: 'This card is not showing a document.' }
  }

  let real: string
  try {
    real = realpath(file)
  } catch {
    return { kind: 'unavailable', name: nameOf(node), why: 'That file is no longer on the computer that made it.' }
  }
  if (!rootsOf(state, realpath).some((root) => inside(root, real))) {
    return { kind: 'unavailable', name: nameOf(node), why: 'That file is outside this workspace, so it is not sent to this device.' }
  }
  let facts
  try {
    facts = stat(real)
  } catch {
    return { kind: 'unavailable', name: nameOf(node), why: 'That file cannot be read right now.' }
  }
  if (!facts.isFile()) return { kind: 'unavailable', name: nameOf(node), why: 'That is not a file.' }
  if (facts.size > maxBytes) {
    return { kind: 'unavailable', name: nameOf(node), why: `That file is larger than ${Math.round(maxBytes / 1024 / 1024)} MB, so it is not sent to this device.` }
  }
  let bytes: Buffer
  try {
    bytes = read(real)
  } catch {
    return { kind: 'unavailable', name: nameOf(node), why: 'That file cannot be read right now.' }
  }
  const hash = createHash('sha256').update(bytes).digest('hex')
  return { kind: 'file', name: nameOf(node), mime: mimeOf(real), hash, bytes }
}
