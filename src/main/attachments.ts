import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { sanitizeAttachmentName } from '../shared/attach'
import { MAX_ATTACHMENT_BYTES, SEALED_RELAY_BODY_MAX } from '../shared/attachment-limit'
import { splitSlugRoute } from './mobile-slug-route'

/** Hard cap for a single uploaded attachment (decoded bytes); the phone reads the same one. */
export { MAX_ATTACHMENT_BYTES }

/**
 * The largest body an attachment upload may carry on its way in: the save cap,
 * and at least 32 MB for a cached older phone bundle that still sends one as
 * base64 JSON (mobile-api.ts · ATTACH_BODY_LIMIT). The route holds the save
 * cap itself. Every other route keeps the relay's 4 MB.
 */
export const ATTACH_UPLOAD_MAX = Math.max(32 * 1024 * 1024, MAX_ATTACHMENT_BYTES)

/** How long an attachment may take to arrive: a sealed relay carries it in small POSTs, each a round trip. */
export const ATTACH_UPLOAD_MS = 10 * 60_000

/**
 * Is this request an attachment going up — the one route a phone sends
 * megabytes to? Read as the server's router reads it (mobile-slug-route.ts):
 * at the root, or under a workspace slug, the query aside. Any other first
 * segment is no route of the Mac's and keeps the small cap.
 */
export const isAttachUpload = (method: string, path: string): boolean => {
  if (method.toUpperCase() !== 'POST') return false
  const pathname = path.split(/[?#]/)[0]
  return pathname === '/api/attachments' || splitSlugRoute(pathname).pathname === '/api/attachments'
}

/**
 * THE SEALED RELAY'S ATTACHMENTS. The phone sends at most 25 MB there
 * (shared/attachment-limit.ts · SEALED_RELAY_LIMIT, compressed to fit); the
 * Mac takes a little more, never its whole save cap, and a session holds no
 * more than two of them arriving at once (seal2-serve-http.ts · SealBudget).
 */
export const SEALED_ATTACH_MAX = Math.max(32 * 1024 * 1024, SEALED_RELAY_BODY_MAX)
export const SEALED_ATTACH_BUDGET = 2 * SEALED_ATTACH_MAX

/** Where phone uploads land; agents receive the absolute path. */
export function defaultAttachmentsDir(): string {
  return path.join(homedir(), '.cookrew', 'attachments')
}

/**
 * Persist an uploaded attachment under `dir` and return its absolute path.
 * The name is sanitized (no traversal, no shell-hostile characters) and
 * deduplicated so an upload never clobbers an earlier one.
 */
export function saveAttachment(dir: string, name: string, data: Buffer): string {
  if (data.length > MAX_ATTACHMENT_BYTES) {
    throw new Error(`Attachment too large (max ${MAX_ATTACHMENT_BYTES / 1024 / 1024}MB)`)
  }
  mkdirSync(dir, { recursive: true })
  const target = freeTarget(dir, sanitizeAttachmentName(name))
  writeFileSync(target, data)
  return target
}

/** A path in `dir` nothing holds yet: `name`, or `name-2`, `name-3`, the extension kept. */
export function freeTarget(dir: string, name: string): string {
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  let target = path.join(dir, name)
  for (let n = 2; existsSync(target); n += 1) {
    target = path.join(dir, `${stem}-${n}${ext}`)
  }
  return target
}
