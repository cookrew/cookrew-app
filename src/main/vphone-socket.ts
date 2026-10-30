import net from 'node:net'
import { homedir } from 'node:os'
import path from 'node:path'

/**
 * THE MACHINE'S OWN DOOR: `<library>/<machine>/vphone.sock`.
 *
 * Every vphone launch serves a Unix socket that takes one JSON object per
 * connection and answers one JSON line; `{"t":"rpc"}` reaches any vphoned
 * method (vphone-cli · Skills/vphone-guest-control/references/guest-socket.md).
 * It is chosen over the optional TCP API because it needs no token and no
 * port: the socket is owner-only on disk, exactly like the pairing token.
 *
 * Injected behind `VphoneGuest`, so the instance and its tests never need a
 * running VM.
 */

export interface VphoneGuest {
  /** True when vphoned answers on the socket. False, never a throw, for "not running". */
  ping(): Promise<boolean>
  /** One vphoned method; throws the guest's own sentence on a refusal. */
  rpc(method: string, params: Record<string, unknown>): Promise<unknown>
}

export interface SocketGuestOptions {
  /** For the sentence when the socket is missing. */
  readonly machine?: string
  readonly timeoutMs?: number
}

export const VPHONE_SOCKET_TIMEOUT_MS = 10_000

/** `~/.vphone/machines`, or wherever `VPHONE_LIBRARY` points. */
export const defaultVphoneLibrary = (): string =>
  process.env.VPHONE_LIBRARY?.trim() || path.join(homedir(), '.vphone', 'machines')

export const vphoneSocketPath = (machine: string, library: string = defaultVphoneLibrary()): string =>
  path.join(library, machine, 'vphone.sock')

interface SocketReply {
  ok?: unknown
  error?: unknown
  result?: unknown
}

const exchange = (socketPath: string, request: unknown, timeoutMs: number, machine: string): Promise<SocketReply> =>
  new Promise((resolve, reject) => {
    let data = ''
    let settled = false
    const socket = net.connect(socketPath)
    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      fn()
    }
    const timer = setTimeout(
      () => finish(() => reject(new Error(`vphone machine '${machine}' did not answer within ${timeoutMs} ms`))),
      timeoutMs
    )
    const parse = (): void => {
      const line = data.split('\n').find((part) => part.trim().length > 0)
      if (line === undefined) {
        finish(() => reject(new Error(`vphone machine '${machine}' closed the socket without a reply`)))
        return
      }
      try {
        const reply = JSON.parse(line) as SocketReply
        finish(() => resolve(reply))
      } catch {
        finish(() => reject(new Error(`vphone machine '${machine}' answered something that is not JSON`)))
      }
    }
    socket.setEncoding('utf8')
    socket.on('connect', () => socket.write(`${JSON.stringify(request)}\n`))
    socket.on('data', (chunk: string) => {
      data += chunk
      if (data.includes('\n')) parse()
    })
    socket.on('end', parse)
    socket.on('close', () => {
      if (!settled) parse()
    })
    socket.on('error', (error: NodeJS.ErrnoException) =>
      finish(() =>
        reject(
          new Error(
            `vphone machine '${machine}' is not running (no socket at ${socketPath}${error.code ? `: ${error.code}` : ''})`
          )
        )
      )
    )
  })

export const createSocketGuest = (socketPath: string, options: SocketGuestOptions = {}): VphoneGuest => {
  const machine = options.machine ?? path.basename(path.dirname(socketPath))
  const timeoutMs = options.timeoutMs ?? VPHONE_SOCKET_TIMEOUT_MS
  return {
    ping: async () => {
      try {
        const reply = await exchange(socketPath, { t: 'ping' }, timeoutMs, machine)
        return reply.ok === true
      } catch {
        return false
      }
    },
    rpc: async (method, params) => {
      // `screen: false`: the socket would otherwise attach a small grayscale
      // JPEG to every rpc reply, which is neither the real screen nor wanted.
      const reply = await exchange(socketPath, { t: 'rpc', method, params, screen: false }, timeoutMs, machine)
      if (reply.ok !== true) {
        throw new Error(typeof reply.error === 'string' ? reply.error : `vphoned refused ${method}`)
      }
      return reply.result
    }
  }
}
