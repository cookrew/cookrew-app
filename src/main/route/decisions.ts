import { ROUTE_LIVE_MAX, routeSession, type RouteDecision, type RouteTurnFacts } from '../../shared/route'

/**
 * WHERE EACH TURN WENT — the long-poll per card in flight (route program).
 *
 * `GET /v1/magpie/route?session=cookrew:<cardId>&after=<seq>&wait=30` holds
 * until the route changes past `seq`, so one request at a time per card
 * follows a turn: the decision appears before the first token (which
 * member of the group, at what effort, after how many tries) and once more
 * when it is done. The gateway answers `{route: null, seq: 0}` before a
 * session has one, and `{route: {asked, group, model, effort, tries, done,
 * status, served}, seq}` after (reference.md, "Connecting anything else";
 * confirmed against magpie 0.1.1182 on 2026-10-11).
 *
 * THE COST MODEL: no request for a card that is idle, direct, or served by
 * someone else; one request in flight per routed card while its phase is
 * thinking or waiting; the wait is the gateway's (30 s), so an idle fleet
 * costs nothing and a busy card costs one open socket. All async; nothing
 * here can block the main thread (loop ledger).
 *
 * When a decision comes back `done`, one more GET fetches the turn's facts
 * (`/v1/magpie/usage/requests?session=…&limit=1`: `served`, `in`, `out`,
 * `cost`, `t`) so the card can wear what the turn cost. Two things seen on
 * the real gateway (0.1.1182, 2026-10-11) shape that read: a Claude Code
 * turn is logged under claude's OWN session id (magpie prefers an agent's
 * session header to X-Magpie-Session for the log, while /route keys on
 * ours), so the harness's session id is asked for as well; and a session
 * filter that matches nothing answers the LATEST row of all, so a row is
 * taken only when its `session` is one we asked for.
 */

export interface DecisionsFetch {
  (input: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }): Promise<{ ok: boolean; json: () => Promise<unknown> }>
}

export interface DecisionsDeps {
  fetch: DecisionsFetch
  gateway: () => { url: string; key: string } | null
  now?: () => number
  /** The long-poll's wait, in seconds (the gateway caps it at 60). */
  waitSeconds?: number
  /** The least time between two laps, so a gateway that answers at once cannot make a hot loop. */
  lapFloorMs?: number
  /** Laps that moved nothing before the follow is abandoned (resumed by the next activity). */
  maxIdleLaps?: number
  schedule?: (fn: () => void, ms: number) => () => void
  onDecision: (decision: RouteDecision) => void
  onTurn: (terminalId: string, facts: RouteTurnFacts) => void
  /** The harness's own session id for the card, when the log is keyed by it (claude). */
  harnessSession?: (terminalId: string) => string | null
}

const asRecord = (v: unknown): Record<string, unknown> | null => (typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null)
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** One `/v1/magpie/route` answer as a decision row, or null before the session has a route. */
export function toDecision(terminalId: string, body: unknown, at: number): RouteDecision | null {
  const b = asRecord(body)
  const route = b ? asRecord(b.route) : null
  if (!b || !route) return null
  const tries = Array.isArray(route.tries) ? route.tries.length : num(route.tries) ?? 0
  // The gateway stamps `time` (RFC3339) on the route; ours is the fallback.
  const stamped = str(route.time) ? Date.parse(str(route.time) as string) : NaN
  // The rule that matched (and the effort its decision model picked) — an
  // object with an id and a `pick` per the docs; a bare string names the rule.
  const ruleRaw = route.rule
  const ruleRec = asRecord(ruleRaw)
  const ruleId = ruleRec ? str(ruleRec.id) ?? str(ruleRec.name) ?? str(ruleRec.rule) : str(ruleRaw)
  const rule = ruleId ? { id: ruleId, pick: ruleRec ? str(ruleRec.pick) ?? str(ruleRec.effort) : null } : null
  return {
    terminalId,
    session: str(b.session) ?? routeSession(terminalId),
    seq: num(b.seq) ?? num(route.seq) ?? 0,
    asked: str(route.asked),
    group: str(route.group),
    model: str(route.model) ?? str(route.served),
    effort: str(route.effort),
    tries,
    done: route.done === true,
    status: str(route.status) ?? (num(route.status) !== null ? String(route.status) : null),
    at: Number.isFinite(stamped) ? stamped : at,
    ttftMs: num(route.ttft_ms) ?? num(route.ttftMs),
    ms: num(route.ms),
    rule
  }
}

