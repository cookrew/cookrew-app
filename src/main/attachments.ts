import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { sanitizeAttachmentName } from '../shared/attach'

/** Hard cap for a single uploaded attachment (decoded bytes). */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024

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
