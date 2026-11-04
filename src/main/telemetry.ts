import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { writeFileAtomic } from './atomic-file'
import { registryOrigin } from './registry-origin'
import {
  FUNNEL_EVENTS,
  FUNNEL_ROUTE,
  TELEMETRY_DEFAULT_ON,
  dayOf,
  isFunnelDay,
  isFunnelEvent,
  osFamilyOf,
  readFunnelPayload,
  type FunnelEvent,
  type FunnelPayload,
  type TelemetryStatus
} from '../shared/funnel-events'

/**
 * THE FUNNEL'S CLIENT: `emit('phone_paired')`, and everything else is here.
 *
 * AT MOST ONCE PER INSTALL. The row goes to ~/.cookrew/telemetry.json before the
 * request does, so a crash between the two costs a count, never a double. A
 * ledger that will not take the write sends nothing: unsure means no.
 *
 * OFF MEANS IT STAYS HERE. While off (the default, shared/funnel-events.ts) an
 * event is a row in that file and nothing else: no request and no install id,
 * so an install that never opts in has no identifier at all. Turning it on is
 * forward-looking only. What was counted while off stays `local` for good, and
 * a `queued` row is demoted the moment the switch goes off.
 *
 * NEVER A SERVED SESSION. A process carrying the sandbox's marks (session-env.ts)
 * does nothing at all, and `first_turn_done` must say whether its card was
 * served: turns run on a stranger's cards in this same process, and the type
 * makes forgetting that a compile error.
 *
 * SILENT. emit never throws and never waits. Tries are counted on disk, so the
 * bound holds across restarts, and running out of them is a count lost.
 */

export const SEND_TRIES = 3
const SEND_TIMEOUT_MS = 5_000
/** 2 s, 8 s. Three tries is a short outage; a long one is simply not counted. */
export const sendBackoffMs = (attempt: number): number => attempt * attempt * 2_000

type RowStatus = 'local' | 'queued' | 'sent' | 'dropped'

interface Row {
  readonly day: string
  readonly status: RowStatus
  readonly tries: number
}

interface Ledger {
  /** Only ever set by the row: unset means the default rules. */
  readonly choice?: boolean
  /** Minted at the first send, so an install that stays off never has one. */
  readonly installId?: string
  readonly events: Readonly<Partial<Record<FunnelEvent, Row>>>
}

export interface TelemetryDeps {
  readonly appVersion: string
  /** Directory holding telemetry.json. Defaults to ~/.cookrew. */
  readonly base?: string
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly platform?: string
  readonly now?: () => number
  /** Node's fetch, on purpose: Electron's net.fetch would bring the session's cookies. */
  readonly fetch?: (url: string, init: RequestInit) => Promise<Response>
  readonly origin?: () => string
  readonly sleep?: (ms: number) => Promise<void>
  readonly mintId?: () => string
  readonly defaultOn?: boolean
}

/** The caller's word on where this happened. Checked, and never sent. */
export interface EmitFrom {
  readonly served?: boolean
}

export interface Emit {
  (event: 'first_turn_done', from: { readonly served: boolean }): void
  (event: Exclude<FunnelEvent, 'first_turn_done'>, from?: EmitFrom): void
}

export interface Telemetry {
  readonly emit: Emit
  readonly status: () => TelemetryStatus
  readonly setOn: (on: boolean) => TelemetryStatus
  /** Picks up what a previous run left queued. */
  readonly resume: () => Promise<void>
  /** Resolves when nothing is in flight. For tests and nothing else. */
  readonly settled: () => Promise<void>
}

const dataDir = (base?: string): string => base ?? path.join(homedir(), '.cookrew')

export const telemetryFile = (base?: string): string => path.join(dataDir(base), 'telemetry.json')

/** What a fresh home holds once the workspace store has run at least once. */
const PRIOR_DATA = ['registry.json', 'workspace.json', 'workspaces']

/**
 * First run, or an upgrade? Without this every existing install would fire
 * `installed` on the update that ships it. Must be asked before the store
 * writes its first file. Unsure reads as an upgrade: a missing count is honest,
 * an invented install is not.
 */
export function isFreshInstall(base?: string, exists: (file: string) => boolean = existsSync): boolean {
  try {
    return !PRIOR_DATA.some((name) => exists(path.join(dataDir(base), name)))
  } catch {
    return false
  }
}