/**
 * The newest row of `/v1/magpie/usage/requests` as the turn's facts — only
 * when the row belongs to one of `sessions`; the gateway answers the latest
 * row of all for a session it has no rows for.
 */
export function toTurnFacts(body: unknown, sessions: readonly string[] | null = null): RouteTurnFacts | null {
  const b = asRecord(body)
  const rows = Array.isArray(b?.rows) ? (b!.rows as unknown[]) : Array.isArray(body) ? body : []
  // THE NEWEST ROW IS NOT THE TURN (round 3, the gated e2e): codex fires a
  // follow-up call as it exits and cancels it, so a session's newest row is
  // a 499 with no tokens beside the 200 that carries them. The last few rows
  // are read (USAGE_ROWS) and the newest one that answered 200 with output
  // tokens is the turn; none → null, never a cancelled row dressed as one.
  const r = rows.map(asRecord).find((row) => {
    if (!row) return false
    if (sessions !== null && !sessions.includes(str(row.session) ?? '')) return false
    const status = num(row.status) ?? (str(row.status) ? Number(str(row.status)) : NaN)
    const out = num(row.out) ?? num(row.output_tokens) ?? 0
    return status === 200 && out > 0
  })
  if (!r) return null
  const t = str(r.t)
  const parsed = t ? Date.parse(t) : NaN
  // A local model is `cost: 0, priced: false`: the rail must say "local", never "$0.00".
  const priced = r.priced === true
  return {
    model: str(r.served) ?? str(r.model),
    inputTokens: num(r.in) ?? num(r.input_tokens),
    outputTokens: num(r.out) ?? num(r.output_tokens),
    cost: priced ? num(r.cost) : null,
    priced,
    at: Number.isFinite(parsed) ? parsed : num(r.at)
  }
}

/** Every Usage read is ours alone: the log also holds the owner's DIRECT Claude Code traffic. */
export const USAGE_AGENT = 'cookrew'
/** How many of a session's newest rows are read to find the turn (a cancelled 499 may sit on top). */
export const USAGE_ROWS = 5

/** The last 20, newest first, one row per card per seq. */
export function pushLive(live: readonly RouteDecision[], row: RouteDecision): RouteDecision[] {
  const kept = live.filter((d) => !(d.terminalId === row.terminalId && d.seq === row.seq))
  return [row, ...kept].slice(0, ROUTE_LIVE_MAX)
}

interface Follow {
  seq: number
  controller: AbortController | null
  stopped: boolean
  /** Laps that moved neither seq nor the decision. */
  idleLaps: number
  /** Cuts a lap-floor pause short on unfollow. */
  cancelPause: (() => void) | null
}

export const LAP_FLOOR_MS = 500
export const MAX_IDLE_LAPS = 8

/** The same decision, whenever it was read: a repeat is not a change. */
const sameDecision = (a: RouteDecision | undefined, b: RouteDecision): boolean =>
  a !== undefined && JSON.stringify({ ...a, at: 0 }) === JSON.stringify({ ...b, at: 0 })

export class RouteDecisions {
  private readonly follows = new Map<string, Follow>()
  private readonly lastByCard = new Map<string, RouteDecision>()
  private readonly turnByCard = new Map<string, RouteTurnFacts>()

  constructor(private readonly deps: DecisionsDeps) {}

  /** The card's latest decision and turn facts, for CardRouteState. */
  cardLive(terminalId: string): RouteDecision | null {
    return this.lastByCard.get(terminalId) ?? null
  }

  cardTurn(terminalId: string): RouteTurnFacts | null {
    return this.turnByCard.get(terminalId) ?? null
  }

  get following(): string[] {
    return [...this.follows.keys()]
  }

  /** A routed card's turn started: follow it. Idempotent while in flight. */
  follow(terminalId: string): void {
    if (this.follows.has(terminalId)) return
    const follow: Follow = { seq: this.lastByCard.get(terminalId)?.seq ?? 0, controller: null, stopped: false, idleLaps: 0, cancelPause: null }
    this.follows.set(terminalId, follow)
    void this.loop(terminalId, follow)
  }

  /** The turn ended, the card went direct, or it was removed: one request at most is cut short. */
  unfollow(terminalId: string): void {
    const follow = this.follows.get(terminalId)
    if (!follow) return
    follow.stopped = true
    follow.controller?.abort()
    follow.cancelPause?.()
    this.follows.delete(terminalId)
  }

