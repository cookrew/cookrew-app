/**
 * Pay the GPU's first-contact cost at idle, not on the first zoom.
 *
 * The first WebGL context a renderer process creates is expensive — it brings
 * up the GPU channel, ANGLE and the shader cache — and every one after it is
 * not. Not run on the phone, which never uses WebGL (demo mode in a plain
 * browser tab does run it; harmless, nothing there to benefit). Measured in the running desktop app: 76ms for the first `getContext`,
 * 5ms for the next. xterm's WebGL addon creates its context when a card's
 * full view mounts, so without this the first zoom-to-card after every launch
 * spends that inside the mount, on the main thread, after the animation has
 * already finished: a visible extra beat on exactly the interaction the owner
 * asked to be quick.
 *
 * The throwaway context is released at once (WEBGL_lose_context); what it
 * leaves warm is per-process, not per-context.
 */
export function warmWebgl(doc: Pick<Document, 'createElement'> = document): boolean {
  try {
    const canvas = doc.createElement('canvas') as HTMLCanvasElement
    canvas.width = 1
    canvas.height = 1
    const gl = canvas.getContext('webgl2', { antialias: false }) ?? canvas.getContext('webgl')
    if (!gl) return false
    ;(gl as WebGLRenderingContext).getExtension('WEBGL_lose_context')?.loseContext()
    return true
  } catch {
    return false
  }
}

/** Fallback when the window has no requestIdleCallback (WebKit). */
export const WARMUP_FALLBACK_MS = 1500

interface IdleHost {
  requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number
  setTimeout: (cb: () => void, ms: number) => unknown
}

/**
 * Schedule the warm-up for the first idle moment after boot, with a timeout
 * so a busy first paint cannot postpone it past the user's first click.
 */
export function scheduleWebglWarmup(
  host: IdleHost = window as unknown as IdleHost,
  warm: () => boolean = warmWebgl
): void {
  if (typeof host.requestIdleCallback === 'function') {
    host.requestIdleCallback(() => void warm(), { timeout: WARMUP_FALLBACK_MS })
    return
  }
  host.setTimeout(() => void warm(), WARMUP_FALLBACK_MS)
}
