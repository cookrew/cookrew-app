import type http from 'node:http'
import { createRecordReader } from '../shared/canvas-seal-wire'
import { createSeal2Connection, type Seal2Connection } from '../shared/seal2/connection'
import type { Seal2Session } from '../shared/seal2/records'
import type { Seal2Stream } from '../shared/seal2/stream'

/**
 * THE MAC'S HALF OF ONE COOKREW-SEAL/2 SESSION, on the relay's long-poll and
 * POST (canvas-seal-terminus.ts routes to it; seal2/http-link.ts is the
 * caller's half). The terminus treats it exactly as a v1 session: the same
 * listen, up, tick and close, and the same limits on how much it holds.
 */

/** A session with nobody listening for this long is over. The caller shakes hands again. */
export const SEAL2_DOWN_GRACE_MS = 120_000
/** Past this, a new listen waits for the old line to drain. */
const LISTEN_HIGH = 8 * 1024 * 1024

export interface Seal2LiveDeps {
  readonly session: Seal2Session
  /** A stream the caller opened. Respond to it, or abort it. */
  serve(stream: Seal2Stream): void
  now(): number
  log(message: string): void
  onClosed(): void
  /** Bytes on their way to the caller and not gone yet, the relay line's own socket included. */
  socketBacklog(socket: http.ServerResponse | null): number
}

export interface Seal2Live {
  /** The status the POST answers with. */
  up(body: Uint8Array): Promise<number>
  listen(response: http.ServerResponse, from: number): void
  tick(at: number): void
  close(why: string): void
  listening(): boolean
  retained(): number
  held(): number
  lastHeard(): number
  readonly connection: Seal2Connection
}

export function openSeal2Live(deps: Seal2LiveDeps): Seal2Live {
  const { now, log } = deps
  let down: http.ServerResponse | null = null
  let downGone = now()

  const connection = createSeal2Connection({
    session: deps.session,
    role: 'responder',
    send: (wire) => void down?.write(wire),
    backlog: () => deps.socketBacklog(down),
    onStream: deps.serve,
    onClose: (why) => {
      down?.end()
      down = null
      log(`canvas seal v2: session ended, ${why}`)
      deps.onClosed()
    },
    now,
    log
  })

  return {
    connection,
    async up(raw) {
      let records
      try {
        records = createRecordReader().push(raw)
      } catch {
        return 400
      }
      const answers = await connection.receive(records)
      if (answers.includes('forged')) return 400
      return answers.includes('ahead') ? 409 : 204
    },
    listen(response, from) {
      // Every listen writes out all that is unacked, and the relay can see this id: a
      // line that has not drained the last one waits, or repeated GETs fill this Mac's memory.
      if (connection.stats().retained > 0 && deps.socketBacklog(down) > LISTEN_HIGH) {
        response.writeHead(503, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        response.end(JSON.stringify({ error: 'the line is still full' }))
        return
      }
      down?.end()
      down = response
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store, no-transform', 'x-accel-buffering': 'no' })
      response.flushHeaders()
      for (const wire of connection.replay(from)) response.write(wire)
      // The relay holds a head back until the first bytes behind it.
      connection.ping()
      response.on('drain', () => connection.drained())
      response.on('close', () => {
        if (down !== response) return
        down = null
        downGone = now()
      })
    },
    tick(at) {
      if (connection.closed) return
      if (down === null && at - Math.max(connection.lastHeard(), downGone) > SEAL2_DOWN_GRACE_MS) return connection.close('nobody was listening')
      connection.tick(at)
    },
    close: (why) => connection.close(why),
    listening: () => down !== null,
    retained: () => connection.stats().retained,
    held: () => connection.stats().retained,
    lastHeard: () => connection.lastHeard()
  }
}
