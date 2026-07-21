// Single paste path for the terminal overlay. ⌘V used to insert text TWICE:
// the key handler manually pasted via the clipboard API AND xterm's own
// native paste (its textarea 'paste' event) also fired. This one handler owns
// paste — text and images — and always preventDefault + stopPropagation, so
// xterm's native paste never also runs. Reading the text off the paste EVENT
// (clipboardData) works in insecure contexts too (unlike navigator.clipboard),
// so the phone pastes here as well.

import { imageFilesFromClipboardItems, type ClipboardItemLike } from './clipboard-image'

export interface PasteEventLike<F> {
  clipboardData: {
    items?: ArrayLike<ClipboardItemLike<F>>
    getData(type: string): string
  } | null
  preventDefault(): void
  stopPropagation(): void
}

export interface PasteSink<F> {
  pasteText(text: string): void
  pasteImages(images: F[]): void
}

/**
 * Handle a terminal paste from the event's clipboardData exactly once: image
 * items go to pasteImages, otherwise the plain text goes to pasteText. When it
 * acts it suppresses the default (and propagation) so xterm's native paste
 * cannot double-insert. Returns true when it handled the paste.
 */
export function handleTerminalPaste<F>(event: PasteEventLike<F>, sink: PasteSink<F>): boolean {
  const items = event.clipboardData?.items ? Array.from(event.clipboardData.items) : []
  const images = imageFilesFromClipboardItems(items)
  if (images.length > 0) {
    event.preventDefault()
    event.stopPropagation()
    sink.pasteImages(images)
    return true
  }
  const text = event.clipboardData?.getData('text') ?? ''
  if (text.length === 0) return false
  event.preventDefault()
  event.stopPropagation()
  sink.pasteText(text)
  return true
}
