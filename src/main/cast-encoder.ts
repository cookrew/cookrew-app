import { randomUUID } from 'node:crypto'
import { CAST_ENCODER_SCRIPT } from '../shared/cast-encoder-script'

/**
 * WHERE A LIVE VIEW IS ENCODED AS H.264 (cast-encoder.ts).
 *
 * Electron's main process has no WebCodecs; a page has, with the platform's
 * own encoder underneath (VideoToolbox on a Mac). So one hidden window, made
 * on first use and never shown, runs the encoder script
 * (shared/cast-encoder-script.ts) and every viewer gets a session in it. Its
 * session is a partition of its own that grants nothing. A Mac whose page
 * cannot encode H.264 says so once, and every viewer keeps JPEG.
 */

export interface EncodedChunk {
  /** Annex B H.264, base64. */
  readonly data: string
  readonly key: boolean
}

export interface CastEncoderOptions {
  readonly codec: string
  /** Bits per second the encoder aims for. */
  readonly bitrate: number
  readonly framerate: number
}

export interface CastEncoderSession {
  /**
   * The screencast's JPEG in, one chunk out (null: the encoder dropped it).
   * `size` is the picture to encode, which may be a row or two taller than this
   * JPEG: it is drawn at the top left, so a frame that jitters by two rows is a
   * small change, not a new size and a key frame. Rejects when the encoder failed.
   *
   * No "looks the same" short cut: a 64-px fingerprint of a page of text is
   * grey texture, and scrolling it read as no change (measured 11-24, a
   * frozen picture). Pictures that are the same are caught by their bytes.
   */
  encode(jpegBase64: string, key: boolean, timestampMicros: number, size: { width: number; height: number }): Promise<EncodedChunk | null>
  close(): void
}

export interface CastEncoderHost {
  /** Can this machine encode `codec` at this size at all. An answer is kept; a failure to ask is not. */
  supported(codec: string, width: number, height: number): Promise<boolean>
  /** A session, or null when CAST_ENCODER_MAX_SESSIONS are open already: that viewer keeps JPEG. */
  open(options: CastEncoderOptions): CastEncoderSession | null
}

/**
 * Encoders open at once, across every viewer of every card. Each costs a JPEG
 * decode and an encode per frame in the one hidden window, and the platform's
 * hardware sessions run out (VideoToolbox falls back to software). Any one
 * paired device can open sockets, so the cap is here (review 11-24).
 */
export const CAST_ENCODER_MAX_SESSIONS = 4

/** What the host needs of a page: run an expression there and await its result. */
export interface EncoderPage {
  run<T>(expression: string): Promise<T>
}

/** A host over any page that runs the script: the hidden window in the app, a Chrome page in the tests. */
export function createCastEncoder(page: () => Promise<EncoderPage>): CastEncoderHost {
  const answers = new Map<string, Promise<boolean>>()
  let loaded: Promise<EncoderPage> | null = null
  let open = 0
  const ready = (): Promise<EncoderPage> => {
    loaded ??= page().then(async (p) => {
      await p.run<boolean>(CAST_ENCODER_SCRIPT)
      return p
    })
    loaded.catch(() => {
      loaded = null
    })
    return loaded
  }
  /**
   * A call into the page failed: the window may be gone (closed, or its
   * renderer crashed). The next viewer gets a fresh one, and asks afresh.
   */
  const forget = (): void => {
    loaded = null
    answers.clear()
  }
  return {
    supported(codec, width, height) {
      const key = `${codec} ${width}x${height}`
      let answer = answers.get(key)
      if (!answer) {
        const asking: Promise<boolean> = ready()
          .then((p) => p.run<boolean>(`window.__castEncSupported(${JSON.stringify(codec)}, ${Math.round(width)}, ${Math.round(height)})`))
          .then((ok) => ok === true)
          .catch((error: unknown) => {
            console.error('The live view encoder could not be checked:', error)
            // Not an answer: asked again next time.
            if (answers.get(key) === asking) answers.delete(key)
            return false
          })
        answer = asking
        answers.set(key, answer)
      }
      return answer
    },
    open(options) {
      if (open >= CAST_ENCODER_MAX_SESSIONS) return null
      open += 1
      const id = randomUUID()
      let closed = false
      const opened = ready().then((p) =>
        p.run<boolean>(`window.__castEncOpen(${JSON.stringify(id)}, ${JSON.stringify(options)})`).then(() => p)
      )
      opened.catch(() => undefined)
      return {
        async encode(jpegBase64, key, timestampMicros, size) {
          try {
            const p = await opened
            if (closed) return null
            const chunk = await p.run<{ data?: unknown; key?: unknown } | null>(
              `window.__castEncEncode(${JSON.stringify(id)}, ${JSON.stringify(jpegBase64)}, ${key === true}, ${Math.max(0, Math.round(timestampMicros))}, ${Math.round(size.width)}, ${Math.round(size.height)})`
            )
            return chunk && typeof chunk.data === 'string' && chunk.data.length > 0 ? { data: chunk.data, key: chunk.key === true } : null
          } catch (error) {
            forget()
            throw error
          }
        },
        close() {
          if (closed) return
          closed = true
          open -= 1
          void opened.then((p) => p.run(`window.__castEncClose(${JSON.stringify(id)})`)).catch(() => undefined)
        }
      }
    }
  }
}