const isRowStatus = (value: unknown): value is RowStatus =>
  value === 'local' || value === 'queued' || value === 'sent' || value === 'dropped'

const readRow = (value: unknown): Row | null => {
  if (typeof value !== 'object' || value === null) return null
  const { day, status, tries } = value as Record<string, unknown>
  if (!isFunnelDay(day) || !isRowStatus(status)) return null
  return { day, status, tries: typeof tries === 'number' ? tries : 0 }
}

/**
 * A ledger that exists and cannot be read may hold a "no". Reading it as empty
 * would forget that choice and re-fire every event, so it reads as off with
 * everything already fired.
 */
const sealedLedger = (day: string): Ledger => ({
  choice: false,
  events: Object.fromEntries(FUNNEL_EVENTS.map((event) => [event, { day, status: 'local', tries: 0 } satisfies Row]))
})

const parseLedger = (text: string): Ledger | null => {
  const parsed: unknown = JSON.parse(text)
  if (typeof parsed !== 'object' || parsed === null) return null
  const { choice, installId, events } = parsed as Record<string, unknown>
  const rows = Object.entries(typeof events === 'object' && events !== null ? events : {}).flatMap(([event, value]) => {
    const row = readRow(value)
    return isFunnelEvent(event) && row !== null ? [[event, row] as const] : []
  })
  return {
    ...(typeof choice === 'boolean' ? { choice } : {}),
    ...(typeof installId === 'string' ? { installId } : {}),
    events: Object.fromEntries(rows)
  }
}

const loadLedger = (file: string, day: string): Ledger => {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? { events: {} } : sealedLedger(day)
  }
  try {
    return parseLedger(text) ?? sealedLedger(day)
  } catch {
    return sealedLedger(day)
  }
}

const unrefSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms).unref?.()
  })

type Outcome = 'sent' | 'refused' | 'retry'

