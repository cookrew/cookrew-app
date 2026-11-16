/**
 * THE OWNER'S LINE TO cookrewd (D0 step 2).
 *
 * The owner's app (an Electron shell during the move, the native app after)
 * launches the daemon and holds one end of a socket pair passed as an extra
 * stdio descriptor. That pipe IS the owner: it has no path and no port, so no
 * agent, phone or page can connect to it, and on macOS the daemon's children
 * are spawned with close-on-exec by default (libuv and node-pty both use
 * posix_spawn with POSIX_SPAWN_CLOEXEC_DEFAULT), so they never hold it.
 *
 * WHAT THIS DOES NOT STOP, said plainly: a same-user process that can change
 * the code the daemon loads (out/daemon, node_modules) can act as the daemon.
 * That is the same boundary the Electron app has; the daemon closes the other
 * door a same-user process had, the Node inspector (no-inspector.ts).
 *
 * Over it travels the IPC the renderer already speaks, unchanged: `invoke`
 * (ipcMain.handle), `send` (ipcMain.on) and, the other way, every
 * `webContents.send` of the owner window as an `event`. A request reaches the
 * handler Electron would have called, with an event naming the owner window
 * (electron-shim.ts · ownerDispatch), so the owner-only checks hold unchanged.
 *
 * Framing: one JSON object per line. A byte array crosses as {"$bytes": b64};
 * an object that already has a key starting with "$" is wrapped as
 * {"$obj": …} so content can never pass for bytes. A MessagePort cannot cross
 * (the renderer then dials its socket fallback).
 */
import type { Readable, Writable } from 'node:stream'

export type OwnerFrame =
  | { readonly t: 'invoke'; readonly id: number; readonly channel: string; readonly args: readonly unknown[] }
  | { readonly t: 'send'; readonly channel: string; readonly args: readonly unknown[] }

export type DaemonFrame =
  | { readonly t: 'result'; readonly id: number; readonly ok: true; readonly value: unknown }
  | { readonly t: 'result'; readonly id: number; readonly ok: false; readonly error: string }
  | { readonly t: 'event'; readonly channel: string; readonly args: readonly unknown[] }

export interface OwnerDispatch {
  /** The handler's answer, as ipcMain.handle would have returned it to the window. */
  invoke(channel: string, args: readonly unknown[]): Promise<unknown>
  /** ipcMain.on listeners, as a window's ipcRenderer.send would have reached them. */
  send(channel: string, args: readonly unknown[]): void
}

/** A line longer than this (in bytes) ends the link: no legitimate request is near it. */
export const MAX_LINE = 64 * 1024 * 1024
/** Requests in flight at once; more are refused, not queued. */
export const MAX_IN_FLIGHT = 1024
/** Bytes waiting for the owner to read: above it window events are dropped (never results). */
export const EVENT_BACKLOG = 64 * 1024 * 1024
/** Bytes waiting above which the owner is not reading at all: the link closes. */
export const HARD_BACKLOG = 256 * 1024 * 1024

const BYTES = '$bytes'
const ESCAPED = '$obj'

function encodeValue(value: unknown): unknown {
  if (value instanceof Uint8Array) return { [BYTES]: Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('base64') }
  if (Array.isArray(value)) return value.map(encodeValue)
  if (value !== null && typeof value === 'object') {
    const plain = typeof (value as { toJSON?: unknown }).toJSON === 'function' ? (value as { toJSON: () => unknown }).toJSON() : value
    if (plain === null || typeof plain !== 'object') return plain
    if (Array.isArray(plain)) return plain.map(encodeValue)
    const entries = Object.entries(plain as Record<string, unknown>).map(([key, inner]) => [key, encodeValue(inner)] as const)
    const object = Object.fromEntries(entries)
    return Object.keys(object).some((key) => key.startsWith('$')) ? { [ESCAPED]: object } : object
  }
  if (typeof value === 'bigint') throw new TypeError('a BigInt cannot cross the owner link')
  return value
}

/** One frame as a line of JSON. Throws on what JSON cannot carry (a cycle, a BigInt). */
export function encodeFrame(frame: DaemonFrame | OwnerFrame): string {
  return JSON.stringify(encodeValue(frame))
}

function decodeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decodeValue)
  if (value === null || typeof value !== 'object') return value
  const object = value as Record<string, unknown>
  const keys = Object.keys(object)
  if (keys.length === 1 && keys[0] === BYTES && typeof object[BYTES] === 'string') return new Uint8Array(Buffer.from(object[BYTES], 'base64'))
  if (keys.length === 1 && keys[0] === ESCAPED && object[ESCAPED] !== null && typeof object[ESCAPED] === 'object') {
    return Object.fromEntries(Object.entries(object[ESCAPED] as Record<string, unknown>).map(([key, inner]) => [key, decodeValue(inner)]))
  }
  return Object.fromEntries(keys.map((key) => [key, decodeValue(object[key])]))
}

/** The inverse of encodeFrame. */
export function decodeLine(line: string): unknown {
  return decodeValue(JSON.parse(line))
}

/** A frame from the owner, or null when the line is not one. */
export function readOwnerFrame(line: string): OwnerFrame | null {
  let value: unknown
  try {
    value = decodeLine(line)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null) return null
  const frame = value as Record<string, unknown>
  if (typeof frame.channel !== 'string' || frame.channel.length === 0 || !Array.isArray(frame.args)) return null
  if (frame.t === 'invoke' && Number.isSafeInteger(frame.id)) return { t: 'invoke', id: frame.id as number, channel: frame.channel, args: frame.args }
  if (frame.t === 'send') return { t: 'send', channel: frame.channel, args: frame.args }
  return null
}

