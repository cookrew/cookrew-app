/**
 * THE OWNER'S SIDE OF THE OWNER LINK (owner-link.ts is the daemon's side).
 *
 * Used by whatever launched the daemon and holds fd 3's other end: the
 * Electron shell during the move (shell/index.ts), and the reference for the
 * native app's own client. Same framing as the daemon's side (encodeFrame,
 * decodeLine), so byte arrays and escaped objects cross both ways.
 */
import type { Readable, Writable } from 'node:stream'
import { decodeLine, encodeFrame, MAX_LINE } from './owner-link'

export interface OwnerClient {
  invoke(channel: string, args?: readonly unknown[]): Promise<unknown>
  send(channel: string, args?: readonly unknown[]): void
  /** Every window event the daemon sends; returns the unsubscribe. */
  onEvent(listener: (channel: string, args: readonly unknown[]) => void): () => void
  readonly closed: Promise<void>
}

/** How long one request may take before the client gives up on it. */
export const INVOKE_TIMEOUT_MS = 120_000

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }

export function createOwnerClient(input: Readable, output: Writable, log: (line: string) => void = console.error): OwnerClient {
  let nextId = 1
  let open = true
  let listeners: readonly ((channel: string, args: readonly unknown[]) => void)[] = []
  const pending = new Map<number, Pending>()
  let resolveClosed: () => void = () => undefined
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve
  })

  const close = (why: string): void => {
    if (!open) return
    open = false
    for (const [, waiting] of pending) {
      clearTimeout(waiting.timer)
      waiting.reject(new Error(`the daemon link closed: ${why}`))
    }
    pending.clear()
    resolveClosed()
  }

  const deliver = (line: string): void => {
    let frame: unknown
    try {
      frame = decodeLine(line)
    } catch {
      log('[cookrew shell] the daemon sent a line that is not JSON; ignored')
      return
    }
    const f = frame as { t?: unknown; id?: unknown; ok?: unknown; value?: unknown; error?: unknown; channel?: unknown; args?: unknown }
    if (f.t === 'result' && typeof f.id === 'number') {
      const waiting = pending.get(f.id)
      if (waiting === undefined) return
      pending.delete(f.id)
      clearTimeout(waiting.timer)
      if (f.ok === true) waiting.resolve(f.value)
      else waiting.reject(new Error(typeof f.error === 'string' ? f.error : 'the daemon refused'))
      return
    }
    if (f.t === 'event' && typeof f.channel === 'string' && Array.isArray(f.args)) {
      for (const listener of listeners) {
        try {
          listener(f.channel, f.args)
        } catch (error) {
          log(`[cookrew shell] a listener for ${f.channel} failed: ${String(error)}`)
        }
      }
    }
  }

  let parts: Buffer[] = []
  let size = 0
  input.on('data', (chunk: Buffer | string) => {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
    let start = 0
    let newline = bytes.indexOf(0x0a, start)
    while (newline !== -1) {
      const piece = bytes.subarray(start, newline)
      const line = Buffer.concat([...parts, piece]).toString('utf8')
      parts = []
      size = 0
      if (line.length > 0) deliver(line)
      start = newline + 1
      newline = bytes.indexOf(0x0a, start)
    }
    const rest = bytes.subarray(start)
    size += rest.length
    if (size > MAX_LINE) {
      close('a line from the daemon is over the limit')
      return
    }
    if (rest.length > 0) parts.push(Buffer.from(rest))
  })
  input.on('end', () => close('the daemon ended it'))
  input.on('error', (error) => close(String(error)))
  output.on('error', (error) => close(String(error)))

  const write = (frame: Parameters<typeof encodeFrame>[0]): void => {
    output.write(`${encodeFrame(frame)}\n`)
  }

  return {
    invoke(channel, args = []) {
      if (!open) return Promise.reject(new Error('the daemon link is closed'))
      const id = nextId++
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new Error(`${channel}: no answer from the daemon in ${INVOKE_TIMEOUT_MS} ms`))
        }, INVOKE_TIMEOUT_MS)
        pending.set(id, { resolve, reject, timer })
        try {
          write({ t: 'invoke', id, channel, args })
        } catch (error) {
          pending.delete(id)
          clearTimeout(timer)
          reject(error instanceof Error ? error : new Error(String(error)))
        }
      })
    },
    send(channel, args = []) {
      if (!open) return
      try {
        write({ t: 'send', channel, args })
      } catch (error) {
        log(`[cookrew shell] ${channel} cannot cross the daemon link: ${String(error)}`)
      }
    },
    onEvent(listener) {
      listeners = [...listeners, listener]
      return () => {
        listeners = listeners.filter((l) => l !== listener)
      }
    },
    closed
  }
}
