/**
 * THE ATTACHMENT CAP, one number for both ends.
 *
 * The Mac refuses to save more than this (main/attachments.ts), and the
 * direct link carries at least this much (main/rtc-peer.ts). The phone reads
 * it too, to refuse a file before a byte goes up: past it the Mac would
 * refuse anyway, but only after the upload, and in a transport's words
 * (`body-too-large`) rather than the file's.
 */
export const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024

/**
 * What cookrew.dev's relay carries in one request body: the registry refuses
 * more (registry v2-canvas-relay.ts · CANVAS_BODY_MAX), and so does the Mac's
 * end of the relay's line (main/canvas-bridge.ts · BRIDGE_BODY_MAX). A phone
 * not on a direct path to the Mac can attach no more than this.
 */
export const RELAY_BODY_MAX = 4 * 1024 * 1024

/** How much one attachment may be on the path it would take now. */
export interface AttachLimit {
  readonly bytes: number
  /** `relay`: only the relay is up, and a direct path would take more. */
  readonly via: 'mac' | 'relay'
}

export const MAC_LIMIT: AttachLimit = { bytes: MAX_ATTACHMENT_BYTES, via: 'mac' }
export const RELAY_LIMIT: AttachLimit = { bytes: RELAY_BODY_MAX, via: 'relay' }

/** A file as a picker or a drop hands it over: all this needs is its name and size. */
export interface SizedFile {
  readonly name: string
  readonly size: number
}

const MB = 1024 * 1024

/** One decimal, so a file just over a limit never reads as the limit itself. */
const megabytes = (bytes: number): string => `${Number((bytes / MB).toFixed(1))} MB`

/** Why these files cannot go up, naming the first one too large; null when all can. */
export const oversizeAttachment = (files: readonly SizedFile[], limit: AttachLimit = MAC_LIMIT): string | null => {
  const over = files.find((file) => file.size > limit.bytes)
  if (!over) return null
  const said = `${over.name || 'a file'} is ${megabytes(over.size)}`
  if (limit.via === 'relay' && over.size <= MAX_ATTACHMENT_BYTES) {
    return `${said}; through the relay attachments stop at ${megabytes(limit.bytes)}. On the Mac's Wi-Fi or tailnet they go up to ${megabytes(MAX_ATTACHMENT_BYTES)}`
  }
  return `${said}; the Mac takes attachments up to ${megabytes(MAX_ATTACHMENT_BYTES)}`
}
