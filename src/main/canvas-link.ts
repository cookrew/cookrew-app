import http from 'node:http'
import https from 'node:https'
import { decodeFrame, encodeFrame } from '../shared/relay-frame'

/**
 * THE DESKTOP'S OWN LINE AT cookrew.dev — the third path, and the only one
 * that works from anywhere.
 *
 * A phone on LTE cannot dial the Mac in someone's kitchen, so the Mac dials
 * OUT and holds a pair of requests open: a GET whose response streams frames
 * DOWN, and a chunked POST whose body streams frames UP. Between them they are
 * a socket. This file owns that pair and nothing else — what travels over it
 * is canvas-bridge's problem, which is why the two are separate modules.
 *
 * IT IS THE SAME ARRANGEMENT relay-dial.ts uses for a served DOOR, and
 * deliberately not the same code. A door presents a short-lived ticket for a
 * name it chose; a canvas presents THIS DESKTOP'S OWN v2 session and gets a
 * name the registry builds from the token's claims. One transport, two
 * credentials, and merging them would mean a bug in either could hand a door's
 * traffic to a canvas.
 *
 * THREE RULES THAT ARE EASY TO GET WRONG:
 *
 *   THE DOWNLINK FIRST, ALWAYS. The registry answers an uplink for a line it
 *   is not already holding with `409 no_link` — a refusal that reads exactly
 *   like a credential problem and would send anyone debugging it to the wrong
 *   file. So the uplink is not opened until `ready` has arrived.
 *
 *   A TAKEN NAME IS NOT FOUGHT OVER. `abort{reason:'name-taken'}` means
 *   another link holds this desktop's name — usually this same app a moment
 *   ago, whose downlink the registry has not yet noticed is dead. Redialling
 *   immediately would be two processes trading the name forever, so it backs
 *   off with jitter like every other failure.
 *
 *   HELD MEANS BOTH HALVES CARRY BYTES. `held()` is what reach.ts publishes as
 *   `relay: true`, and a card claiming a relay that is not carrying is a phone
 *   sent down a path that receives every request and answers none. So the pong
 *   goes UP in answer to a ping that came DOWN — the only proof either end
 *   ever gets — and a line that goes quiet is dropped rather than believed.
 */

/** Frames from the relay, as lines. */
export interface LinkDownlink {
  onLine(listener: (line: string) => void): void
  onEnd(listener: (why: string) => void): void
  close(): void
}

/** Frames to the relay, as lines on a body that never finishes. */
export interface LinkUplink {
  write(line: string): void
  onEnd(listener: (why: string) => void): void
  close(): void
}

/**
 * The two halves, as something a test can stand up without a network.
 *
 * The default speaks real HTTP because the fake relay in the tests IS a real
 * server: a transport mocked at this seam would prove the frames match the
 * mock, and the frames are exactly what has to match the registry.
 */
export interface LinkTransport {
  readonly down: (url: string, token: string) => LinkDownlink
  readonly up: (url: string, token: string) => LinkUplink
}

/** Who this desktop is, as far as the registry is concerned. */
export interface CanvasCredential {
  /** The v2 session token of THIS desktop. Never logged. */
  readonly token: string
  readonly deviceId: string
}

export interface CanvasLink {
  /** Begin dialling, and keep dialling. Idempotent. */
  readonly start: () => void
  readonly stop: () => void
  /** Is a line held right now — ready received, nothing aborted or closed? */
  readonly held: () => boolean
  /** `@user/desktop/<deviceId>`, as the relay confirmed it. */
  readonly name: () => string | null
  /** One frame up. Queued while the uplink is opening, dropped when there is no line. */
  readonly send: (line: string) => void
  /** Every frame down that is not the link's own housekeeping. */
  readonly onFrame: (listener: (line: string) => void) => () => void
  /** Held changed. Reach republishes from this. */
  readonly onChange: (listener: (held: boolean) => void) => () => void
  /** A line ended: whatever was riding it is over. */
  readonly onDrop: (listener: () => void) => () => void
  /** The account or the reachability toggle changed — reconsider now. */
  readonly refresh: () => void
}

export interface CanvasLinkDeps {
  /** Where the registry lives, e.g. https://cookrew.dev */
  readonly origin: () => string
  /**
   * The credential, or null when there is nothing to dial with: no account,
   * an expired session, or the owner turned reachability off. Null is not an
   * error — it is the owner saying no, and it is re-asked on every attempt.
   */
  readonly credential: () => CanvasCredential | null
  readonly transport?: LinkTransport
  readonly now?: () => number
  /** Returns its own canceller, so one shape covers timers in tests. */
  readonly schedule?: (fn: () => void, ms: number) => () => void
  readonly random?: () => number
  /** How long a line may say nothing before it is presumed dead. */
  readonly quietMs?: number
  /** How often the dial loop re-asks for a credential it did not have. */
  readonly idleMs?: number
  readonly log?: (message: string) => void
}

