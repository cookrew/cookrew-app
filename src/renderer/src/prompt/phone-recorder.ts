import { recordingWav } from './phone-audio'

/**
 * The phone's mic, recorded for the Mac to hear (use-dictation.ts, ear
 * 'phone'). Raw samples through Web Audio rather than MediaRecorder: every
 * phone browser has it, and the WAV it makes needs no codec on the Mac.
 */
export interface PhoneRecording {
  /** The mic is open (or refused: the rejection says why). */
  ready: Promise<void>
  /** Close the mic; the WAV of what it heard, or null for a tap with nothing in it. */
  stop: () => Promise<Uint8Array | null>
  /** Close the mic and keep nothing. */
  cancel: () => void
}

type AudioContextCtor = typeof AudioContext

export function canRecord(scope: unknown = typeof window === 'undefined' ? undefined : window): boolean {
  const w = (scope ?? {}) as { AudioContext?: AudioContextCtor; webkitAudioContext?: AudioContextCtor; navigator?: Navigator }
  return Boolean((w.AudioContext ?? w.webkitAudioContext) && w.navigator?.mediaDevices?.getUserMedia)
}

/**
 * Start recording. Call it inside the tap: the AudioContext is made at once,
 * while the tap still counts as the owner's gesture, so a permission prompt
 * that takes a while cannot leave it suspended.
 */
export function startPhoneRecording(): PhoneRecording {
  const w = window as unknown as { AudioContext?: AudioContextCtor; webkitAudioContext?: AudioContextCtor }
  const Ctx = (w.AudioContext ?? w.webkitAudioContext) as AudioContextCtor
  const context = new Ctx()
  const chunks: Float32Array[] = []
  let stream: MediaStream | null = null
  let source: MediaStreamAudioSourceNode | null = null
  let processor: ScriptProcessorNode | null = null
  let closed = false

  const release = (): void => {
    closed = true
    if (processor) processor.onaudioprocess = null
    processor?.disconnect()
    source?.disconnect()
    stream?.getTracks().forEach((track) => track.stop())
    void context.close().catch(() => undefined)
  }

  const ready = navigator.mediaDevices
    .getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } })
    .then(async (opened) => {
      stream = opened
      // Stopped while the permission prompt was up: the mic closes at once.
      if (closed) return release()
      await context.resume()
      source = context.createMediaStreamSource(opened)
      processor = context.createScriptProcessor(4096, 1, 1)
      processor.onaudioprocess = (event) => {
        if (!closed) chunks.push(new Float32Array(event.inputBuffer.getChannelData(0)))
      }
      source.connect(processor)
      // A processor fires only while connected onward; it writes silence there.
      processor.connect(context.destination)
    })

  return {
    ready,
    stop: async () => {
      if (closed) return null
      const rate = context.sampleRate
      // Wait for the mic to open (or fail): a quick tap must not leak it open.
      await ready.catch(() => undefined)
      release()
      return recordingWav(chunks, rate)
    },
    cancel: () => {
      if (!closed) release()
    }
  }
}
