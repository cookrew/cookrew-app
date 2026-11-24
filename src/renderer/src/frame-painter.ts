import { decodeBase64 } from './base64'

/**
 * THE LIVE VIEW IS DRAWN, NOT RE-RENDERED.
 *
 * A screencast frame used to be React state: a data: URL set on an <img>, so
 * every frame — up to 60 a second — re-rendered the whole browser surface and
 * decoded base64 JPEG on the main thread, between the owner's own scroll and
 * click events. Here a frame goes from the stream straight to a <canvas>:
 * decoded off the main thread (createImageBitmap), drawn once, and React hears
 * only about the few things that change rarely (the frame's size, the first
 * paint).
 *
 * The newest frame wins. One decodes at a time; a frame that arrives meanwhile
 * replaces the waiting one, and the replaced one is reported as skipped — the
 * desktop's port counts both as receipts, so main never queues behind a slow
 * paint (browser-cast-ipc.ts).
 */

export interface PaintableFrame {
  seq: number
  revision: number
  /** A data: URL — a frame that rode a socket as base64. */
  src?: string
  /** The JPEG itself — a frame from the desktop's port. */
  bytes?: Uint8Array
  /**
   * A picture already decoded from H.264 (cast-video-decoder.ts), and the size
   * it stands for in frame pixels. The painter owns it from here and closes it.
   */
  video?: VideoFrame
  width?: number
  height?: number
  /** Where the page is scrolled to in this picture, in CSS pixels. */
  scrollY?: number
  pageScale?: number
}

export interface PaintedFrame {
  seq: number
  revision: number
  width: number
  height: number
  /**
   * The frame's JPEG: what the card keeps as its picture at zoom-out
   * (browser-poster.ts). Absent for an H.264 picture, which has none: the
   * canvas is the picture then.
   */
  blob?: Blob
  scrollY?: number
  pageScale?: number
}

export interface PainterEvents {
  onPainted: (frame: PaintedFrame) => void
  /** Skipped (a newer one came) or undecodable: either way, done with. */
  onSkipped: (seq: number) => void
}

const DATA_URL = /^data:(image\/[a-z+.-]+);base64,(.*)$/s

/** A frame's JPEG as a Blob: bytes as they came, a data: URL decoded once. Null when neither decodes. */
export function frameBlob(frame: Pick<PaintableFrame, 'src' | 'bytes'>): Blob | null {
  if (frame.bytes && frame.bytes.byteLength > 0) {
    return new Blob([frame.bytes as Uint8Array<ArrayBuffer>], { type: 'image/jpeg' })
  }
  const match = frame.src ? DATA_URL.exec(frame.src) : null
  if (!match) return null
  try {
    return new Blob([decodeBase64(match[2])], { type: match[1] })
  } catch {
    return null
  }
}

type Picture = ImageBitmap | HTMLImageElement | VideoFrame

/** A frame handed over and never drawn: its decoded picture is let go of now. */
function release(frame: PaintableFrame | null): void {
  frame?.video?.close()
}

/** Off the main thread where the engine can; an <img> decode where it cannot (an older iOS). */
async function decodePicture(blob: Blob): Promise<Picture> {
  if (typeof createImageBitmap === 'function') return createImageBitmap(blob)
  const url = URL.createObjectURL(blob)
  try {
    const image = new Image()
    image.src = url
    await image.decode()
    return image
  } finally {
    URL.revokeObjectURL(url)
  }
}

function pictureSize(picture: Picture): { width: number; height: number } {
  if ('displayWidth' in picture) return { width: picture.displayWidth, height: picture.displayHeight }
  return 'naturalWidth' in picture
    ? { width: picture.naturalWidth, height: picture.naturalHeight }
    : { width: picture.width, height: picture.height }
}

export class FramePainter {
  private decoding = false
  private waiting: PaintableFrame | null = null
  private disposed = false
  private context: CanvasRenderingContext2D | null = null

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly events: PainterEvents
  ) {}

  push(frame: PaintableFrame): void {
    if (this.disposed) {
      release(frame)
      return this.events.onSkipped(frame.seq)
    }
    if (this.decoding) {
      if (this.waiting) {
        release(this.waiting)
        this.events.onSkipped(this.waiting.seq)
      }
      this.waiting = frame
      return
    }
    void this.paint(frame)
  }

  dispose(): void {
    this.disposed = true
    if (this.waiting) {
      release(this.waiting)
      this.events.onSkipped(this.waiting.seq)
    }
    this.waiting = null
  }

  private async paint(frame: PaintableFrame): Promise<void> {
    this.decoding = true
    try {
      let blob: Blob | null = null
      let picture: Picture
      let size: { width: number; height: number }
      if (frame.video) {
        // Decoded already; drawn at the size it stands for (an odd last row or column was
        // cropped to encode it), and never much larger than it is: the size came over the wire.
        picture = frame.video
        const own = { width: frame.video.displayWidth, height: frame.video.displayHeight }
        size = {
          width: Math.min(frame.width ?? own.width, own.width + 2),
          height: Math.min(frame.height ?? own.height, own.height + 2)
        }
      } else {
        blob = frameBlob(frame)
        if (!blob) return this.events.onSkipped(frame.seq)
        try {
          picture = await decodePicture(blob)
        } catch {
          return this.events.onSkipped(frame.seq)
        }
        size = pictureSize(picture)
      }
      if (this.disposed) {
        if ('close' in picture) picture.close()
        return this.events.onSkipped(frame.seq)
      }
      const { width, height } = this.drawSize(frame.revision, size)
      this.draw(picture, width, height)
      this.events.onPainted({
        seq: frame.seq,
        revision: frame.revision,
        width,
        height,
        ...(blob ? { blob } : {}),
        ...(frame.scrollY !== undefined ? { scrollY: frame.scrollY } : {}),
        ...(frame.pageScale !== undefined ? { pageScale: frame.pageScale } : {})
      })
    } finally {
      this.decoding = false
      const next = this.waiting
      this.waiting = null
      if (next && !this.disposed) void this.paint(next)
    }
  }

  /**
   * The size to draw at. While a page scrolls, Chrome sends frames at 1x to a
   * 2x viewer (measured 2026-11-09: 1600x640 at rest, 800x320 mid-scroll, one
   * viewport revision). Sized by each frame, the picture jumped between two
   * sizes. Within one revision a smaller frame of the same shape is stretched
   * over the largest one seen; a new revision or a new shape starts over.
   */
  private drawSize(revision: number, size: { width: number; height: number }): { width: number; height: number } {
    const kept = this.kept
    const sameShape =
      kept !== null && Math.abs(kept.width * size.height - size.width * kept.height) <= 0.02 * kept.width * size.height
    if (kept === null || kept.revision !== revision || !sameShape || size.width > kept.width) {
      this.kept = { revision, ...size }
      return size
    }
    return { width: kept.width, height: kept.height }
  }

  private kept: { revision: number; width: number; height: number } | null = null

  private draw(picture: Picture, width: number, height: number): void {
    const canvas = this.canvas
    // Resizing a canvas clears it, so only when the drawn size changed.
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width
      canvas.height = height
      this.context = null
    }
    this.context ??= canvas.getContext('2d', { alpha: false })
    const own = pictureSize(picture)
    if (own.width === width && own.height === height) this.context?.drawImage(picture, 0, 0)
    else this.context?.drawImage(picture, 0, 0, width, height)
    if ('close' in picture) picture.close()
  }
}