export const BACKOFF_MIN_MS = 1_000
export const BACKOFF_MAX_MS = 60_000
/** Three missed pings. The relay pings every 25 s. */
export const QUIET_MS = 75_000
/** How often a desktop with no account looks again. */
export const IDLE_MS = 30_000

/**
 * How long to wait before attempt `n`, with jitter.
 *
 * Jitter over the top half rather than the whole range: a fleet of desktops
 * whose registry just restarted must not redial in one wave, and a floor that
 * still grows is what keeps the hundredth retry cheap.
 */
export const backoffFor = (attempt: number, random: () => number): number => {
  const base = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** Math.max(0, attempt - 1))
  return Math.round(base / 2 + random() * (base / 2))
}

/** `https://cookrew.dev/v2/canvas/link/<deviceId>` */
export const linkUrl = (origin: string, deviceId: string): string =>
  `${origin.replace(/\/+$/, '')}/v2/canvas/link/${encodeURIComponent(deviceId)}`

const defaultSchedule = (fn: () => void, ms: number): (() => void) => {
  const handle = setTimeout(fn, ms)
  handle.unref?.()
  return () => clearTimeout(handle)
}

/** Node's http/https, as the two halves. Nothing here is Electron-specific. */
export const httpTransport = (): LinkTransport => ({
  down: (url, token) => {
    const lines: ((line: string) => void)[] = []
    const ends: ((why: string) => void)[] = []
    let over = false
    const finish = (why: string): void => {
      if (over) return
      over = true
      ends.forEach((listener) => listener(why))
    }
    const agent = url.startsWith('https:') ? https : http
    const request = agent.request(
      url,
      { method: 'GET', headers: { authorization: `Bearer ${token}`, accept: 'application/x-ndjson' } },
      (response) => {
        if (response.statusCode !== 200) {
          response.resume()
          finish(`the registry refused the line (${response.statusCode ?? 0})`)
          return
        }
        let buffer = ''
        response.setEncoding('utf8')
        response.on('data', (text: string) => {
          buffer += text
          let at = buffer.indexOf('\n')
          while (at >= 0) {
            const line = buffer.slice(0, at)
            buffer = buffer.slice(at + 1)
            at = buffer.indexOf('\n')
            // The heartbeat is an empty line and needs no place in the protocol.
            if (line.length > 0) lines.forEach((listener) => listener(line))
          }
        })
        response.on('end', () => finish('the registry closed the line'))
        response.on('error', (error) => finish(String(error)))
      }
    )
    request.on('error', (error) => finish(String(error)))
    request.end()
    return {
      onLine: (listener) => void lines.push(listener),
      onEnd: (listener) => void ends.push(listener),
      close: () => {
        request.destroy()
        finish('closed')
      }
    }
  },
  up: (url, token) => {
    const ends: ((why: string) => void)[] = []
    let over = false
    const finish = (why: string): void => {
      if (over) return
      over = true
      ends.forEach((listener) => listener(why))
    }
    const agent = url.startsWith('https:') ? https : http
    // No content-length and no transfer-encoding of our own: this body ends
    // when the line does, and declaring chunked by hand makes Node announce a
    // framing it then does not apply — the frames arrive as an unparseable
    // body and the desktop looks silent while answering perfectly.
    const request = agent.request(
      url,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/x-ndjson' }
      },
      (response) => {
        response.resume()
        // 409 is the uplink racing its own downlink; anything else is a
        // refusal. Both end the line, and the dial loop tries again.
        if (response.statusCode !== 200) finish(`the registry refused the uplink (${response.statusCode ?? 0})`)
        else finish('the registry closed the uplink')
      }
    )
    request.on('error', (error) => finish(String(error)))
    return {
      write: (line) => {
        if (!request.writableEnded && !request.destroyed) request.write(`${line}\n`)
      },
      onEnd: (listener) => void ends.push(listener),
      close: () => {
        request.destroy()
        finish('closed')
      }
    }
  }
})

