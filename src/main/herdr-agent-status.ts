// Agent state, PUSHED by herdr — the signal Cookrew currently scrapes.
//
// WHAT THIS IS FOR
// ----------------
// turn-tracker decides a turn has ended by reading the screen: the PTY has been
// silent for N ms, the tail shows no spinner, and no "attention" pattern
// matched. Three inferences, each with its own failure mode, all derived from
// pixels an agent happened to paint.
//
// herdr tracks agent lifecycle directly for the panes it hosts and pushes every
// transition. Measured: five driven transitions produced five events, on ONE
// connection carrying seventeen pane subscriptions.
//
// WHY A CACHE AND NOT AN AWAIT
// ----------------------------
// turn-tracker's poll() is synchronous and runs on a timer. Making it async to
// query herdr would restructure the state machine around IO, which is the
// opposite of the goal. So this holds a socket open, updates a map as events
// arrive, and exposes a SYNCHRONOUS read. The IO is async; the reader is not.
//
// WHY pane_id IS SUBSCRIBED PER PANE
// ----------------------------------
// `pane.agent_status_changed` requires a pane_id — there is no "all panes"
// form. One connection can carry many subscriptions, so the feed subscribes to
// every Cookrew pane at once and re-subscribes when the pane set changes.

import net from 'node:net'
import { EventEmitter } from 'node:events'
import { execFileSync } from 'node:child_process'

export type HerdrStatus = 'idle' | 'working' | 'blocked' | 'done'

/** What the feed announces on 'status': herdr has a state for this session. */
export interface StatusObservation {
  sessionName: string
  status: HerdrStatus
}

/** A live socket the feed reads lines from. Narrowed for testability. */
export interface StatusSocket {
  on(event: 'data', cb: (chunk: string) => void): void
  on(event: 'close' | 'error', cb: () => void): void
  write(line: string): void
  end(): void
  /** net.Socket's immediate close; optional for small test/embedding adapters. */
  destroy?(): void
}

export interface StatusFeedOptions {
  session: string
  configPath: string
  /** Panes to watch: herdr pane id + the Cookrew session name in its label. */
  listPanes?: () => FeedPane[]
  resolveSocketPath?: () => string | null
  connect?: (socketPath: string) => StatusSocket
  /** Delay before reconnecting after a drop. */
  reconnectMs?: number
}

/**
 * One event line -> a status update, or null.
 *
 * `unknown` is a REAL update, not noise: it is herdr explicitly retracting a
 * state it can no longer stand behind, and it must ERASE the cached entry.
 * The first design skipped it, which left the previous status in the map —
 * and a stale `working` is the worst possible resident: turn-tracker's poll
 * returns early on `working`, so one retraction swallowed meant every
 * subsequent turn was held open forever (the frozen checkpoint rail,
 * 2026-08-09: the conductor's turn store stopped at the second the herdr
 * server died and never advanced through five hours of conversation).
 */
export function parseStatusEvent(
  line: string
): { paneId: string; status: HerdrStatus | 'unknown' } | null {
  let msg: { event?: string; data?: { pane_id?: unknown; agent_status?: unknown } }
  try {
    msg = JSON.parse(line) as typeof msg
  } catch {
    return null
  }
  if (msg?.event !== 'pane.agent_status_changed') return null
  const paneId = msg.data?.pane_id
  const status = msg.data?.agent_status
  if (typeof paneId !== 'string') return null
  if (
    status !== 'idle' &&
    status !== 'working' &&
    status !== 'blocked' &&
    status !== 'done' &&
    status !== 'unknown'
  ) {
    return null
  }
  return { paneId, status }
}

/** The socket for a named herdr session, from `session list --json`. */
export function socketPathFor(session: string, raw: string): string | null {
  try {
    const parsed = JSON.parse(raw) as { sessions?: { name?: string; socket_path?: string }[] }
    const row = parsed.sessions?.find((s) => s.name === session)
    // socket_path, not socket — the field is named differently from the
    // human-readable `session list` column header.
    return typeof row?.socket_path === 'string' ? row.socket_path : null
  } catch {
    return null
  }
}

