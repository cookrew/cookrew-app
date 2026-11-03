/**
 * The phone's recording, the parts with no DOM in them (phone-recorder.ts
 * captures; the Mac hears, main/hear-file.ts). What goes up is a 16 kHz mono
 * 16-bit WAV: what the recognizer wants, a third of the bytes of 48 kHz, and a
 * format AVAudioFile reads without a codec.
 */

export const HEAR_RATE = 16000

/** A held-open mic stops by itself here; the Mac takes up to two minutes. */
export const PHONE_MAX_SECONDS = 60

/** Less than this is a tap, not a sentence: nothing goes up. */
export const MIN_SPEECH_SECONDS = 0.3

export function joinSamples(chunks: readonly Float32Array[]): Float32Array {
  const out = new Float32Array(chunks.reduce((n, c) => n + c.length, 0))
  chunks.reduce((at, c) => {
    out.set(c, at)
    return at + c.length
  }, 0)
  return out
}

/** Average each output sample's span of input: a box filter is low-pass enough for speech. */
export function downsample(samples: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate <= toRate) return samples
  const ratio = fromRate / toRate
  const out = new Float32Array(Math.floor(samples.length / ratio))
  for (let i = 0; i < out.length; i++) {
    const start = Math.floor(i * ratio)
    const end = Math.min(samples.length, Math.floor((i + 1) * ratio))
    let sum = 0
    for (let j = start; j < end; j++) sum += samples[j]
    out[i] = end > start ? sum / (end - start) : 0
  }
  return out
}

/** RIFF/WAVE, PCM, mono, 16-bit little-endian. */
export function wavBytes(samples: Float32Array, rate: number): Uint8Array {
  const bytes = new Uint8Array(44 + samples.length * 2)
  const view = new DataView(bytes.buffer)
  const text = (at: number, s: string): void => [...s].forEach((ch, i) => view.setUint8(at + i, ch.charCodeAt(0)))
  text(0, 'RIFF')
  view.setUint32(4, 36 + samples.length * 2, true)
  text(8, 'WAVE')
  text(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, rate, true)
  view.setUint32(28, rate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  text(36, 'data')
  view.setUint32(40, samples.length * 2, true)
  samples.forEach((s, i) => {
    const clamped = Math.max(-1, Math.min(1, s))
    view.setInt16(44 + i * 2, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true)
  })
  return bytes
}

/** What the mic heard, ready to go up; null for a tap with nothing in it. */
export function recordingWav(chunks: readonly Float32Array[], rate: number): Uint8Array | null {
  const samples = downsample(joinSamples(chunks), rate, HEAR_RATE)
  return samples.length < HEAR_RATE * MIN_SPEECH_SECONDS ? null : wavBytes(samples, Math.min(rate, HEAR_RATE))
}

/** getUserMedia's refusals, said the way the box says the Web Speech ones. */
export function micErrorText(error: unknown): string {
  const name = (error as { name?: string } | null)?.name
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'The microphone is not allowed here.'
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No microphone was found.'
  if (name === 'NotReadableError') return 'The microphone is busy in another app.'
  return `The microphone did not start: ${error instanceof Error ? error.message : String(error)}`
}
