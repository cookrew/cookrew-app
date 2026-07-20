// Clipboard image extraction for terminal paste. A Mac screenshot (or any
// copied image) lands on the clipboard as raw bytes with no filesystem path,
// so it can't ride the file-path attach flow — the bytes have to be pulled
// off the paste event and saved. These helpers are the pure parts; the DOM
// wiring lives in TerminalOverlay.

/** Minimal shape of a DataTransferItem for image extraction. */
export interface ClipboardItemLike<F> {
  kind: string
  type: string
  getAsFile: () => F | null
}

/** The image File/Blob objects among clipboard items, in order. */
export function imageFilesFromClipboardItems<F>(items: ReadonlyArray<ClipboardItemLike<F>>): F[] {
  const files: F[] = []
  for (const item of items) {
    if (item.kind !== 'file' || !item.type.startsWith('image/')) continue
    const file = item.getAsFile()
    if (file !== null) files.push(file)
  }
  return files
}

/** MIME subtypes whose extension differs from the subtype string. */
const EXT_OVERRIDES: Record<string, string> = {
  jpeg: 'jpg',
  'svg+xml': 'svg'
}

/**
 * A safe, timestamped attachment name for a pasted image. saveAttachment
 * dedups collisions, so the stamp only needs to be reasonably unique.
 */
export function imageAttachmentName(mimeType: string, stamp: string): string {
  const subtype = mimeType.startsWith('image/') ? mimeType.slice('image/'.length) : ''
  const cleaned = subtype.toLowerCase().replace(/[^a-z0-9]/g, '')
  const ext = EXT_OVERRIDES[subtype.toLowerCase()] ?? (cleaned.length > 0 ? cleaned : 'png')
  return `pasted-image-${stamp}.${ext}`
}
