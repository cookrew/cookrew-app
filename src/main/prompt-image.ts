import { open, readFile, realpath, stat, type FileHandle } from 'node:fs/promises'
import path from 'node:path'
import { imageMimeOf, imageRefKey, MAX_IMAGE_BYTES, type ImageBytes, type ImageRef } from '../shared/prompt-images'

/**
 * A PROMPT'S PICTURES, READ (owner, 2026-11-01: draw a prompt's screenshots in
 * the prompt box and the CHAT/LOG views, loaded lazily). See
 * shared/prompt-images.ts for the two kinds of picture a prompt carries.
 *
 * Read only when a view asks for one, which it does once the picture comes
 * into view — never as part of the stream, whose blocks carry where a picture
 * is and never its bytes.
 *
 * WHAT A CALLER MAY READ. The desktop's own renderer is the owner at the
 * owner's machine (`trusted`): any image file a prompt names. Over HTTP the
 * reach is narrower: a path only inside the attach store (where the prompt
 * box's screenshots and every phone upload land), and an image block only out
 * of a session file that is one of THAT card's own — never a path the caller
 * names into some other file.
 */

export interface PromptImageDeps {
  /** The session files of a card, in any order: the only files an image block is read from. */
  chainFiles: (terminalId: string) => Promise<readonly string[]>
  /** The attach store: the one directory an untrusted caller reads paths from. */
  attachmentsDir: string
}

export interface PromptImageReader {
  read: (ref: ImageRef, opts: { trusted: boolean }) => Promise<ImageBytes | null>
}

/** How much the reader keeps of what it read, so a scroll back and forth reads each picture once. */
const CACHE_BYTES = 64 * 1024 * 1024
/** One read of a session file while looking for a record, backwards from its end. */
const CHUNK = 4 * 1024 * 1024
/** A uuid as Claude writes them; anything else is not looked for. */
const UUID = /^[A-Za-z0-9-]{1,64}$/u

/** Is `ref` a well-formed ImageRef? Both doors take it off the wire. */
export function imageRefOf(raw: unknown): ImageRef | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  if (typeof r.path === 'string') return path.isAbsolute(r.path) ? { path: r.path } : null
  const { terminalId, file, uuid, i } = r
  if (typeof terminalId !== 'string' || typeof file !== 'string' || typeof uuid !== 'string') return null
  if (!UUID.test(uuid) || typeof i !== 'number' || !Number.isInteger(i) || i < 0) return null
  return { terminalId, file, uuid, i }
}

async function readAt(handle: FileHandle, start: number, length: number): Promise<Buffer> {
  const buf = Buffer.alloc(length)
  const { bytesRead } = await handle.read(buf, 0, length, start)
  return buf.subarray(0, bytesRead)
}

/** Where the line holding byte `at` begins and ends (the newline after it excluded). */
async function lineAround(handle: FileHandle, at: number, size: number): Promise<{ start: number; end: number }> {
  let start = 0
  for (let to = at; to > 0; ) {
    const from = Math.max(0, to - CHUNK)
    const nl = (await readAt(handle, from, to - from)).lastIndexOf(0x0a)
    if (nl >= 0) {
      start = from + nl + 1
      break
    }
    to = from
  }
  let end = size
  for (let from = at; from < size; from += CHUNK) {
    const nl = (await readAt(handle, from, Math.min(CHUNK, size - from))).indexOf(0x0a)
    if (nl >= 0) {
      end = from + nl
      break
    }
  }
  return { start, end }
}

/**
 * The session record whose own uuid is `uuid`, parsed, or null. Searched from
 * the end, where the turns a reader is looking at usually are. A match that
 * turns out to be someone else's (the text of a tool result quoting it, say)
 * is passed over.
 */
export async function findRecord(file: string, uuid: string): Promise<Record<string, unknown> | null> {
  const needle = Buffer.from(`"uuid":"${uuid}"`)
  const handle = await open(file, 'r')
  try {
    const { size } = await handle.stat()
    for (let to = size; to > 0; ) {
      const from = Math.max(0, to - CHUNK)
      const chunk = await readAt(handle, from, Math.min(size, to + needle.length - 1) - from)
      for (let hit = chunk.lastIndexOf(needle); hit >= 0; hit = hit > 0 ? chunk.lastIndexOf(needle, hit - 1) : -1) {
        const { start, end } = await lineAround(handle, from + hit, size)
        try {
          const record = JSON.parse((await readAt(handle, start, end - start)).toString('utf8')) as Record<string, unknown>
          if (record.uuid === uuid) return record
        } catch {
          // A torn or foreign line: keep looking.
        }
      }
      to = from
    }
    return null
  } finally {
    await handle.close()
  }
}

/** The `i`-th content block of a record, when it is a base64 image. */
export function imageBlockOf(record: Record<string, unknown>, i: number): ImageBytes | null {
  const content = (record.message as { content?: unknown } | undefined)?.content
  if (!Array.isArray(content)) return null
  const block = content[i] as { type?: string; source?: { type?: string; media_type?: string; data?: string } } | undefined
  const source = block?.type === 'image' ? block.source : undefined
  if (source?.type !== 'base64' || typeof source.data !== 'string') return null
  const mime = typeof source.media_type === 'string' && source.media_type.startsWith('image/') ? source.media_type : 'image/png'
  const bytes = Buffer.from(source.data, 'base64')
  return bytes.length > 0 && bytes.length <= MAX_IMAGE_BYTES ? { mime, bytes } : null
}

const within = (dir: string, file: string): boolean => file.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep)

async function readPath(filePath: string, trusted: boolean, attachmentsDir: string): Promise<ImageBytes | null> {
  const mime = imageMimeOf(filePath)
  if (!mime) return null
  const real = await realpath(filePath)
  if (!trusted && !within(await realpath(attachmentsDir), real)) return null
  const info = await stat(real)
  if (!info.isFile() || info.size === 0 || info.size > MAX_IMAGE_BYTES) return null
  return { mime, bytes: await readFile(real) }
}

export function createPromptImageReader(deps: PromptImageDeps): PromptImageReader {
  // Least recently read first: Map keeps insertion order, a hit re-inserts.
  let cache = new Map<string, ImageBytes>()
  let held = 0
  const keep = (key: string, image: ImageBytes): void => {
    if (image.bytes.length > CACHE_BYTES / 4) return
    const next = new Map(cache)
    next.set(key, image)
    held += image.bytes.length
    for (const [old, kept] of next) {
      if (held <= CACHE_BYTES) break
      next.delete(old)
      held -= kept.bytes.length
    }
    cache = next
  }

  const readBlock = async (ref: Extract<ImageRef, { file: string }>): Promise<ImageBytes | null> => {
    if (!(await deps.chainFiles(ref.terminalId)).includes(ref.file)) return null
    const record = await findRecord(ref.file, ref.uuid)
    return record ? imageBlockOf(record, ref.i) : null
  }

  return {
    async read(ref, { trusted }) {
      // The cache is keyed by WHAT, so it must not answer WHO: an untrusted
      // ask for a path is checked again even when the owner read it before.
      const key = imageRefKey(ref)
      const hit = cache.get(key)
      if (hit && (trusted || !('path' in ref))) return hit
      try {
        const image = 'path' in ref ? await readPath(ref.path, trusted, deps.attachmentsDir) : await readBlock(ref)
        if (image) keep(key, image)
        return image
      } catch (error) {
        // A picture that moved or was deleted is simply not drawn.
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.error('Prompt image read failed:', error)
        return null
      }
    }
  }
}