export const createCanvasLink = (deps: CanvasLinkDeps): CanvasLink => {
  const transport = deps.transport ?? httpTransport()
  const schedule = deps.schedule ?? defaultSchedule
  const random = deps.random ?? Math.random
  const log = deps.log ?? ((): void => undefined)
  const quietMs = deps.quietMs ?? QUIET_MS
  const idleMs = deps.idleMs ?? IDLE_MS

  const frameListeners = new Set<(line: string) => void>()
  const changeListeners = new Set<(held: boolean) => void>()
  const dropListeners = new Set<() => void>()

  let running = false
  let attempt = 0
  let holding = false
  let confirmed: string | null = null
  let down: LinkDownlink | null = null
  let up: LinkUplink | null = null
  /** Frames produced before the uplink exists, in order. */
  let queued: readonly string[] = []
  let cancelRetry: (() => void) | null = null
  let cancelQuiet: (() => void) | null = null

  const setHeld = (next: boolean): void => {
    if (holding === next) return
    holding = next
    changeListeners.forEach((listener) => listener(next))
  }

  const clearQuiet = (): void => {
    cancelQuiet?.()
    cancelQuiet = null
  }

  /** Nothing heard for three pings: the line looks open and carries nothing. */
  const armQuiet = (): void => {
    clearQuiet()
    cancelQuiet = schedule(() => end('the registry went quiet'), quietMs)
  }

  const end = (why: string): void => {
    const had = down !== null || up !== null || holding
    clearQuiet()
    const closingDown = down
    const closingUp = up
    down = null
    up = null
    queued = []
    confirmed = null
    closingUp?.close()
    closingDown?.close()
    if (had) {
      log(`canvas link: the line ended (${why})`)
      dropListeners.forEach((listener) => listener())
    }
    setHeld(false)
    if (running) retry()
  }

  const retry = (): void => {
    cancelRetry?.()
    attempt += 1
    const wait = backoffFor(attempt, random)
    cancelRetry = schedule(() => {
      cancelRetry = null
      dial()
    }, wait)
  }

  const openUplink = (credential: CanvasCredential, url: string): void => {
    if (up !== null) return
    const opened = transport.up(url, credential.token)
    up = opened
    for (const line of queued) opened.write(line)
    queued = []
    opened.onEnd((why) => {
      // NO UPLINK MEANS NOT REACHABLE, and the line must stop claiming
      // otherwise: a downlink whose uplink died receives every request and
      // answers none while the reach card still says relay.
      if (up === opened) end(why)
    })
  }

  const dial = (): void => {
    if (!running || down !== null) return
    const credential = deps.credential()
    if (!credential) {
      // Not an error and not a backoff: the owner has no account, or has
      // turned reachability off. Look again on a slow clock.
      cancelRetry?.()
      cancelRetry = schedule(() => {
        cancelRetry = null
        dial()
      }, idleMs)
      return
    }
    const url = linkUrl(deps.origin(), credential.deviceId)
    const opened = transport.down(url, credential.token)
    down = opened
    armQuiet()
    opened.onLine((line) => {
      if (down !== opened) return
      armQuiet()
      const frame = decodeFrame(line)
      if (!frame) return
      if (frame.t === 'ready') {
        confirmed = frame.name
        attempt = 0
        openUplink(credential, url)
        setHeld(true)
        log(`canvas link: holding ${frame.name}`)
        return
      }
      if (frame.t === 'ping') {
        // THE PULSE, answered on the uplink: the pong is the registry's only
        // proof that this desktop's answers still arrive.
        send(encodeFrame({ t: 'pong', at: frame.at }))
        return
      }
      if (frame.t === 'abort' && frame.id === 'x') {
        // Another link holds this name. Do not fight it.
        end(`the registry would not serve this name (${frame.reason})`)
        return
      }
      frameListeners.forEach((listener) => listener(line))
    })
    opened.onEnd((why) => {
      if (down === opened) end(why)
    })
  }

  const send = (line: string): void => {
    if (!running) return
    if (up === null) {
      // Answers can be ready before the uplink is, on the very first request.
      if (queued.length < 256) queued = [...queued, line]
      return
    }
    up.write(line)
  }

  return {
    start: () => {
      if (running) return
      running = true
      attempt = 0
      dial()
    },
    stop: () => {
      running = false
      cancelRetry?.()
      cancelRetry = null
      end('the desktop withdrew')
    },
    held: () => holding,
    name: () => confirmed,
    send,
    onFrame: (listener) => {
      frameListeners.add(listener)
      return () => void frameListeners.delete(listener)
    },
    onChange: (listener) => {
      changeListeners.add(listener)
      return () => void changeListeners.delete(listener)
    },
    onDrop: (listener) => {
      dropListeners.add(listener)
      return () => void dropListeners.delete(listener)
    },
    refresh: () => {
      if (!running) return
      // THE TOGGLE GOES BOTH WAYS. An owner switching reachability off must
      // take the line down, not merely stop republishing: a held line keeps
      // answering, and the reach card would go on offering a path the owner
      // has just said no to.
      if (deps.credential() === null) {
        if (down !== null || holding) end('reachability is off')
        return
      }
      if (down !== null) return
      cancelRetry?.()
      cancelRetry = null
      attempt = 0
      dial()
    }
  }
}