/** A Cookrew pane as the feed needs it: id, session name, current state. */
export interface FeedPane {
  paneId: string
  label: string
  /** Current state, when herdr already knows one. */
  status?: HerdrStatus
}

/**
 * Labelled panes out of a `pane list` envelope; unlabelled ones are not ours.
 *
 * `agent_status` is carried through because the event stream alone leaves a
 * blind spot: events only fire on CHANGE, so a freshly started Cookrew knows
 * nothing about a pane until it happens to transition. Measured against a live
 * session — 17 panes, every one reporting `idle` to herdr, and the feed held a
 * status for none of them. The pane list is how that gap gets closed.
 */
export function panesFrom(raw: string): FeedPane[] {
  try {
    const parsed = JSON.parse(raw) as {
      result?: { panes?: { pane_id?: unknown; label?: unknown; agent_status?: unknown }[] }
    }
    return (parsed.result?.panes ?? []).flatMap((p) => {
      if (typeof p.pane_id !== 'string') return []
      if (typeof p.label !== 'string' || p.label.length === 0) return []
      const status = p.agent_status
      const known =
        status === 'idle' || status === 'working' || status === 'blocked' || status === 'done'
      return [{ paneId: p.pane_id, label: p.label, ...(known ? { status } : {}) }]
    })
  } catch {
    return []
  }
}

/**
 * Cached agent state, plus a PUSH door for consumers that care about the
 * moment rather than the value.
 *
 * The synchronous read (statusFor) is what turn-tracker's poll needs and the
 * reason this class exists. But "herdr now has a state for this pane" is an
 * EVENT, and one consumer — terminal.booted's boot timer — needs it as one:
 * the first known state on a new pane is the agent becoming reachable, and a
 * cache read a beat later cannot tell you when that happened. So 'status' is
 * emitted for every known-state observation, from the socket AND from the pane
 * list seed (which is the common path for a freshly created pane, because the
 * subscription is only made once the pane exists). `unknown` announces nothing:
 * it is a retraction, and a retraction is not a state.
 */
export class HerdrStatusFeed extends EventEmitter {
  private readonly options: StatusFeedOptions
  /** Cookrew session name -> latest status. Keyed by LABEL, not pane id. */
  private status = new Map<string, HerdrStatus>()
  /** herdr pane id -> Cookrew session name, refreshed with each subscription. */
  private labels = new Map<string, string>()
  private socket: StatusSocket | null = null
  private buffer = ''
  private stopped = false
  private reconnectTimer: NodeJS.Timeout | null = null
  private refreshQueued = false

  constructor(options: StatusFeedOptions) {
    super()
    this.options = options
  }

  /**
   * Record a known state and announce it.
   *
   * Announced on every observation, not only on a CHANGE: a consumer timing a
   * boot asks "is the agent there yet", and a pane that herdr re-reports as
   * still-idle answers that question just as well as a transition does. The
   * listeners are bounded and cheap; a missed announcement costs a sample,
   * a duplicate costs nothing.
   */
  private record(sessionName: string, status: HerdrStatus): void {
    this.status.set(sessionName, status)
    // record() fires from a socket data callback and from connect()'s seed
    // loop — a throwing listener (the chain reaches webContents.send, which
    // throws on a torn-down window during quit) must not escape into either.
    try {
      this.emit('status', { sessionName, status } satisfies StatusObservation)
    } catch (error) {
      console.error('[herdr-status] status listener failed:', error)
    }
  }

  /**
   * The latest status for a Cookrew session, or null when herdr has not said.
   *
   * Null is the important return: it means "no signal", and every caller falls
   * back to inferring. A pane herdr has never reported on, a feed that is not
   * connected, and a status of `unknown` are all indistinguishable here on
   * purpose — none of them is a fact a turn boundary should be decided on.
   */
  statusFor(sessionName: string): HerdrStatus | null {
    return this.status.get(sessionName) ?? null
  }

  /** True while the feed holds a live subscription. */
  get connected(): boolean {
    return this.socket !== null
  }

