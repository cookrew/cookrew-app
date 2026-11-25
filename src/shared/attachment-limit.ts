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

/**
 * THE RELAY, SEALED (cookrew-seal/2). A sealed body crosses the relay as many
 * small POSTs, so the registry's 4 MB is not its limit; the Mac takes an
 * attachment at its own cap on that path too (main/seal2-serve-http.ts). What
 * the phone sends there is still every byte through cookrew.dev, a round trip
 * per megabyte: 25 MB, the size WeChat sends a video at without asking, keeps
 * a minute of 720p and a fair wait. Compressing (prompt/attach-plan.ts) fits
 * a video to it.
 */
export const SEALED_RELAY_BODY_MAX = 25 * 1024 * 1024
export const SEALED_RELAY_LIMIT: AttachLimit = { bytes: SEALED_RELAY_BODY_MAX, via: 'relay' }

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