  forget(terminalId: string): void {
    this.unfollow(terminalId)
    this.lastByCard.delete(terminalId)
    this.turnByCard.delete(terminalId)
  }

  dispose(): void {
    for (const id of [...this.follows.keys()]) this.unfollow(id)
  }

  private async loop(terminalId: string, follow: Follow): Promise<void> {
    const wait = this.deps.waitSeconds ?? 30
    const floor = this.deps.lapFloorMs ?? LAP_FLOOR_MS
    const maxIdle = this.deps.maxIdleLaps ?? MAX_IDLE_LAPS
    const now = this.deps.now ?? Date.now
    while (!follow.stopped) {
      const gateway = this.deps.gateway()
      if (!gateway) {
        this.unfollow(terminalId)
        return
      }
      const lapStart = now()
      const session = encodeURIComponent(routeSession(terminalId))
      follow.controller = new AbortController()
      let body: unknown = null
      try {
        const res = await this.deps.fetch(`${gateway.url}/v1/magpie/route?session=${session}&after=${follow.seq}&wait=${wait}`, {
          headers: { authorization: `Bearer ${gateway.key}`, 'user-agent': 'cookrew' },
          signal: follow.controller.signal
        })
        body = res.ok ? await res.json() : null
      } catch {
        body = null
      }
      follow.controller = null
      if (follow.stopped) return
      if (body === null) {
        // A refused or broken poll: stop rather than spin; the next turn re-follows.
        this.unfollow(terminalId)
        return
      }
      const decision = toDecision(terminalId, body, now())
      const seq = num(asRecord(body)?.seq) ?? follow.seq
      const before = this.lastByCard.get(terminalId)
      const moved = seq > follow.seq || (decision !== null && !sameDecision(before, decision))
      follow.seq = Math.max(follow.seq, seq, decision?.seq ?? 0)
      if (decision !== null && !sameDecision(before, decision)) {
        // Only a CHANGE reaches the card: a repeat of the same decision (a
        // gateway answering at once, a wait that timed out) is not a frame.
        // A decision with `model: null` IS a change and IS a frame — magpie
        // publishes the route the moment a request arrives and fills the
        // member in a later seq; the rail prints "deciding…" meanwhile. The
        // follow goes on, and the facts are read only once `done`.
        this.lastByCard.set(terminalId, decision)
        this.deps.onDecision(decision)
      }
      if (decision?.done) {
        await this.facts(terminalId, gateway)
        this.unfollow(terminalId)
        return
      }
      follow.idleLaps = moved ? 0 : follow.idleLaps + 1
      if (follow.idleLaps >= maxIdle) {
        // Nothing has moved for this many laps: the turn is not reaching the
        // gateway (direct after all, or a session the gateway never saw).
        // Stop; the next activity event follows again.
        this.unfollow(terminalId)
        return
      }
      // THE FLOOR: a lap never starts sooner than this after the last began,
      // whatever the gateway did — the one guard against a hot fetch loop.
      const elapsed = now() - lapStart
      if (elapsed < floor) await this.pause(floor - elapsed, follow)
    }
  }

  private pause(ms: number, follow: Follow): Promise<void> {
    const schedule = this.deps.schedule ?? ((fn: () => void, wait: number) => {
      const id = setTimeout(fn, wait)
      return () => clearTimeout(id)
    })
    return new Promise((resolve) => {
      const cancel = schedule(() => {
        follow.cancelPause = null
        resolve()
      }, ms)
      follow.cancelPause = () => {
        cancel()
        follow.cancelPause = null
        resolve()
      }
    })
  }

  private async facts(terminalId: string, gateway: { url: string; key: string }): Promise<void> {
    const own = this.deps.harnessSession?.(terminalId) ?? null
    const sessions = own ? [routeSession(terminalId), own] : [routeSession(terminalId)]
    for (const session of sessions) {
      try {
        const res = await this.deps.fetch(`${gateway.url}/v1/magpie/usage/requests?session=${encodeURIComponent(session)}&agent=${USAGE_AGENT}&limit=${USAGE_ROWS}`, {
          headers: { authorization: `Bearer ${gateway.key}`, 'user-agent': 'cookrew' }
        })
        const facts = res.ok ? toTurnFacts(await res.json(), sessions) : null
        if (facts) {
          this.turnByCard.set(terminalId, facts)
          this.deps.onTurn(terminalId, facts)
          return
        }
      } catch {
        // The turn's facts are a nicety; the decision already landed.
      }
    }
  }
}
