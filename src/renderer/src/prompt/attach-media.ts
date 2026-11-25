import type { Compressors } from './attach-prepare'

/**
 * THE PHONE'S OWN CODECS AND CANVAS, doing what attach-plan.ts decided.
 *
 * Video goes through Mediabunny on WebCodecs: the file is read in slices
 * (never whole), decoded and re-encoded to H.264 by the phone's hardware, and
 * written as an MP4 in memory — faster than the clip plays, with no server.
 * It is loaded only when a video is attached, so nothing else pays for it.
 * A picture is redrawn on a canvas and saved as JPEG.
 *
 * Anything this browser cannot do rejects, and attach-prepare.ts falls back
 * to the original when the path takes it.
 */

const mediabunny = (): Promise<typeof import('mediabunny')> => import('mediabunny')

const probeVideo: Compressors['probeVideo'] = async (file) => {
  const mb = await mediabunny()
  const input = new mb.Input({ source: new mb.BlobSource(file), formats: mb.ALL_FORMATS })
  try {
    const track = await input.getPrimaryVideoTrack()
    if (!track || !(await track.canDecode())) return null
    const seconds = await input.computeDuration()
    return { seconds, width: track.displayWidth, height: track.displayHeight }
  } finally {
    input.dispose()
  }
}

const encodeVideo: Compressors['encodeVideo'] = async (file, plan, progress, signal) => {
  const mb = await mediabunny()
  const audioQuality = new mb.Quality({ bitrate: plan.audioBps })
  // Re-encoded when the phone can (Safari long had no AAC encoder): otherwise
  // the original sound is copied over as it is, which MP4 takes for AAC.
  const reencodeAudio = await mb.canEncodeAudio('aac', { quality: audioQuality }).catch(() => false)
  const input = new mb.Input({ source: new mb.BlobSource(file), formats: mb.ALL_FORMATS })
  const target = new mb.BufferTarget()
  // Written as it goes, the index at the end: 'in-memory' would hold every
  // piece and then the whole file again, three times the output at its peak.
  const output = new mb.Output({ format: new mb.Mp4OutputFormat({ fastStart: false }), target })
  try {
    const conversion = await mb.Conversion.init({
      input,
      output,
      video: {
        width: plan.width,
        height: plan.height,
        fit: 'contain',
        frameRate: plan.fps,
        codec: 'avc',
        quality: new mb.Quality({ bitrate: plan.videoBps }),
        forceTranscode: true
      },
      audio: reencodeAudio ? { codec: 'aac', quality: audioQuality, forceTranscode: true } : {},
      showWarnings: false
    })
    const video = conversion.utilizedTracks.some((track) => track.isVideoTrack())
    if (!conversion.isValid || !video) {
      const why = conversion.discardedTracks.map((d) => d.reason).join(', ') || 'no video track'
      throw new Error(`this browser cannot compress it (${why})`)
    }
    conversion.onProgress = (fraction) => progress(fraction)
    // Stopped while the codecs were being asked and the conversion set up: the listener below would never hear it.
    if (signal.aborted) throw new DOMException('stopped', 'AbortError')
    const stop = (): void => void conversion.cancel()
    signal.addEventListener('abort', stop, { once: true })
    try {
      await conversion.execute()
    } catch (error) {
      if (signal.aborted || error instanceof mb.ConversionCanceledError) throw new DOMException('stopped', 'AbortError')
      throw error
    } finally {
      signal.removeEventListener('abort', stop)
    }
    if (!target.buffer) throw new Error('the encoder wrote nothing')
    return new Blob([target.buffer], { type: 'video/mp4' })
  } finally {
    input.dispose()
  }
}

const bitmapOf = (file: File): Promise<ImageBitmap> => createImageBitmap(file, { imageOrientation: 'from-image' })

const probeImage: Compressors['probeImage'] = async (file) => {
  if (typeof createImageBitmap !== 'function') return null
  const bitmap = await bitmapOf(file)
  try {
    return { width: bitmap.width, height: bitmap.height }
  } finally {
    bitmap.close()
  }
}

/** A canvas of this size: off the page where the browser has one, a detached element where it does not. */
const canvasOf = (width: number, height: number): OffscreenCanvas | HTMLCanvasElement => {
  if (typeof OffscreenCanvas === 'function') return new OffscreenCanvas(width, height)
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  return canvas
}

const blobOf = (canvas: OffscreenCanvas | HTMLCanvasElement, type: string, quality: number): Promise<Blob> =>
  'convertToBlob' in canvas
    ? canvas.convertToBlob({ type, quality })
    : new Promise((resolve, reject) =>
        canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('the canvas made no picture'))), type, quality)
      )

const encodeImage: Compressors['encodeImage'] = async (file, plan) => {
  const bitmap = await bitmapOf(file)
  try {
    const canvas = canvasOf(plan.width, plan.height)
    const context = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null
    if (!context) throw new Error('no 2d canvas')
    // JPEG has no transparency: what was clear is white, not black.
    context.fillStyle = '#fff'
    context.fillRect(0, 0, plan.width, plan.height)
    context.imageSmoothingQuality = 'high'
    context.drawImage(bitmap, 0, 0, plan.width, plan.height)
    return await blobOf(canvas, plan.type, plan.quality)
  } finally {
    bitmap.close()
  }
}

export const browserCompressors: Compressors = { probeVideo, encodeVideo, probeImage, encodeImage }
