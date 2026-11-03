import { buildAttachmentPaste } from '../../shared/attach'
import { cookrew } from './api'
import { saveClipboardImages } from './clipboard-image'
import { pathsForFiles } from './dropped-files'

/**
 * 📎 attachments: resolve files to absolute paths on the agents' machine
 * (local paths on desktop, uploads from a phone) and paste them into the
 * terminal Terminal.app-style — the agent reads the file itself. The prompt
 * box's paperclip puts them into its draft instead (prompt/PromptExtras.tsx).
 */
export async function attachFilesToTerminal(terminalId: string, files: File[]): Promise<void> {
  if (files.length === 0) return
  // A screenshot dragged from its thumbnail is saved, not pasted as a path that is about to vanish.
  pastePaths(terminalId, (await pathsForFiles(files, cookrew())).filter((p) => p !== ''))
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
  pastePaths(terminalId, await saveClipboardImages(images, cookrew()))
}
