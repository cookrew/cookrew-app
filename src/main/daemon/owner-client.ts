/**
 * THE OWNER'S SIDE OF THE OWNER LINK (owner-link.ts is the daemon's side).
 *
 * Used by whatever launched the daemon and holds fd 3's other end: the
 * Electron shell during the move (shell/index.ts), and the reference for the
 * native app's own client. Same framing as the daemon's side (encodeFrame,
 * decodeLine), so byte arrays and escaped objects cross both ways.
 */
import type { Readable, Writable } from 'node:stream'
import { decodeLine, encodeFrame, MAX_LINE, type WindowTarget } from './owner-link'

export interface OwnerClient {
  /** No timeout of its own: a sign-in may wait minutes for a person. It fails when the link closes. */
  invoke(channel: string, args?: readonly unknown[]): Promise<unknown>
  send(channel: string, args?: readonly unknown[]): void
  /** Tell the daemon one of the real window's lifecycle events. */
  windowEvent(target: WindowTarget, name: string, args?: readonly unknown[]): void
  /** Every window event the daemon sends; returns the unsubscribe. */
  onEvent(listener: (channel: string, args: readonly unknown[]) => void): () => void
  readonly closed: Promise<void>
}

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void }

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
    input.removeAllListeners('data')
    for (const [, waiting] of pending) waiting.reject(new Error(`the daemon link closed: ${why}`))
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
    while (newline !== -1 && open) {
      const piece = bytes.subarray(start, newline)
      if (size + piece.length > MAX_LINE) {
        close('a line from the daemon is over the limit')
        return
      }
      const line = Buffer.concat([...parts, piece]).toString('utf8')
      parts = []
      size = 0
      if (line.length > 0) deliver(line)
      start = newline + 1
      newline = bytes.indexOf(0x0a, start)
    }
    const rest = bytes.subarray(start)
    if (size + rest.length > MAX_LINE) {
      close('a line from the daemon is over the limit')
      return
    }
    if (rest.length > 0) {
      parts.push(Buffer.from(rest))
      size += rest.length
    }
  })
  input.on('end', () => close('the daemon ended it'))
  input.on('error', (error) => close(String(error)))
  output.on('error', (error) => close(String(error)))

  /** One frame out; refused here when the daemon would have to skip it (over MAX_LINE). */
  const write = (frame: Parameters<typeof encodeFrame>[0]): void => {
    const line = encodeFrame(frame)
    if (Buffer.byteLength(line) > MAX_LINE) throw new Error(`the request is over ${MAX_LINE} bytes`)
    output.write(`${line}\n`)
  }

  return {
    invoke(channel, args = []) {
      if (!open) return Promise.reject(new Error('the daemon link is closed'))
      const id = nextId++
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject })
        try {
          write({ t: 'invoke', id, channel, args })
        } catch (error) {
          pending.delete(id)
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
    windowEvent(target, name, args = []) {
      if (!open) return
      try {
        write({ t: 'window', target, name, args })
      } catch (error) {
        log(`[cookrew shell] the window's ${name} cannot cross the daemon link: ${String(error)}`)
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
