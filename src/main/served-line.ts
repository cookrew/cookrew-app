import type http from 'node:http'
import { startSse } from './mobile-http'
import type { ServedTemplate } from './session-served'
import type { ServedResponse } from './served-endpoints'

/**
 * THE CALLER'S LINE — the orch's real terminal, served over the same door.
 *
 * A caller who imported a served team holds ONE card: the orch of the session
 * workspace minted for them at the author's app. This module is that card's
 * transport — the same PTY-direct experience a LOCAL import gets from
 * orch-mirror.mjs, behind the served gate instead of the pairing token:
 *
 *   GET  /line         admission ladder (401 → 429 → 402) → mint or reuse →
 *                      SSE: hello (geometry), data (faithful ANSI), exit.
 *                      Opening the line IS session admission: the 402 fires
 *                      here, at session start only (R5), never mid-stream.
 *   POST /line/raw     real keystrokes into the caller's OWN orch. Requires an
 *                      already-open session — raw input never mints.
 *   POST /line/resize  the viewer's geometry, so frames serialize at its size.
 *
 * The caller never names a terminal, session, or workspace id: every route
 * resolves the conductor from the verified Bearer subject alone, exactly like
 * the transcript reads. What confines the keystrokes is the session sandbox
 * (Seatbelt profile + env scrub) the mint installed — the caller is typing
 * into the agent TUI of a workspace that exists only for them, and the
 * no-orch serve refusal guarantees that TUI is an agent, not a bare shell.
 */

/** The slice of a PtySession the line needs; structural so tests stub it. */
export interface LinePtyView {
  geometry(): unknown
  replayFrame(): string
  resize(cols: number, rows: number): void
  on(event: string, listener: (payload: string) => void): unknown
  removeListener(event: string, listener: (payload: string) => void): unknown
}

export interface ServedLineDeps {
  /** The shared admission ladder (served-endpoints.gateCaller), pre-bound. */
  gate(
    headers: Record<string, string | undefined>
  ): Promise<{ ok: true; claims: { sub: string } } | { ok: false; response: ServedResponse }>
  admit(serviceId: string, sub: string): Promise<{ sessionId: string; created: boolean }>
  conductorFor(sessionId: string): string | null
  /** The open session's conductor, or null — resolved from the subject only. */
  openConductorFor(serviceId: string, sub: string): string | null
  /** Boot the conductor's PTY mirror and wait (bounded) for residency. */
  attach(conductorId: string): Promise<LinePtyView | null>
  /** Keystrokes through THE submit primitive — classified, never raw-splatted. */
  write(conductorId: string, data: string): Promise<{ ok: boolean; reason?: string }>
}

/** A single /raw body is a burst of keystrokes, not a file upload. */
const MAX_RAW_BYTES = 8192

const writeJson = (
  response: http.ServerResponse,
  status: number,
  body: unknown,
  headers?: Record<string, string>
): void => {
  for (const [key, value] of Object.entries(headers ?? {})) response.setHeader(key, value)
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
}

/**
 * Handle one request against the line surface. Returns false for a path this
 * surface does not own; true when the response was written (streams included).
 */
export async function handleServedLineRoute(
  deps: ServedLineDeps,
  template: ServedTemplate,
  method: string,
  pathname: string,
  input: {
    headers: Record<string, string | undefined>
    body: unknown
    request: http.IncomingMessage
    response: http.ServerResponse
  }
): Promise<boolean> {
  const { response } = input

  if (method === 'GET' && pathname === '/line') {
    const gate = await deps.gate(input.headers)
    if (!gate.ok) {
      writeJson(response, gate.response.status, gate.response.body, gate.response.headers)
      return true
    }
    const { sessionId, created } = await deps.admit(template.serviceId, gate.claims.sub)
    const conductorId = deps.conductorFor(sessionId)
    if (conductorId === null) {
      writeJson(response, 503, { error: 'the crew is not answering — try again shortly' })
      return true
    }
    const view = await deps.attach(conductorId)
    if (view === null) {
      writeJson(response, 503, { error: 'the line could not come up — try again shortly' })
      return true
    }
    const send = startSse(response)
    // Geometry first, then the frame — a frame applied before the client knows
    // the mirror's size gets re-wrapped and absolute deltas land in the wrong
    // cells (the same ordering the phone stream learned the hard way).
    send('hello', { ...(view.geometry() as object), sessionId, created })
    send('data', view.replayFrame())
    const onData = (data: string): void => send('data', data)
    const onReplay = (frame: string): void => send('data', frame)
    const onExit = (): void => send('exit', {})
    view.on('data', onData)
    view.on('replay', onReplay)
    view.on('exit', onExit)
    // Both sides: an aborted fetch closes the request, a dying socket closes
    // the response first. detach() is idempotent, so whichever fires wins.
    let detached = false
    const detach = (): void => {
      if (detached) return
      detached = true
      view.removeListener('data', onData)
      view.removeListener('replay', onReplay)
      view.removeListener('exit', onExit)
    }
    input.request.on('close', detach)
    response.on('close', detach)
    return true
  }

  if (method === 'POST' && (pathname === '/line/raw' || pathname === '/line/resize')) {
    const gate = await deps.gate(input.headers)
    if (!gate.ok) {
      writeJson(response, gate.response.status, gate.response.body, gate.response.headers)
      return true
    }
    // No mint on input: a keystroke against a session that was never opened is
    // the same absence a transcript read reports — 404, not a fresh charge.
    const conductorId = deps.openConductorFor(template.serviceId, gate.claims.sub)
    if (conductorId === null) {
      writeJson(response, 404, {})
      return true
    }
    const body = (input.body ?? {}) as Record<string, unknown>
    if (pathname === '/line/resize') {
      const cols = Number(body.cols)
      const rows = Number(body.rows)
      if (Number.isInteger(cols) && Number.isInteger(rows) && cols > 0 && rows > 0) {
        const view = await deps.attach(conductorId)
        view?.resize(Math.min(cols, 500), Math.min(rows, 300))
      }
      writeJson(response, 200, { ok: true })
      return true
    }
    const data = typeof body.data === 'string' ? body.data : ''
    if (data.length === 0) {
      writeJson(response, 200, { ok: true })
      return true
    }
    if (Buffer.byteLength(data, 'utf8') > MAX_RAW_BYTES) {
      writeJson(response, 413, { error: 'keystroke burst too large' })
      return true
    }
    const verdict = await deps.write(conductorId, data)
    if (!verdict.ok) {
      writeJson(response, 409, { error: verdict.reason ?? 'refused' })
      return true
    }
    writeJson(response, 200, { ok: true })
    return true
  }

  return false
}