export function createTelemetry(deps: TelemetryDeps): Telemetry {
  const env = deps.env ?? process.env
  const now = deps.now ?? Date.now
  const file = telemetryFile(deps.base)
  const line = deps.fetch ?? ((url: string, init: RequestInit): Promise<Response> => fetch(url, init))
  const origin = deps.origin ?? registryOrigin
  const sleep = deps.sleep ?? unrefSleep
  const mintId = deps.mintId ?? randomUUID
  const defaultOn = deps.defaultOn ?? TELEMETRY_DEFAULT_ON
  const sandboxed = env.COOKREW_SERVED === '1' || (env.COOKREW_SESSION ?? '') !== ''
  const locked = sandboxed || env.COOKREW_TELEMETRY === '0'

  let ledger = sandboxed ? { events: {} } : loadLedger(file, dayOf(now()))
  let running: Promise<void> | null = null

  const isOn = (): boolean => !locked && (ledger.choice ?? defaultOn)
  const status = (): TelemetryStatus => ({ on: isOn(), locked })

  /** To disk first; the state in memory only ever says what the file says. */
  const commit = (next: Ledger): void => {
    writeFileAtomic(file, `${JSON.stringify(next, null, 2)}\n`)
    ledger = next
  }

  const withRow = (from: Ledger, event: FunnelEvent, row: Row): Ledger => ({
    ...from,
    events: { ...from.events, [event]: row }
  })

  const patch = (event: FunnelEvent, change: Partial<Row>): void => {
    const row = ledger.events[event]
    if (row !== undefined) commit(withRow(ledger, event, { ...row, ...change }))
  }

  /** Off means off for what was waiting too: a queued row never leaves later. */
  const demoted = (from: Ledger): Ledger => ({
    ...from,
    events: Object.fromEntries(
      Object.entries(from.events).map(([event, row]) => [
        event,
        row.status === 'queued' ? { ...row, status: 'local' as const } : row
      ])
    )
  })

  const payloadFor = (event: FunnelEvent, row: Row): FunnelPayload | null => {
    if (ledger.installId === undefined) commit({ ...ledger, installId: mintId() })
    return readFunnelPayload({
      event,
      appVersion: deps.appVersion,
      osFamily: osFamilyOf(deps.platform ?? process.platform),
      installId: ledger.installId,
      day: row.day
    })
  }

  const post = async (payload: FunnelPayload): Promise<Outcome> => {
    try {
      const response = await line(`${origin()}${FUNNEL_ROUTE}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS)
      })
      if (response.ok) return 'sent'
      return response.status === 429 || response.status >= 500 ? 'retry' : 'refused'
    } catch {
      return 'retry'
    }
  }

  const deliver = async (event: FunnelEvent, first: Row): Promise<void> => {
    const payload = payloadFor(event, first)
    if (payload === null) return patch(event, { status: 'dropped' })
    // Bounded by this counter, so no state the file is in can make it spin; the
    // patch is what carries the count across a restart.
    for (let tries = first.tries + 1; tries <= SEND_TRIES; tries += 1) {
      // Checked before every try: turning off during a backoff demotes the row.
      if (ledger.events[event]?.status !== 'queued') return
      patch(event, { tries })
      const outcome = await post(payload)
      if (outcome === 'sent') return patch(event, { status: 'sent' })
      if (outcome === 'refused') break
      if (tries < SEND_TRIES) await sleep(sendBackoffMs(tries))
    }
    patch(event, { status: 'dropped' })
  }

  const nextQueued = (): readonly [FunnelEvent, Row] | null => {
    for (const event of Object.keys(ledger.events).filter(isFunnelEvent)) {
      const row = ledger.events[event]
      if (row?.status === 'queued') return [event, row]
    }
    return null
  }

  const drain = async (): Promise<void> => {
    for (let next = nextQueued(); next !== null && isOn(); next = nextQueued()) {
      await deliver(next[0], next[1])
    }
  }

  /** One sender at a time, however many events arrive. */
  const pump = (): Promise<void> => {
    running ??= drain()
      .catch(() => undefined)
      .finally(() => {
        running = null
      })
    return running
  }

  const record = (event: FunnelEvent, from?: EmitFrom): void => {
    if (sandboxed || from?.served === true || !isFunnelEvent(event)) return
    if (ledger.events[event] !== undefined) return
    const row: Row = { day: dayOf(now()), status: isOn() ? 'queued' : 'local', tries: 0 }
    try {
      commit(withRow(ledger, event, row))
    } catch {
      // Not on disk means another run could fire it again, so it does not go out.
      ledger = withRow(ledger, event, { ...row, status: 'local' })
      return
    }
    if (row.status === 'queued') void pump()
  }

  return {
    emit: (event: FunnelEvent, from?: EmitFrom): void => {
      try {
        record(event, from)
      } catch {
        // A funnel count is never worth an exception in somebody's pairing.
      }
    },
    status,
    setOn: (on) => {
      if (locked) return status()
      try {
        commit(on ? { ...ledger, choice: on } : demoted({ ...ledger, choice: on }))
      } catch {
        // The switch did not stick, and the row will show that.
      }
      return status()
    },
    resume: () => {
      if (sandboxed) return Promise.resolve()
      if (isOn()) return pump()
      try {
        if (nextQueued() !== null) commit(demoted(ledger))
      } catch {
        // Still queued on disk, and still only ever sent while on.
      }
      return Promise.resolve()
    },
    settled: () => running ?? Promise.resolve()
  }
}

/** `Emit` without its overloads: the public `emit` below has already applied them. */
type Fire = (event: FunnelEvent, from?: EmitFrom) => void

let started: Telemetry | null = null

/** Once, from main, as early as app.getVersion() can answer. */
export function startTelemetry(deps: TelemetryDeps): Telemetry {
  started = createTelemetry(deps)
  return started
}

/** For tests: back to the state where every emit is a no-op. */
export function stopTelemetry(): void {
  started = null
}

/**
 * THE ONE-LINE API. Does nothing before startTelemetry, so a test that imports
 * a call site can never write to a real home or reach a real registry.
 */
export const emit: Emit = (event: FunnelEvent, from?: EmitFrom): void => {
  if (started !== null) (started.emit as Fire)(event, from)
}

export const telemetryStatus = (): TelemetryStatus | null => started?.status() ?? null

export const setTelemetryOn = (on: boolean): TelemetryStatus | null => started?.setOn(on) ?? null

export const resumeTelemetry = (): Promise<void> => started?.resume() ?? Promise.resolve()
