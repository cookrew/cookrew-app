import { mkdirSync, readdirSync, renameSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { freeTarget } from './attachments'

/**
 * WHERE A BROWSER CARD'S FILES GO, AND HOW AN AGENT FINDS THEM.
 *
 * A headless Chrome left alone saves into ~/Downloads and tells nobody, so a
 * file the owner clicked in a chat was out of the agent's reach: it had no way
 * to ask what arrived, and every card shared one folder. Each card now saves
 * into a directory of its own, the same contract as phone attachments: the
 * agent receives an absolute path it can read. It sits under ~/.cookrew and not
 * ~/Downloads because macOS guards that folder per app, and an agent in a pane
 * cannot answer the dialog.
 *
 * Measured on Chrome 157: `allow` overwrites a second file of the same name
 * without a word, so Chrome is told `allowAndName` (its guid on disk) and the
 * name is given here once the file is whole. Quarantine survives the rename.
 */

const PARTIAL_SUFFIX = '.crdownload'
/** Code points. The longest ones are four bytes, and a file name holds 255. */
const MAX_NAME_LENGTH = 60
const MAX_EXTENSION_LENGTH = 16
const NO_NAME = 'download'

export interface ArrivingDownload {
  readonly name: string
  readonly receivedBytes: number
  /** 0 when the server never said. */
  readonly totalBytes: number
}

export interface DownloadedFile {
  readonly path: string
  readonly bytes: number
  readonly modifiedAt: number
}

/** The part of a CDP connection a watcher needs. */
export interface DownloadCdp {
  on(method: string, cb: (params: Record<string, unknown>) => void): void
  send(method: string, params?: Record<string, unknown>): Promise<unknown>
}

/** Every card's directory sits here. The served sandbox denies it (owner-secrets.ts). */
export function defaultDownloadsRoot(): string {
  return path.join(homedir(), '.cookrew', 'downloads')
}

/** One card's directory: a page can reach no other card's files, nor the owner's own. */
export function browserDownloadsDir(cardId: string, root: string = defaultDownloadsRoot()): string {
  return path.join(root, cardId)
}

/**
 * A page's file name, made safe to paste into a shell. Letters of every script
 * stay: sanitizeAttachmentName keeps ASCII only, which turns a Chinese name
 * into its extension. Everything else goes, the bidi and control characters
 * that disguise an extension or reach the terminal among it.
 */
export function downloadFileName(suggested: string): string {
  const cleaned = suggested
    .normalize('NFC')
    .replace(/[^\p{L}\p{M}\p{N}._-]+/gu, '-')
    .replace(/-{2,}/g, '-')
    .replace(/-+\./g, '.')
    .replace(/^[-.]+|-+$/g, '')
  if (cleaned.length === 0) return NO_NAME
  const chars = Array.from(cleaned)
  if (chars.length <= MAX_NAME_LENGTH) return cleaned
  const dot = cleaned.lastIndexOf('.')
  const extension = dot > 0 ? Array.from(cleaned.slice(dot)).slice(0, MAX_EXTENSION_LENGTH) : []
  return chars.slice(0, MAX_NAME_LENGTH - extension.length).join('') + extension.join('')
}

/** One card's Chrome: where it saves, what is arriving, and the name each file ends up with. */
export class DownloadWatcher {
  private readonly arriving = new Map<string, ArrivingDownload>()

  constructor(private readonly dir: string) {}

  /** A refusal costs the agent its files, not the owner the card, so it never fails a launch. */
  async attach(cdp: DownloadCdp): Promise<void> {
    cdp.on('Browser.downloadWillBegin', (params) => this.begin(params))
    cdp.on('Browser.downloadProgress', (params) => this.progress(params))
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 })
      await cdp.send('Browser.setDownloadBehavior', {
        behavior: 'allowAndName',
        downloadPath: this.dir,
        eventsEnabled: true
      })
    } catch (error) {
      console.error(`browser downloads: ${this.dir} not set, files go to Chrome's default: ${String(error)}`)
    }
  }

  /** What is on its way, under the name it will land with unless that name is taken. */
  active(): ArrivingDownload[] {
    return [...this.arriving.values()]
  }

  private begin({ guid, suggestedFilename }: Record<string, unknown>): void {
    if (typeof guid !== 'string') return
    // Cleaned here, not at the end: this name is printed while the file arrives.
    const name = downloadFileName(typeof suggestedFilename === 'string' ? suggestedFilename : '')
    this.arriving.set(guid, { name, receivedBytes: 0, totalBytes: 0 })
  }

  private progress({ guid, state, receivedBytes, totalBytes }: Record<string, unknown>): void {
    if (typeof guid !== 'string') return
    const entry = this.arriving.get(guid)
    if (state === 'inProgress') {
      if (!entry) return
      this.arriving.set(guid, {
        ...entry,
        receivedBytes: Number(receivedBytes) || 0,
        totalBytes: Number(totalBytes) || 0
      })
      return
    }
    this.arriving.delete(guid)
    if (state === 'completed') this.land(guid, entry?.name ?? NO_NAME)
  }

  private land(guid: string, name: string): void {
    try {
      renameSync(path.join(this.dir, path.basename(guid)), freeTarget(this.dir, name))
    } catch (error) {
      // The bytes are whole under the guid, and listDownloads still shows them.
      console.error(`browser downloads: could not name ${guid}: ${String(error)}`)
    }
  }
}

/** What landed in a card's directory, newest first. Read from disk: it outlives the card's Chrome. */
export function listDownloads(dir: string): DownloadedFile[] {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  return names
    .filter((name) => !name.startsWith('.') && !name.endsWith(PARTIAL_SUFFIX))
    .flatMap((name) => fileAt(path.join(dir, name)))
    .sort((a, b) => b.modifiedAt - a.modifiedAt)
}

function fileAt(filePath: string): DownloadedFile[] {
  try {
    const stat = statSync(filePath)
    return stat.isFile() ? [{ path: filePath, bytes: stat.size, modifiedAt: stat.mtimeMs }] : []
  } catch {
    return [] // Named between the listing and this look; the next listing has it.
  }
}

const arrivingLine = ({ name, receivedBytes, totalBytes }: ArrivingDownload): string =>
  `downloading ${name} (${totalBytes > 0 ? `${receivedBytes} of ${totalBytes}` : receivedBytes} bytes)`

const fileLine = ({ path: filePath, bytes, modifiedAt }: DownloadedFile): string =>
  `${filePath}\t${bytes} bytes\t${new Date(modifiedAt).toISOString()}`

/** What `cookrew browser downloads` prints: one line per file, the path first. */
export function downloadsReport(
  dir: string,
  files: readonly DownloadedFile[],
  arriving: readonly ArrivingDownload[]
): string {
  const lines = [...arriving.map(arrivingLine), ...files.map(fileLine)]
  return lines.length > 0 ? lines.join('\n') : `No downloads yet. They land in ${dir}`
}
