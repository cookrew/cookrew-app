import { createHash } from 'node:crypto'
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { sanitizeAttachmentName, shellQuotePath } from '../shared/attach'
import type { CliRequest } from '../shared/model'
import { imageMimeOf, imagePathTokens } from '../shared/prompt-images'
import { MAX_ATTACHMENT_BYTES } from './attachments'

/**
 * A BRIEF'S PICTURES REACH THE PHONE (owner, 2026-11-04). The chat views draw
 * an image path a prompt names as the picture (prompt-images.ts), and the
 * phone reads a picture only from the attach store (prompt-image.ts · the
 * untrusted reach). A brief an agent sends with `cookrew ask` or
 * `cookrew recruit --prompt` often names one elsewhere (an eval's
 * /tmp/…/app-full.png), and the phone drew an empty tile for it.
 *
 * So such a picture is copied into the store as the brief is sent, and the
 * brief names the copy: the agent reads the same bytes, and the phone can
 * draw them. The copy is named by its content, so the same picture sent again
 * is the same file. Anything that cannot be read as a picture stays as it was
 * written.
 *
 * Only the CLI's briefs: they come from the owner's own machine, whose agents
 * can read any file anyway. A stranger's prompt (call-prompt.ts) never comes
 * this way, and must not: it would copy the owner's files where the phone
 * reads them.
 */

const within = (dir: string, file: string): boolean => file.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep)

/** The store's copy of `file`, made once; null when it is not a picture we can copy. */
async function copyIntoStore(file: string, store: string, realStore: string): Promise<string | null> {
  try {
    const real = await realpath(file)
    if (within(realStore, real)) return null
    const info = await stat(real)
    if (!info.isFile() || info.size > MAX_ATTACHMENT_BYTES || imageMimeOf(real) === null) return null
    const bytes = await readFile(real)
    const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 10)
    const base = path.basename(file)
    const dot = base.lastIndexOf('.')
    const name = sanitizeAttachmentName(`${base.slice(0, dot)}-${hash}${base.slice(dot).toLowerCase()}`)
    const target = path.join(store, name)
    // Same name, same bytes: a copy already there is this one.
    await writeFile(target, bytes, { flag: 'wx' }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error
    })
    return target
  } catch {
    return null
  }
}

/** `text` with every picture it names outside the attach store `store` swapped for the store's copy. */
export async function adoptPictures(text: string, store: string): Promise<string> {
  const tokens = imagePathTokens(text)
  if (tokens.length === 0) return text
  let realStore: string
  try {
    await mkdir(store, { recursive: true })
    realStore = await realpath(store)
  } catch {
    return text
  }
  const copies = new Map<string, string | null>()
  for (const { path: file } of tokens) {
    if (!copies.has(file)) copies.set(file, await copyIntoStore(file, store, realStore))
  }
  let out = text
  for (const token of [...tokens].reverse()) {
    const copy = copies.get(token.path)
    if (copy) out = out.slice(0, token.start) + shellQuotePath(copy) + out.slice(token.end)
  }
  return out
}

/**
 * The CLI request with its brief's pictures adopted: the prompt of an ask
 * (not its raw bytes) and a recruit's --prompt. A new request when anything
 * changed; the same one otherwise.
 */
export async function adoptRequestPictures(request: CliRequest, adopt: (text: string) => Promise<string>): Promise<CliRequest> {
  if (request.cmd === 'ask' && !request.flags.raw && typeof request.args[1] === 'string') {
    const brief = await adopt(request.args[1])
    return brief === request.args[1] ? request : { ...request, args: [request.args[0], brief, ...request.args.slice(2)] }
  }
  if (request.cmd === 'recruit' && typeof request.flags.prompt === 'string') {
    const brief = await adopt(request.flags.prompt)
    return brief === request.flags.prompt ? request : { ...request, flags: { ...request.flags, prompt: brief } }
  }
  return request
}