  start(): void {
    this.stopped = false
    this.connect()
  }

  stop(): void {
    this.stopped = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    this.replaceSocket(null)
    this.status.clear()
  }

  /**
   * Re-subscribe against the current pane set.
   *
   * Called when Cookrew creates or closes a terminal: subscriptions are
   * per-pane, so a pane that appears after the subscription was made would
   * otherwise never be reported on.
   */
  refresh(): void {
    if (this.stopped) return
    const panes = this.listPanes()
    if (panes.length === 0) {
      this.replaceSocket(null)
      this.labels.clear()
      this.status.clear()
      this.scheduleReconnect()
      return
    }

    const sameSubscriptions =
      this.socket !== null &&
      panes.length === this.labels.size &&
      panes.every((pane) => this.labels.has(pane.paneId))

    this.seed(panes)
    if (sameSubscriptions) return
    // Free the old descriptor BEFORE asking the pressured server for another.
    // Its late callbacks are identity-scoped and cannot affect the replacement.
    this.replaceSocket(null)
    this.connect(panes)
  }

  /**
   * Coalesce a synchronous terminal-spawn burst into one global pane refresh.
   *
   * A workspace switch constructs every incoming PtySession in one call stack.
   * Calling refresh() after each one used to run `session list` + `pane list`,
   * tear down the same socket, and rebuild an increasingly large subscription
   * N times. One microtask runs after the burst, when every new pane exists, so
   * it subscribes to the same final set without putting any wait on PTY bytes.
   */
  refreshSoon(): void {
    if (this.stopped || this.refreshQueued) return
    this.refreshQueued = true
    queueMicrotask(() => {
      this.refreshQueued = false
      // A microtask has no handler frame above it — an escape here is an
      // uncaught main-process exception, not a failed refresh.
      try {
        this.refresh()
      } catch (error) {
        console.error('[herdr-status] deferred refresh failed:', error)
      }
    })
  }

  private connect(knownPanes?: FeedPane[]): void {
    if (this.stopped || this.socket !== null) return
    const socketPath = this.resolveSocketPath()
    if (!socketPath) {
      this.scheduleReconnect()
      return
    }
    const panes = knownPanes ?? this.listPanes()
    if (panes.length === 0) {
      this.scheduleReconnect()
      return
    }

    let socket: StatusSocket
    try {
      socket = (this.options.connect ?? defaultConnect)(socketPath)
    } catch {
      this.scheduleReconnect()
      return
    }
    this.seed(panes)
    this.replaceSocket(socket)
    this.buffer = ''

    socket.on('data', (chunk) => {
      // A retiring socket can drain one last frame after its replacement is
      // current. That frame belongs to the old subscription inventory and must
      // not overwrite the freshly seeded state.
      if (this.socket === socket) this.ingest(chunk)
    })
    const disconnected = (): void => {
      // A refresh installs the replacement before the old socket's asynchronous
      // close callback arrives. Only the socket that is STILL current may clear
      // the field or schedule a reconnect; otherwise one old callback loses the
      // replacement and every refresh leaks another live subscription.
      if (this.socket !== socket) return
      this.socket = null
      // A dead subscription makes every cached status a GUESS about a world
      // that has moved on — and the server dying mid-`working` is precisely
      // when the guess is wrong. Callers treat an empty map as "no signal"
      // and fall back to inference, which is strictly better than a stale
      // fact. The reconnect re-seeds from the live pane list.
      this.status.clear()
      this.scheduleReconnect()
    }
    socket.on('close', disconnected)
    socket.on('error', disconnected)

    try {
      socket.write(
        JSON.stringify({
          id: 'cookrew-status',
          method: 'events.subscribe',
          params: {
            subscriptions: panes.map((p) => ({
              type: 'pane.agent_status_changed',
              pane_id: p.paneId
            }))
          }
        }) + '\n'
      )
    } catch {
      disconnected()
      this.closeSocket(socket)
    }
  }