export interface OwnerLink {
  /** Hand the owner one of its window's events. False when it was not sent (closed, or the owner is behind). */
  emit(channel: string, args: readonly unknown[]): boolean
  close(): void
  readonly closed: Promise<void>
}

/**
 * Splits a byte stream into lines, looking for a newline only in what is new
 * (linear in the input), and refusing a line over MAX_LINE bytes.
 */
class LineReader {
  private parts: Buffer[] = []
  private size = 0

  /** The complete lines in this chunk, or null once a line is over the limit. */
  push(chunk: Buffer): string[] | null {
    const lines: string[] = []
    let start = 0
    let newline = chunk.indexOf(0x0a, start)
    while (newline !== -1) {
      const piece = chunk.subarray(start, newline)
      if (this.size + piece.length > MAX_LINE) return null
      lines.push(Buffer.concat([...this.parts, piece]).toString('utf8'))
      this.parts = []
      this.size = 0
      start = newline + 1
      newline = chunk.indexOf(0x0a, start)
    }
    const rest = chunk.subarray(start)
    if (this.size + rest.length > MAX_LINE) return null
    if (rest.length > 0) {
      this.parts.push(Buffer.from(rest))
      this.size += rest.length
    }
    return lines
  }
}

/**
 * Serve the owner over a duplex pipe. Requests run concurrently (up to
 * MAX_IN_FLIGHT); each answer carries its request's id. The link closes when
 * the pipe ends or errors, a line is over MAX_LINE, or the owner stops reading
 * for HARD_BACKLOG bytes.
 */
export function startOwnerLink(input: Readable, output: Writable, dispatch: OwnerDispatch, log: (line: string) => void = console.error): OwnerLink {
  let open = true
  let inFlight = 0
  let droppedEvents = 0
  let resolveClosed: () => void = () => undefined
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve
  })
  const close = (): void => {
    if (!open) return
    open = false
    input.removeAllListeners('data')
    resolveClosed()
  }

  const writeLine = (line: string): void => {
    output.write(`${line}\n`)
    if (output.writableLength > HARD_BACKLOG) {
      log('[cookrewd] the owner stopped reading: closing the owner link')
      close()
    }
  }

  const writeResult = (id: number, outcome: { ok: true; value: unknown } | { ok: false; error: string }): void => {
    if (!open) return
    let line: string
    try {
      line = encodeFrame(outcome.ok ? { t: 'result', id, ok: true, value: outcome.value } : { t: 'result', id, ok: false, error: outcome.error })
    } catch (error) {
      line = encodeFrame({ t: 'result', id, ok: false, error: `the answer cannot cross the owner link: ${String(error)}` })
    }
    writeLine(line)
  }

  const emit = (channel: string, args: readonly unknown[]): boolean => {
    if (!open) return false
    if (output.writableLength > EVENT_BACKLOG) {
      droppedEvents += 1
      if (droppedEvents === 1 || droppedEvents % 1000 === 0) log(`[cookrewd] the owner is behind: ${droppedEvents} window event(s) dropped`)
      return false
    }
    let line: string
    try {
      line = encodeFrame({ t: 'event', channel, args })
    } catch (error) {
      log(`[cookrewd] the ${channel} event cannot cross the owner link: ${String(error)}`)
      return false
    }
    writeLine(line)
    return true
  }

  const handle = (frame: OwnerFrame): void => {
    if (frame.t === 'send') {
      try {
        dispatch.send(frame.channel, frame.args)
      } catch (error) {
        log(`[cookrewd] owner send ${frame.channel} failed: ${String(error)}`)
      }
      return
    }
    if (inFlight >= MAX_IN_FLIGHT) {
      writeResult(frame.id, { ok: false, error: `too many requests in flight (${MAX_IN_FLIGHT})` })
      return
    }
    inFlight += 1
    let answer: Promise<unknown>
    try {
      answer = dispatch.invoke(frame.channel, frame.args)
    } catch (error) {
      answer = Promise.reject(error)
    }
    answer
      .then(
        (value) => writeResult(frame.id, { ok: true, value: value === undefined ? null : value }),
        (error: unknown) => writeResult(frame.id, { ok: false, error: error instanceof Error ? error.message : String(error) })
      )
      .finally(() => {
        inFlight -= 1
      })
  }

  const lines = new LineReader()
  input.on('data', (chunk: Buffer | string) => {
    const complete = lines.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
    if (complete === null) {
      log('[cookrewd] owner line over the limit: closing the owner link')
      close()
      return
    }
    for (const line of complete) {
      if (!open) return
      if (line.trim().length === 0) continue
      const frame = readOwnerFrame(line)
      if (frame === null) log('[cookrewd] owner sent a line that is not a frame; ignored')
      else handle(frame)
    }
  })
  input.on('end', close)
  input.on('error', (error) => {
    log(`[cookrewd] owner link error: ${String(error)}`)
    close()
  })
  output.on('error', (error) => {
    log(`[cookrewd] owner link write error: ${String(error)}`)
    close()
  })

  return { emit, close, closed }
}
