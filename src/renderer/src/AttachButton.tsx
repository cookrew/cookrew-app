import { useRef, useState } from 'react'
import { buildAttachmentPaste } from '../../shared/attach'
import { cookrew, hasNativeWebview } from './api'
import { imageAttachmentName } from './clipboard-image'
import { CrIcon } from './icons'

/**
 * 📎 attachments: resolve files to absolute paths on the agents' machine
 * (local paths on desktop, uploads from a phone) and paste them into the
 * terminal Terminal.app-style — the agent reads the file itself.
 */
export async function attachFilesToTerminal(terminalId: string, files: File[]): Promise<void> {
  if (files.length === 0) return
  const paths = await cookrew().attachFiles(files)
  pastePaths(terminalId, paths)
}

function pastePaths(terminalId: string, paths: string[]): void {
  const paste = buildAttachmentPaste(paths)
  if (paste) cookrew().ptyInput(terminalId, paste)
}

/**
 * Save pasted clipboard images (raw bytes, no file path) through the attach
 * store and paste their resulting paths — the paste-event counterpart to
 * attachFilesToTerminal. Desktop-only: the phone companion is an insecure
 * context with no clipboard-image API.
 */
export async function pasteClipboardImages(
  terminalId: string,
  images: Array<{ type: string; arrayBuffer: () => Promise<ArrayBuffer> }>
): Promise<void> {
  const stamp = String(Date.now())
  const paths: string[] = []
  for (const [i, image] of images.entries()) {
    const bytes = new Uint8Array(await image.arrayBuffer())
    const name = imageAttachmentName(image.type, images.length > 1 ? `${stamp}-${i + 1}` : stamp)
    paths.push(await cookrew().saveAttachmentBytes(name, bytes))
  }
  pastePaths(terminalId, paths)
}

/**
 * Paperclip button for the terminal composer: native file dialog on the
 * desktop, an <input type=file> picker in phone browsers (which then
 * uploads through attachFiles).
 */
export function AttachButton({ terminalId }: { terminalId: string }): React.JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)

  const run = async (task: () => Promise<void>): Promise<void> => {
    setBusy(true)
    try {
      await task()
    } catch (error) {
      console.error('Attachment failed:', error)
    } finally {
      setBusy(false)
    }
  }

  const pick = (): void => {
    if (busy) return
    if (hasNativeWebview()) {
      void run(async () => pastePaths(terminalId, await cookrew().pickFiles()))
    } else {
      inputRef.current?.click()
    }
  }

  const onFiles = (list: FileList | null): void => {
    const files = Array.from(list ?? [])
    if (inputRef.current) inputRef.current.value = ''
    if (files.length > 0) void run(() => attachFilesToTerminal(terminalId, files))
  }

  return (
    <>
      <button
        className={`cr-btn sm voice-attach${busy ? ' busy' : ''}`}
        title="Attach files (paste their paths into the terminal)"
        onClick={pick}
        disabled={busy}
      >
        <CrIcon name="attach" />
      </button>
      <input
        ref={inputRef}
        type="file"
        multiple
        style={{ display: 'none' }}
        onChange={(e) => onFiles(e.target.files)}
      />
    </>
  )
}