  /**
   * Publish the current pane inventory without changing the subscription.
   * Unknown/missing states retract old cache entries; known states are emitted
   * so boot timers retain the existing "observation arrived" contract.
   */
  private seed(panes: FeedPane[]): void {
    this.labels = new Map(panes.map((pane) => [pane.paneId, pane.label]))
    this.status.clear()
    for (const pane of panes) {
      if (pane.status) this.record(pane.label, pane.status)
    }
  }

  /** End the prior socket after removing its authority over this feed. */
  private replaceSocket(next: StatusSocket | null): void {
    const previous = this.socket
    this.socket = next
    if (previous && previous !== next) this.closeSocket(previous)
  }

  private closeSocket(socket: StatusSocket): void {
    if (socket.destroy) socket.destroy()
    else socket.end()
  }

  /** Line-delimited JSON; a chunk may split or join lines. */
  private ingest(chunk: string): void {
    this.buffer += chunk
    let nl = this.buffer.indexOf('\n')
    while (nl !== -1) {
      const line = this.buffer.slice(0, nl)
      this.buffer = this.buffer.slice(nl + 1)
      const update = parseStatusEvent(line)
      if (update) {
        const label = this.labels.get(update.paneId)
        // A pane Cookrew does not own (or one whose label we have not seen)
        // is not an error — it is simply not ours to record.
        if (label) {
          // unknown ERASES: herdr retracting a state must not leave the old
          // one behind, or a stale `working` blocks turn finalization forever.
          if (update.status === 'unknown') this.status.delete(label)
          else this.record(label, update.status)
        }
      }
      nl = this.buffer.indexOf('\n')
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      // A failed replacement deliberately leaves the prior healthy socket in
      // place. Retry the inventory-aware refresh in that case; a genuinely
      // disconnected feed has no socket and performs a cold connect.
      if (this.socket) this.refresh()
      else this.connect()
    }, this.options.reconnectMs ?? 2000)
    // Never hold the app open for a reconnect.
    this.reconnectTimer.unref?.()
  }

  private resolveSocketPath(): string | null {
    if (this.options.resolveSocketPath) return this.options.resolveSocketPath()
    try {
      const raw = execFileSync('herdr', ['session', 'list', '--json'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        env: { ...process.env, HERDR_SESSION: this.options.session }
      })
      return socketPathFor(this.options.session, raw)
    } catch {
      return null
    }
  }

  /**
   * Cookrew's panes, from herdr itself.
   *
   * Deliberately NOT threaded down from PtyManager: the pane id is a herdr
   * concept that nothing else in Cookrew holds, and exposing it on the
   * Multiplexer interface would leak one backend's addressing into every
   * caller. An unlabelled pane is skipped — no label means no Cookrew terminal
   * to attribute a status to.
   */
  private listPanes(): FeedPane[] {
    if (this.options.listPanes) return this.options.listPanes()
    try {
      const raw = execFileSync('herdr', ['pane', 'list'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        env: { ...process.env, HERDR_SESSION: this.options.session }
      })
      return panesFrom(raw)
    } catch {
      return []
    }
  }
}

/**
 * The process-wide feed, mirroring pty.ts's `setMultiplexer`/`multiplexer`.
 *
 * A singleton because the consumer is turn-tracker's poll timer, which has no
 * route to an injected instance and must not grow one just to read a status.
 */
let activeFeed: HerdrStatusFeed | null = null

export function setStatusFeed(feed: HerdrStatusFeed | null): void {
  activeFeed?.stop()
  activeFeed = feed
}

export function statusFeed(): HerdrStatusFeed | null {
  return activeFeed
}

/**
 * herdr's view of an agent, or null when there is none.
 *
 * Null is the answer whenever anything is uncertain — no feed, no herdr, a
 * pane never reported on, or a status of `unknown`. Callers infer in that case,
 * exactly as they always have.
 */
export function agentStatus(sessionName: string): HerdrStatus | null {
  return activeFeed?.statusFor(sessionName) ?? null
}

const defaultConnect = (socketPath: string): StatusSocket => {
  const socket = net.createConnection(socketPath)
  socket.setEncoding('utf8')
  return socket as unknown as StatusSocket
}
