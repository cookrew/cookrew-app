import { EventEmitter } from 'node:events'
import type { OwnerInputVerdict, PtySession } from './pty'
import { sessionNameFor } from './pty'
import { diffOutput } from './ask'
// The dispatch engine's own prompt-identity rule, reused verbatim: ONE
// normalization decides both "did the prompt land?" and "is this turn the
// dispatched one?" — two rules would let a prompt land under one and never
// complete under the other.
import { promptAnswersDispatch, type FinalTurnAnswer } from './dispatch'
// The delta seam's wire type is the parser lane's (shared/session-turns) —
// one definition, or the emitter and this applier drift apart.
import type { HistoryDelta } from '../shared/session-turns'
export type { HistoryDelta }
import { agentStatus } from './herdr-agent-status'
// The one-producer lease (Sol r6 P0-1): the PTY guard consults it so owner
// bytes are refused while a dispatch DELIVERY is mid-submission — the shared
// input box may hold its half-ingested paste.
import { defaultProducerLease, type ProducerLease } from './producer-lease'
import { summarizeTurn, TurnSummarizer } from './sous'
import type { TurnStore } from './turn-store'
import {
  RECOVERED_PROMPT_LABEL,
  TerminalActivity,
  TurnPhase,
  TurnRecord,
  appendTurnRecord,
  cleanTurnLines,
  dedupePhantomEchoes,
  detectAgentActivity,
  isCommandPrompt,
  detectAttention,
  detectLiveWork,
  extractPromptEcho,
  feedPromptBuffer,
  isLiveStatus,
  latestTailLines,
  parseAgentGlance,
  scrollLineOf,
  tailLines
} from '../shared/turn'

/** Output silence that counts as "the agent finished its turn". */
const QUIESCENCE_MS = 2500
/**
 * How long a herdr 'working' report holds a turn open with NO output at all.
 * Long enough for slow silent tool calls, short enough that a detector stuck
 * at 'working' cannot pin a turn open for the rest of the run.
 */
const WORKING_TRUST_MS = 60_000
/**
 * An Enter that started no turn counts as "pending input" for this long —
 * agent output arriving within the window re-enters 'thinking' (self-heal).
 */
const RESUME_WINDOW_MS = 30_000
/** Min gap between rendered-screen scans in the self-heal path. */
const HEAL_SCAN_MS = 1000
/**
 * Paced Sous title-backfill: one record per tick so a burst never trips the
 * summarizer's down-cooldown (which would null out a whole sequential pass).
 */
const BACKFILL_TICK_MS = 2000
/** Cooldown before retrying the SAME record — lets a bad/slow one not starve the rest. */
const BACKFILL_RETRY_MS = 60_000
/** Minimum turn duration before quiescence may end it (agent spin-up). */
const GRACE_MS = 1500
const POLL_MS = 400
const PUSH_THROTTLE_MS = 250
const SUMMARY_TAIL = 14
const REPLY_TAIL = 60
/**
 * First Sous title request fires almost immediately — the prompt alone is
 * enough for a first title, and many real turns finish within seconds.
 */
const TITLE_FIRST_MS = 800
/** While the turn keeps running, refresh the Sous title at this cadence. */
const TITLE_REFRESH_MS = 15_000

/** Tolerance between tracker turn start and the session prompt entry time. */
const IN_FLIGHT_STAMP_SLACK_MS = 5000

/**
 * Clock slack applied to the armedAt eligibility bound when scanning durable
 * records for a dispatch's answer: the file's timestamps come from the
 * harness's clock at prompt-entry time, armedAt from ours at stamping time,
 * and a record a breath older than the arming can still be the dispatched
 * turn. Prompt identity — full, not a prefix — is the proof; this only sets
 * how far back the scan is allowed to look.
 */
const DISPATCH_ARM_SLACK_MS = IN_FLIGHT_STAMP_SLACK_MS

/**
 * How long a confirmed-delivery prompt fact waits for its turn to open before
 * it goes stale. Matches the self-heal resume window: past it, output can no
 * longer be assumed to belong to the delivered prompt.
 */
const DELIVERED_PROMPT_WINDOW_MS = RESUME_WINDOW_MS

/**
 * How long a scrape-emitted latency observation stays matchable against its
 * file closure before it expires (Sol r3 P1-12). Bounded so the per-terminal
 * identity set cannot grow for the life of the process; generous enough that
 * a reconcile lagging the screen by minutes still matches.
 */
const SCRAPE_EMIT_TTL_MS = 10 * 60_000

/** Normalized-prefix prompt equality for carrying titles across reconciles. */
const PROMPT_MATCH_CHARS = 48

function promptsMatch(scraped: string, exact: string): boolean {
  if (scraped.length === 0 || scraped === RECOVERED_PROMPT_LABEL) return true
  const key = (s: string): string =>
    s.trim().replace(/\s+/g, ' ').toLowerCase().slice(0, PROMPT_MATCH_CHARS)
  return key(scraped) === key(exact)
}

/**
 * Does a scrape-emitted latency observation's prompt identify a durable
 * record as ITS exchange? Stricter than promptsMatch: an observation with no
 * usable prompt (null, empty, the recovered label, a collapsed paste
 * placeholder) identifies NOTHING — matching it loosely is exactly how a
 * nearby owner turn stole a dispatch's sample (Sol r4 P1). And the bytes
 * must be EXACT (Sol r5 P1): the old 48-char normalized-prefix fallback let
 * two different prompts sharing a prefix pair up and silently suppress a
 * real sample. A rendering the TUI rewrapped or truncated simply cannot
 * identify its record here — the observation stays queued until its TTL and
 * the exchange reports twice, which is honest; a wrong suppression is not.
 */
function observationAnswers(observed: string | null, recordPrompt: string): boolean {
  if (observed === null || observed.length === 0 || observed === RECOVERED_PROMPT_LABEL) {
    return false
  }
  if (observed.startsWith('[Pasted text')) return false
  return observed === recordPrompt
}

/**
 * Could this settled scrape turn's recovered prompt NOT prove its own
 * identity (Sol r4 P1 replay guard)? True for the shapes a TUI leaves when
 * the real bytes never crossed the input stream: no prompt at all, the
 * recovered-turn label, a collapsed paste placeholder, or a truncated prefix
 * of the attempted bytes. A full, different prompt is PROVABLE — that turn
 * belongs to someone else and must never be replayed onto the dispatch.
 */
/**
 * Is a delta-carried record the SAME exchange as the row it would replace?
 * Same slot (index) and, when both sides carry a uuid, the same uuid — the
 * guard that keeps a rewind-reused index from inheriting a stranger's
 * title/read-marker through the incremental path.
 */
function sameExchange(incoming: TurnRecord, current: TurnRecord): boolean {
  if (incoming.index !== current.index) return false
  if (incoming.uuid !== undefined && current.uuid !== undefined) {
    return incoming.uuid === current.uuid
  }
  return true
}

/** Carry what the reconcile source cannot know onto the superseding record. */
function carryOverOnto(incoming: TurnRecord, replaced: TurnRecord): TurnRecord {
  return {
    ...incoming,
    ...(replaced.title !== undefined ? { title: replaced.title } : {}),
    ...(replaced.seenAt !== undefined ? { seenAt: replaced.seenAt } : {}),
    ...(replaced.scrollLine !== undefined ? { scrollLine: replaced.scrollLine } : {})
  }
}

/**
 * Position of the LAST record carrying `index` — scanned from the tail
 * because the record a fresh title targets is almost always the newest one,
 * so the common case costs O(1), not O(history). -1 when absent.
 */
function lastPositionOfIndex(records: readonly TurnRecord[], index: number): number {
  for (let at = records.length - 1; at >= 0; at -= 1) {
    if (records[at].index === index) return at
  }
  return -1
}

function promptUnprovable(recovered: string | null, attempted: string): boolean {
  if (recovered === null || recovered.length === 0) return true
  if (recovered === RECOVERED_PROMPT_LABEL) return true
  if (recovered.startsWith('[Pasted text')) return true
  return recovered.length < attempted.length && attempted.startsWith(recovered)
}

/**
 * Find the prior record that is the SAME exchange as `record`, for carrying
 * over the Sous title / read marker on reconcile:
 * - exact message-uuid match wins (survives an index shift from a rewind);
 * - otherwise fall back to same index + matching prompt, which MIGRATES a
 *   legacy titled record (persisted before uuid-stamping, so it has no uuid)
 *   onto its now-uuid-bearing successor — but NOT across a genuine rewind,
 *   where the prior at that index carries a different uuid.
 */
function matchPrior(
  record: TurnRecord,
  byUuid: Map<string | undefined, TurnRecord>,
  byIndex: Map<number, TurnRecord>
): TurnRecord | undefined {
  if (record.uuid && byUuid.has(record.uuid)) return byUuid.get(record.uuid)
  const at = byIndex.get(record.index)
  if (!at) return undefined
  if (record.uuid && at.uuid && at.uuid !== record.uuid) return undefined
  return promptsMatch(at.prompt, record.prompt) ? at : undefined
}

/**
 * One scrape-emitted latency observation awaiting its file closure.
 * `startedAt` is the observed turn's start — an eligibility floor, never an
 * identity; `observedAt` is when the observation was RECORDED
 * (noteScrapeEmitted ran) and is the TTL clock (Sol r5 P1: keying retention
 * on the turn's start expired any turn longer than the TTL the instant it
 * settled, so a two-hour turn's sample was "stale" on arrival and its file
 * closure billed a second public sample); `prompt` is the observed
 * prompt-of-record; `uuid` is stamped by reconcile once the durable record
 * for this exchange is known.
 */
interface ScrapeObservation {
  startedAt: number
  observedAt: number
  prompt: string | null
  uuid?: string
}

interface TrackedTerminal {
  session: PtySession
  agent: boolean
  phase: TurnPhase
  promptBuffer: string
  /** Open bracketed paste spanning input chunks (feedPromptBuffer state). */
  inPaste: boolean
  /** Partial paste marker withheld between input chunks (feedPromptBuffer). */
  heldInput: string
  /** Epoch ms of the last Enter that did NOT start or answer a turn; 0 when consumed. */
  lastSubmitAt: number
  /**
   * Sticky per-turn flag: has the CURRENT turn seen any user input since it
   * opened? Set on typing/submit; reset only when a turn opens from NON-input
   * (a boot-noise self-heal). Unlike lastSubmitAt (which resumeThinking
   * resets to 0), this survives a resume, so a first ask that merges into a
   * boot phantom is never mistaken for input-less boot noise at finalize.
   */
  sawInputThisTurn: boolean
  /** Epoch ms of the last self-heal viewport scan (throttle). */
  lastHealScanAt: number
  prompt: string | null
  snapshot: string
  /** Scrollback line where the current turn began (checkpoint mapping). */
  turnStartLine: number | null
  reply: string | null
  /** Latest Sous (local model) summary of the current turn. */
  title: string | null
  /** Bumped on every turn start so stale summaries are dropped. */
  titleGen: number
  turnStartedAt: number
  pushTimer: NodeJS.Timeout | null
  pollTimer: NodeJS.Timeout | null
  titleTimer: NodeJS.Timeout | null
  onInput: (data: string, source?: 'dispatch') => void
  onData: (data: string) => void
  onExit: () => void
}

/**
 * A dispatch waiting for this terminal's next completed turn (v4 §3). The
 * stamp is set by the dispatch service just before the prompt goes out and
 * consumed by the first turn to finish, so the correlation cannot leak onto a
 * later turn the caller never asked for.
 */
interface PendingDispatch {
  id: string
  /**
   * What the dispatch actually asked. Completion demands prompt IDENTITY, not
   * just a start time after the arming — a human ask racing the dispatch into
   * the same agent also starts a turn after armedAt, and a stamp consumed by
   * timestamp alone would bill the caller for that stranger's exchange.
   * Compared as EXACT bytes (promptAnswersDispatch): with every producer
   * serialized, exact-bytes + armedAt is the exchange identity.
   */
  prompt: string
  /** Prevents a dispatch from claiming a turn already in flight when it armed. */
  armedAt: number
  /**
   * onOwnerPreempt has fired for this dispatch — exactly once. In production
   * the wired interrupt disarms the stamp synchronously, so this guard only
   * matters when the callback is absent or chose not to act.
   */
  preemptFired?: boolean
}

/**
 * The arming GENERATION a delivery confirmation belongs to (Sol r5 P1). The
 * dispatch service mints one when it stamps the tracker (noteDispatch) and
 * passes it to every attempted/confirmed/retract call for that delivery, so a
 * confirmation returning AFTER the dispatch settled — stamp consumed,
 * cleared, or re-armed for a retry — is a NO-OP instead of minting a fresh
 * deliveredPrompt/open-turn fact that no turn will ever resolve.
 */
export interface DispatchDeliveryGen {
  dispatchId: string
  /**
   * Clock stamp of the arming this delivery ran under: a re-armed retry of
   * the SAME dispatch id is a new generation the old delivery's late
   * confirmation must not touch. Compared with IN_FLIGHT_STAMP_SLACK_MS of
   * slack — the caller's stamp and the tracker's are taken moments apart on
   * the same clock.
   */
  armedAt: number
}

/**
 * Payload of the tracker's 'turn' event: one real exchange finished, and how
 * long the agent took over it. Deliberately metadata only — the terminal to
 * attribute it to, the milliseconds, and identifying indices — so nothing
 * about the conversation can ride out to the event log on it.
 */
export interface CompletedTurn {
  terminalId: string
  /** Milliseconds from the turn opening ('thinking') to 'replied'. */
  durationMs: number
  /**
   * The dispatch this turn answers (v4 §3), when the work arrived over the
   * API rather than from a human at the keyboard. Absent otherwise — an
   * agent's own next turn is nobody's dispatch, and correlating it to one
   * would invent an attribution.
   */
  dispatchId?: string
  /**
   * Index of the TurnRecord this completion belongs to, when a durable record
   * identifies it. The listener that closes a dispatch must consume THIS —
   * never `history.at(-1)`: a new user prompt can land in the same reconcile
   * batch as the dispatched turn's finality (tail overtake), and the tail is
   * then somebody else's open exchange.
   */
  turnIndex?: number
  /**
   * STABLE identity of the answering record — its harness message uuid, when
   * the durable record carries one (Sol r4 P1). turnIndex is a display
   * ordinal a rewind/branch switch can reuse; the listener passes THIS to
   * DispatchService.completeTurn so the persisted dispatch stays resolvable
   * after index reuse. Absent for scrape-only records without a uuid.
   */
  turnUuid?: string
  /**
   * True when this exchange's public latency sample already rode an earlier
   * 'turn' event — the scrape observed an attached file-backed turn settle
   * and emitted, and this later event is the file closer enriching the SAME
   * exchange with its dispatch closure. One public completion per exchange:
   * the listener must not record a second latency sample for it.
   */
  latencyReported?: boolean
  /**
   * How the answering record says the turn ENDED (Sol r3 P1-7): the parser's
   * native terminal outcome, present only on file-closer events whose record
   * carries one. Absent = 'done' — the field arrives in a parallel parser
   * lane and every consumer must tolerate its absence. The dispatch listener
   * maps it to the record's terminal state (done → done, failed → failed
   * with reason 'agent aborted/errored', interrupted → interrupted).
   */
  outcome?: 'done' | 'failed' | 'interrupted'
}

/**
 * Watches every PTY and derives per-terminal turn state for the summary
 * cards: Enter starts a turn ('thinking', streaming the new-output tail as a
 * live thinking chain), output quiescence ends it ('replied', exposing the
 * cleaned reply). Shell terminals just stream a viewport tail.
 */
export class TurnTracker extends EventEmitter {
  private tracked = new Map<string, TrackedTerminal>()

  /**
   * The local-producer serializer (Sol r3 P0-2c, synchronous-durable per
   * Sol r4 P0-1d): the owner at the keyboard submits a NEW prompt into a
   * terminal carrying an armed dispatch. Wired by the conductor to interrupt
   * that dispatch ('preempted by owner input') AND report whether the
   * interrupt row durably committed — the wiring returns
   * `!dispatchService.hasOpenDispatch(terminalId)`. `false` means the
   * transition parked fail-closed (ledger down, reservation kept): the
   * owner's write is then REFUSED by the PTY guard rather than delivered
   * beside a live reservation. `true`/`undefined` (legacy void wirings) read
   * as committed. Fired BEFORE the owner's turn opens; the dispatch's own
   * pty-fallback delivery is exempt BY SOURCE TAG, never by byte equality
   * (Sol r4 P0-1b) — an owner typing the identical bytes still preempts.
   * With this plus the HTTP producers' 409s, every producer at an armed
   * terminal is serialized — the invariant that lets exact-bytes + armedAt
   * stand as exchange identity.
   */
  onOwnerPreempt: ((terminalId: string) => boolean | void) | null = null

  /**
   * All injectable for tests; store null = in-memory only. The lease defaults
   * to the process-wide instance so production shares ONE set of holds with
   * askTerminal and the dispatch delivery legs — a private lease would
   * reserve nothing.
   */
  constructor(
    private summarize: TurnSummarizer = summarizeTurn,
    private store: TurnStore | null = null,
    private lease: ProducerLease = defaultProducerLease()
  ) {
    super()
  }

  /**
   * Completed turns per terminal. Kept OUTSIDE `tracked` so history survives
   * untrack/re-track cycles (workspace switches reattach the same tmux
   * session). It is NOT dropped on kill (the R2 recovery net keeps it as a
   * session-matching signal); clearHistory remains for explicit purges only.
   * Backed by TurnStore files (~/.cookrew/turns) so restarts keep it too —
   * terminal ids are stable across runs.
   *
   * TRACKER-PRIVATE MUTABLE BUFFERS (Sol r5 P1). The arrays in this map are
   * never handed outside this class: the delta path (applyHistoryDelta)
   * appends/edits them IN PLACE so one new turn on an N-turn history costs
   * O(delta), not an O(N) copy of the untouched prefix. That is the one
   * sanctioned bend of the repo's immutability rule, and it is safe precisely
   * because the buffer is never shared — every external read goes through
   * history(), which hands out a memoized point-in-time copy (`snapshots`).
   * Every non-delta write (reconcile, rewind fallback, scrape append,
   * seen/title edits) still swaps in a fresh array via setHistory().
   */
  private histories = new Map<string, TurnRecord[]>()

  /**
   * terminalId → the point-in-time copy history() last handed out.
   * Invalidated on EVERY change, full or delta, so snapshot identity tracks
   * content identity: the same reference while nothing changed, a new one
   * after any change — exactly the contract SessionTurnSync's watch()
   * re-adopt relies on when it compares `history(id) === prior.history` to
   * prove the tracker still holds what it captured at suspend time. A caller
   * holding a snapshot never sees it mutate under it.
   */
  private snapshots = new Map<string, TurnRecord[]>()

  /**
   * Terminals whose DURABLE history is written by the session file, not by
   * this tracker (step 4: narrow the scrape). SessionTurnSync owns this flag
   * and sets it only after a reconcile has actually landed — never from the
   * harness declaration alone.
   *
   * That distinction is the whole safety property. Between spawn and the
   * first session-file write there is a real window in which the file cannot
   * record anything yet; a terminal flagged on its harness's say-so would
   * record NOTHING in that window and lose those turns silently. Default is
   * scrape, so the only way to switch a terminal off the scrape is for
   * something to have proven the file path works for it.
   */
  private fileBacked = new Set<string>()

  /**
   * terminalId → the dispatch its NEXT completed turn answers (v4 §3). Set by
   * the dispatch service just before the prompt goes out and consumed on the
   * first eligible turn end.
   */
  private pendingDispatch = new Map<string, PendingDispatch>()

  /**
   * terminalId → the EXACT prompt a confirmed native delivery carried
   * (noteDispatchDelivered), waiting for its turn to open. The native path
   * writes nothing through the PTY input stream, so without this fact the
   * scrape can only recover the prompt from a rendered echo — which a TUI
   * collapses ("[Pasted text #1 …]") or truncates, leaving the closer's
   * prompt-identity proof unprovable. Consumed when a turn opens within
   * DELIVERED_PROMPT_WINDOW_MS; cleared with the dispatch it served.
   * `dispatchId` records the generation that minted the fact, so retraction
   * is scoped: only the minting dispatch may take its own fact back.
   */
  private deliveredPrompt = new Map<
    string,
    { prompt: string; at: number; dispatchId: string }
  >()

  /**
   * terminalId → ORDERED queue of exchanges whose latency the scrape has
   * already emitted publicly, on a FILE-BACKED terminal. The file closer
   * matching one of these exchanges still closes the dispatch but flags the
   * event `latencyReported` so the sample is never counted twice.
   *
   * Identity is the observation's PROMPT (exact bytes) plus monotonic order,
   * reconciled to the durable record's uuid when the reconcile lands it —
   * NEVER a free timestamp window (Sol r4 P1): a five-second slack let an
   * owner turn near the dispatch turn consume the dispatch's sample.
   * Observations are consumed in queue order by the first record they
   * actually identify; unmatched ones are retained until SCRAPE_EMIT_TTL_MS
   * past their OBSERVATION time.
   *
   * IN-MEMORY ONLY, deliberately (Sol r5 P1c): this queue is telemetry
   * dedupe, not billing state — nothing here decides whether a dispatch is
   * charged or closed. A restart between the scrape's public emission and
   * the durable closure loses the queue and costs at most one duplicate
   * latency sample, which is honest and self-limiting; persisting it would
   * buy nothing but a stale guess to be wrong with later.
   *
   * RESTART-LOCAL AT-MOST-ONCE IS THE METRIC CONTRACT (Sol r6 P2, by
   * documented decision rather than persistence): within one process
   * lifetime an exchange's latency rides at most one public 'turn' event;
   * the emission-to-durable-closure window ACROSS a restart is explicitly
   * excluded from that claim. Any analysis validating the design against the
   * latency tail must exclude samples whose exchange spans a restart, not
   * lean on this queue surviving one.
   */
  private scrapeEmitted = new Map<string, ScrapeObservation[]>()

  /**
   * terminalId → epoch ms a turn was OBSERVED to open whose finality has not
   * yet been observed (v5 A4). Deliberately OUTSIDE `tracked`, surviving
   * untrack: a workspace switch drops the live scrape state, and this fact is
   * what still says "work is in flight here" to holdOpen. Set on turn open
   * and on a confirmed native delivery; cleared on parser finality
   * (replaceHistory final tail / completeFromHistory), scrape-observed turn
   * end, dispatch interruption (clearDispatch), process exit and removal.
   */
  private openTurnFacts = new Map<string, number>()

  /** Paced Sous title-backfill pump for historical untitled records. */
  private backfillTimer: NodeJS.Timeout | null = null
  private backfillInFlight = false
  /** Last backfill attempt per record ("terminalId:index" → epoch ms). */
  private backfillAttempt = new Map<string, number>()

  /**
   * Completed turns for a terminal, oldest first (lazy-loaded from disk) — a
   * memoized POINT-IN-TIME copy, never the tracker-private buffer (see
   * `histories`/`snapshots`). Copy-on-read is the price of the O(delta)
   * append: a shallow slice per changed read, against deep prefix copies plus
   * full persistence scans per append before.
   */
  history(terminalId: string): TurnRecord[] {
    const memo = this.snapshots.get(terminalId)
    if (memo) return memo
    const snapshot = [...this.liveHistory(terminalId)]
    this.snapshots.set(terminalId, snapshot)
    return snapshot
  }

  /** The tracker-private live buffer (lazy-loaded). NEVER handed outside. */
  private liveHistory(terminalId: string): TurnRecord[] {
    const cached = this.histories.get(terminalId)
    if (cached) return cached
    const loaded = this.store?.load(terminalId) ?? []
    this.histories.set(terminalId, loaded)
    return loaded
  }

  /** Wholesale replacement — every non-delta write path lands through this. */
  private setHistory(terminalId: string, records: TurnRecord[]): void {
    this.histories.set(terminalId, records)
    this.snapshots.delete(terminalId)
  }

  /** History length without materializing a snapshot (activity hot path). */
  private historyCount(terminalId: string): number {
    return this.liveHistory(terminalId).length
  }

  /**
   * Session-file reconcile (SessionTurnSync): replace a terminal's history
   * with records derived from its Claude session JSONL — the source of truth
   * for session-bound terminals. Sous titles and the acknowledge-on-view
   * marker carry over per the EXACT SAME EXCHANGE: by message uuid when the
   * record has one (survives an index shift when a mid-history turn is
   * rewound; a reused index with a new uuid does NOT inherit), else by
   * index + prompt for legacy records without a uuid. Shrinking is expected:
   * after /rewind the rewound turns disappear so counts match reality.
   */
  replaceHistory(terminalId: string, records: TurnRecord[]): void {
    const previous = this.liveHistory(terminalId)
    const byUuid = new Map(previous.filter((r) => r.uuid).map((r) => [r.uuid, r]))
    const byIndex = new Map(previous.map((r) => [r.index, r]))
    const merged = records.map((record) => {
      const prior = matchPrior(record, byUuid, byIndex)
      if (!prior) return record
      // Same exchange: carry over what the reconcile source can't know —
      // the Sous title and the acknowledge-on-view read marker.
      return {
        ...record,
        ...(prior.title !== undefined ? { title: prior.title } : {}),
        ...(prior.seenAt !== undefined ? { seenAt: prior.seenAt } : {}),
        // Screen offsets exist only on live-scraped records — the session
        // file has no screen coordinates, so the reconcile must keep them.
        ...(prior.scrollLine !== undefined ? { scrollLine: prior.scrollLine } : {})
      }
    })
    const stamped = this.stampInFlightScrollLine(terminalId, merged)
    // No cap. History used to be trimmed because every save rewrote the whole
    // file; the store appends now, so keeping all of it costs one line per
    // turn. Conductor had 220 checkpoints trimmed away under the old limit.
    const deduped = dedupePhantomEchoes(stamped)
    this.commitReconciled(terminalId, deduped)
  }

  /**
   * Apply one INCREMENTAL history change (I3 — the parser lane emits deltas,
   * this side applies them). The point is bounded work per append: only the
   * affected records are touched — no full-map carryover rebuild, no
   * whole-history dedupe. Every observer of replaceHistory (open-turn-fact
   * clearing, scrape-observation reconcile, the dispatch-closure scan reading
   * this.histories, the store save) sees a delta-applied history identically.
   *
   * - append (per the shared apply contract): splice at
   *   `records[0].index - 1` — always |H| (pure concat) or |H|-1 (the
   *   finalized RE-CARRY of the previously-emitted open tail) — then dedupe
   *   only the BOUNDARY window (the one neighborhood a split-echo phantom
   *   can span; dedupePhantomEchoes carries title/seenAt onto the surviving
   *   uuid record itself). Genuinely new records have no prior to carry
   *   from, so the incremental path skips the full matchPrior pass by
   *   construction; the re-carried tail inherits from the record it
   *   supersedes.
   * - tail: replace the last record in place, carrying over what the emitter
   *   cannot know (title/seenAt/scrollLine) from the record it replaces —
   *   same-exchange only (a uuid mismatch is not a tail update; fall back to
   *   the full reconcile).
   * - reset: the accumulator rewrote/branched — fall back to replaceHistory
   *   over fullRecords(), the one path allowed to cost O(history).
   *
   * Any delta whose premise does not hold against the tracker's actual
   * history (positions drifted, foreign records interleaved) falls back to
   * the full reconcile rather than guessing.
   *
   * O(delta) END TO END (Sol r5 P1): both incremental kinds MUTATE the
   * tracker-private buffer in place — the untouched prefix is never copied
   * (see `histories` for why that bend of the immutability rule is safe) —
   * and hand TurnStore.scheduleDelta the exact changed records, so the
   * annotation pass folds in only those and the JSONL write appends (or
   * replaces just the last line) instead of visiting every record. The one
   * incremental shape that cannot name its change — the boundary dedupe
   * actually dropping a phantom twin, a shrink — takes the full save path.
   */
  applyHistoryDelta(
    terminalId: string,
    delta: HistoryDelta,
    fullRecords: () => TurnRecord[]
  ): void {
    if (delta.kind === 'reset') {
      this.replaceHistory(terminalId, fullRecords())
      return
    }
    const previous = this.liveHistory(terminalId)
    if (delta.kind === 'tail') {
      const replaced = previous[previous.length - 1]
      // No tail to replace, or the emitter's idea of the tail is not ours
      // (index/uuid mismatch = a different exchange): the incremental
      // premise failed, so take the honest full path instead of guessing.
      if (replaced === undefined || !sameExchange(delta.record, replaced)) {
        this.replaceHistory(terminalId, fullRecords())
        return
      }
      const landed = this.stampInFlight(terminalId, carryOverOnto(delta.record, replaced))
      previous[previous.length - 1] = landed
      this.commitDelta(terminalId, [landed])
      return
    }
    if (delta.records.length === 0) return
    const at = delta.records[0].index - 1
    // The contract admits exactly two landing slots: past the tail, or ON
    // the tail (its finalized re-carry). Anything else means this tracker's
    // history has drifted from the emitter's (extra scrape rows, a missed
    // take) — re-read the whole projection.
    if (at !== previous.length && at !== previous.length - 1) {
      this.replaceHistory(terminalId, fullRecords())
      return
    }
    const replaced = at === previous.length - 1 ? previous[at] : undefined
    if (replaced !== undefined && !sameExchange(delta.records[0], replaced)) {
      this.replaceHistory(terminalId, fullRecords())
      return
    }
    const landed =
      replaced === undefined
        ? delta.records
        : [carryOverOnto(delta.records[0], replaced), ...delta.records.slice(1)]
    // Dedupe touches ONLY the boundary window: the last kept record plus the
    // landed ones — the only neighborhood a phantom twin can span.
    const boundary = Math.max(0, at - 1)
    const expected = at - boundary + landed.length
    const window = dedupePhantomEchoes([...previous.slice(boundary, at), ...landed])
    previous.length = boundary
    previous.push(...window)
    const lastAt = previous.length - 1
    if (lastAt >= 0) previous[lastAt] = this.stampInFlight(terminalId, previous[lastAt])
    if (window.length !== expected) {
      // The boundary dedupe dropped a phantom twin: the change is a shrink,
      // which the delta save contract cannot express — full save path.
      this.snapshots.delete(terminalId)
      this.store?.scheduleSave(terminalId, previous)
      this.afterCommit(terminalId, previous)
      return
    }
    this.commitDelta(terminalId, previous.slice(boundary))
  }

  /**
   * The full-reconcile landing: adopt the fresh array wholesale, schedule the
   * full save, and run the shared observers.
   */
  private commitReconciled(terminalId: string, records: TurnRecord[]): void {
    this.setHistory(terminalId, records)
    this.store?.scheduleSave(terminalId, records)
    this.afterCommit(terminalId, records)
  }

  /**
   * The delta landing: the tracker-private buffer was already mutated in
   * place (the whole point — no prefix copy), so this only invalidates the
   * point-in-time snapshot, hands the store the same buffer plus the NAMES of
   * the changed records, and runs the shared observers.
   */
  private commitDelta(terminalId: string, changed: TurnRecord[]): void {
    const records = this.liveHistory(terminalId)
    this.snapshots.delete(terminalId)
    this.store?.scheduleDelta(terminalId, records, changed)
    this.afterCommit(terminalId, records)
  }

  /**
   * The shared landing for a reconciled history, full or delta: resolve the
   * A4 open-turn fact against the new tail, bind scrape latency observations
   * to their durable records, and push. Every observer here sees a
   * delta-applied history identically to a full-reconciled one.
   */
  private afterCommit(terminalId: string, records: TurnRecord[]): void {
    this.reconcileScrapeObservations(terminalId, records)
    // Parser finality clears the A4 open-turn fact (v5 A4): a FINAL tail
    // covering the observed open (file prompt-entry time within slack of the
    // observation) means the in-flight turn ended and was durably recorded.
    // A final tail OLDER than the fact is a previous exchange — the observed
    // turn's own record has not landed yet, so the fact stands.
    const tail = records[records.length - 1]
    const openedAt = this.openTurnFacts.get(terminalId)
    if (
      tail !== undefined &&
      openedAt !== undefined &&
      tail.final === true &&
      openedAt <= tail.startedAt + DISPATCH_ARM_SLACK_MS
    ) {
      this.openTurnFacts.delete(terminalId)
    }
    const t = this.tracked.get(terminalId)
    if (t) this.push(t)
    this.ensureBackfillPump()
  }

  /**
   * Regenerate Sous titles for records that reconciled in without one — the
   * historical turns whose title was lost from disk before carryover existed,
   * and any turn Sous never got to title. Carryover keeps the records that DID
   * hold a title; this fills only genuine gaps.
   *
   * PACED, not burst: one record per tick, single-flight. A tight sequential
   * loop over dozens of records trips the summarizer's down-cooldown on the
   * first slow/failed call and nulls out the whole rest of the pass — this
   * pump instead attempts one record every BACKFILL_TICK_MS, so a cooldown
   * only costs the next tick. Oldest untitled first (Conductor T1 before its
   * later turns); a per-record retry cooldown keeps one unfittable or
   * down-Sous record from starving the others. Independent of reconcile, so
   * idle agents' histories backfill too. Stops itself when nothing is left.
   */
  private ensureBackfillPump(): void {
    if (this.backfillTimer || !this.hasUntitled()) return
    this.backfillTimer = setInterval(() => void this.backfillTick(), BACKFILL_TICK_MS)
    this.backfillTimer.unref?.()
  }

  private stopBackfillPump(): void {
    if (this.backfillTimer) clearInterval(this.backfillTimer)
    this.backfillTimer = null
  }

  private hasUntitled(): boolean {
    for (const records of this.histories.values()) {
      if (records.some((r) => r.title === undefined && (r.reply.length > 0 || r.prompt.length > 0))) {
        return true
      }
    }
    return false
  }

  /** Oldest untitled record not attempted within the retry cooldown. */
  private nextBackfill(): { terminalId: string; record: TurnRecord; key: string } | null {
    const now = Date.now()
    for (const [terminalId, records] of this.histories) {
      for (const record of records) {
        if (record.title !== undefined) continue
        if (record.reply.length === 0 && record.prompt.length === 0) continue
        const key = `${terminalId}:${record.index}`
        if (now - (this.backfillAttempt.get(key) ?? 0) < BACKFILL_RETRY_MS) continue
        return { terminalId, record, key }
      }
    }
    return null
  }

  private async backfillTick(): Promise<void> {
    if (this.backfillInFlight) return
    if (!this.hasUntitled()) {
      this.stopBackfillPump()
      return
    }
    const next = this.nextBackfill()
    if (!next) return // all untitled are in cooldown — a later tick retries
    this.backfillInFlight = true
    this.backfillAttempt.set(next.key, Date.now())
    try {
      const title = await this.summarize({
        prompt: next.record.prompt,
        tools: [],
        lines: next.record.reply.split('\n')
      })
      if (title === null) return // Sous down / cooldown; retried after BACKFILL_RETRY_MS
      const current = this.histories.get(next.terminalId)
      const live = current?.find((r) => r.index === next.record.index)
      // Skip if the turn was rewound / already titled while we summarized.
      if (!current || !live || live.title !== undefined) return
      if (live.uuid !== next.record.uuid || live.prompt !== next.record.prompt) return
      const updated = current.map((r) => (r.index === next.record.index ? { ...r, title } : r))
      this.setHistory(next.terminalId, updated)
      this.store?.scheduleSave(next.terminalId, updated)
      const t = this.tracked.get(next.terminalId)
      if (t) this.push(t)
    } finally {
      this.backfillInFlight = false
    }
  }

  /**
   * scrollLine for the LIVE turn (Magpie E2 gap): Claude writes the prompt
   * entry the moment a turn starts, so the reconcile usually replaces
   * history BEFORE the scraped record — the scrollLine carrier — exists,
   * and the scrape's later append is dropped as a phantom echo. While a
   * turn is in flight, stamp the incoming record that covers it straight
   * from the tracker's live turnStartLine. Guards: only the NEWEST record,
   * only when its prompt matches the live one and its start time is not
   * older than the live turn (a reconcile from a pre-turn write must never
   * inherit the new turn's offset).
   */
  private stampInFlightScrollLine(terminalId: string, records: TurnRecord[]): TurnRecord[] {
    if (records.length === 0) return records
    const last = records[records.length - 1]
    const stamped = this.stampInFlight(terminalId, last)
    if (stamped === last) return records
    return [...records.slice(0, -1), stamped]
  }

  /** The single-record form — the delta path stamps its landed tail with it. */
  private stampInFlight(terminalId: string, last: TurnRecord): TurnRecord {
    const t = this.tracked.get(terminalId)
    const inFlight = t !== undefined && (t.phase === 'thinking' || t.phase === 'waiting')
    if (!t || !inFlight || t.turnStartLine === null) return last
    const covers =
      last.scrollLine === undefined &&
      promptsMatch(t.prompt ?? '', last.prompt) &&
      last.startedAt >= t.turnStartedAt - IN_FLIGHT_STAMP_SLACK_MS
    return covers ? { ...last, scrollLine: t.turnStartLine } : last
  }

  /**
   * Acknowledge-on-view: 'replied' (TURN COMPLETE) means UNREAD, and it
   * demotes to 'idle' exactly when the user views the result — the terminal
   * overlay mounts (desktop zoom / phone popout) or the next prompt starts a
   * new turn. Prompt, reply and title stay untouched so READY keeps showing
   * the exchange; only the fresh-result emphasis drops. Never a TTL — unread
   * results must not silently expire — and never from any other phase (a
   * glance must not end a live or waiting turn).
   */
  seen(terminalId: string): void {
    const t = this.tracked.get(terminalId)
    if (!t || t.phase !== 'replied') return
    t.phase = 'idle'
    this.markLastRecordSeen(terminalId)
    this.push(t)
  }

  /** Persist the read marker so unread state survives restarts/switches. */
  private markLastRecordSeen(terminalId: string): void {
    const history = this.liveHistory(terminalId)
    const last = history[history.length - 1]
    if (!last || last.seenAt !== undefined) return
    const updated = [...history.slice(0, -1), { ...last, seenAt: Date.now() }]
    this.setHistory(terminalId, updated)
    this.store?.scheduleSave(terminalId, updated)
  }

  /**
   * Declare where a terminal's durable history comes from. Called by
   * SessionTurnSync: 'file' after a reconcile lands, 'scrape' when the watch
   * starts or rebinds (a new session file has to prove itself again) and when
   * it stops. Everything else — plain shells, scrape-only harnesses, and any
   * file harness whose session file has not appeared — stays on 'scrape',
   * which is the default and needs no call.
   */
  setHistorySource(terminalId: string, source: 'file' | 'scrape'): void {
    if (source === 'file') this.fileBacked.add(terminalId)
    else this.fileBacked.delete(terminalId)
  }

  /**
   * Attribute this terminal's next completed turn to a dispatch (v4 §3).
   *
   * Stamped BEFORE the prompt is submitted, because a fast agent can finish
   * inside the submission call and a correlation applied afterwards would miss
   * its own turn. One dispatch, one turn: the stamp is consumed on use.
   *
   * REFUSES to overwrite a live stamp, returning false. A terminal carries at
   * most one pending dispatch because it produces one turn at a time; taking
   * the second would close the newcomer with the incumbent's turn and leave
   * the incumbent open forever — two dispatches, one answer.
   */
  noteDispatch(terminalId: string, dispatchId: string, prompt: string): boolean {
    const held = this.pendingDispatch.get(terminalId)
    if (held !== undefined) return held.id === dispatchId
    this.pendingDispatch.set(terminalId, { id: dispatchId, prompt, armedAt: Date.now() })
    return true
  }

  /**
   * Is a dispatch stamp armed on this terminal? The HTTP input producers
   * (/input, /ask) serialize on this: a second producer typing into an agent
   * mid-dispatch would interleave two principals' work in one input box AND
   * poison the prompt-identity correlation for both. Local canvas typing is
   * deliberately not gated — the owner at the keyboard outranks the machinery.
   */
  hasArmedDispatch(terminalId: string): boolean {
    return this.pendingDispatch.has(terminalId)
  }

  /**
   * Is a live PTY scrape-tracking this terminal right now? Dispatch
   * acceptance asks this: an agent with neither a file observer nor a scrape
   * has nobody to witness its turn, and accepting work for it would pin a
   * watch on nothing.
   */
  isTracked(terminalId: string): boolean {
    return this.tracked.has(terminalId)
  }

  /**
   * Does the tracker believe a turn is running here? Live scrape phase when a
   * PTY is attached; detached, the witnesses are herdr's push feed (a
   * positive working/blocked claim), an armed dispatch (work this app itself
   * submitted), and the OWNED open-turn fact (Sol r4 P1): a switched-away
   * human turn whose status feed went absent is still an observed open — a
   * rotation gate that ignored it would rotate a session out from under work
   * in flight. Gates the staleness report — a quiet file under an agent
   * nobody believes is working is rest, not rotation.
   */
  inTurn(terminalId: string): boolean {
    const t = this.tracked.get(terminalId)
    if (t) return t.phase === 'thinking' || t.phase === 'waiting'
    if (this.pendingDispatch.has(terminalId)) return true
    if (this.openTurnFacts.has(terminalId)) return true
    const reported = agentStatus(sessionNameFor(terminalId))
    return reported === 'working' || reported === 'blocked'
  }

  /**
   * Lifecycle end for the owned open-turn fact (Sol r4 P1): the conductor
   * calls this at permanent node removal AND on backend death for every
   * terminal whose pane died — a fact for a turn whose process no longer
   * exists must not hold a watch (or veto a rotation/restore) forever. Also
   * the escape hatch for a stale-rebind resolver that gave up: the fact
   * itself never times out, so ONLY these lifecycle events may end it without
   * observed finality. Clears the waiting delivered-prompt fact with it — a
   * dead pane can no longer open the turn those bytes were for.
   */
  clearOpenTurnFact(terminalId: string): void {
    this.openTurnFacts.delete(terminalId)
    this.deliveredPrompt.delete(terminalId)
  }

  /**
   * Drop a stamp whose dispatch ended without producing a turn (failed
   * delivery, interrupt). Matched on the id so a dispatch that has already
   * been superseded cannot disarm its successor.
   */
  clearDispatch(terminalId: string, dispatchId: string): void {
    const pending = this.pendingDispatch.get(terminalId)
    if (pending?.id !== dispatchId) return
    this.pendingDispatch.delete(terminalId)
    this.deliveredPrompt.delete(terminalId)
    // Interruption ends the A4 fact this dispatch minted — but only ITS fact:
    // an open-turn observation older than the arming belongs to somebody
    // else's still-running exchange and survives the dispatch's death.
    const openedAt = this.openTurnFacts.get(terminalId)
    if (openedAt !== undefined && openedAt >= pending.armedAt) {
      this.openTurnFacts.delete(terminalId)
    }
  }

  /**
   * A native delivery's exact prompt (Sol r2 P1 — the native path never
   * registers input with the live tracker). Called by the dispatch service
   * when submission is CONFIRMED (herdr `done`, or the landing check finding
   * the echo) — and, at a weaker confidence, when delivery was ATTEMPTED and
   * non-delivery was NOT proven (Sol r3 P1-9: the collapsed-echo path, where
   * the prompt usually landed but the screen cannot show it). The tracker
   * treats both grades the same for prompt-of-record purposes: the only turn
   * these exact bytes can open is the dispatched one, and the confidence
   * distinction stays on the dispatch record's `confirmed` flag, not here.
   * If a turn eligible to be the dispatch's answer
   * is ALREADY opening, the delivered text becomes its prompt-of-record
   * immediately — the screen echo is a rendering, this is the fact. Otherwise
   * the fact waits (DELIVERED_PROMPT_WINDOW_MS) for the turn to open, where
   * resumeThinking prefers it over echo recovery. Either way the terminal now
   * carries an observed-turn fact (A4): a confirmed delivery means a turn is
   * opening whether or not any PTY is attached to watch it.
   *
   * SCOPED TO A GENERATION (Sol r5 P1): the call binds to `gen.dispatchId`,
   * and when that dispatch's stamp is no longer armed — settled, cleared, or
   * re-armed for a retry (a newer armedAt) — it is a NO-OP. A blocking
   * native submit can return long after a fast closer consumed the stamp;
   * an unscoped confirmation then minted deliveredPrompt/openTurnFacts for
   * an exchange that already ended, a fact with no future turn to resolve it
   * that held tracking open and could contaminate the next turn's
   * prompt-of-record. The 2-arg form is DEPRECATED — kept only for the
   * conductor's legacy wiring (index.ts noteDelivered) — and binds to
   * whatever stamp is currently armed, with the same fail-closed no-op when
   * none is.
   */
  noteDispatchDelivered(terminalId: string, prompt: string, gen?: DispatchDeliveryGen): void {
    const pending = this.pendingDispatch.get(terminalId)
    // Generation gate: no armed stamp, a stamp belonging to a different
    // dispatch, or a newer arming of the same id all mean the delivery this
    // call confirms is already settled — nothing here may be minted for it.
    if (pending === undefined) return
    if (gen !== undefined) {
      if (pending.id !== gen.dispatchId) return
      if (gen.armedAt < pending.armedAt - IN_FLIGHT_STAMP_SLACK_MS) return
    }
    const t = this.tracked.get(terminalId)
    const inTurn = t !== undefined && (t.phase === 'thinking' || t.phase === 'waiting')
    const ownsLiveTurn = inTurn && t !== undefined && t.turnStartedAt >= pending.armedAt
    if (t !== undefined && ownsLiveTurn) {
      t.prompt = prompt
      t.sawInputThisTurn = true
      this.openTurnFacts.set(terminalId, t.turnStartedAt)
      return
    }
    // Sol r4 P1 replay: the authoritative bytes arrived AFTER the scrape
    // already settled the turn (the blocking native submit returned late).
    // If that settled turn is eligible (opened after arming) and its
    // recovered prompt was unprovable, it WAS the dispatch's exchange —
    // consume the stamp once, now, instead of stranding the dispatch.
    if (t !== undefined) {
      if (this.replaySettledScrapeClosure(terminalId, t, pending, prompt)) return
    }
    const at = Date.now()
    this.deliveredPrompt.set(terminalId, { prompt, at, dispatchId: pending.id })
    this.openTurnFacts.set(terminalId, at)
  }

  /**
   * The attempted-delivery fact registered before the native submission was
   * DISPROVEN (nonDeliveryProven) — take it back (Sol r4 P1). Matches the
   * exact bytes so a newer, different fact is never collateral, and — scoped
   * like the confirmation (Sol r5 P1) — only the generation that minted the
   * fact may retract it: a successor dispatch delivering the identical bytes
   * is not collateral either. Clears the open-turn fact only when the
   * retracted delivery is what minted it (same clock stamp), never one a
   * real turn opening set.
   */
  retractDispatchDelivered(terminalId: string, prompt: string, gen?: DispatchDeliveryGen): void {
    const fact = this.deliveredPrompt.get(terminalId)
    if (fact === undefined || fact.prompt !== prompt) return
    if (gen !== undefined && fact.dispatchId !== gen.dispatchId) return
    this.deliveredPrompt.delete(terminalId)
    if (this.openTurnFacts.get(terminalId) === fact.at) {
      this.openTurnFacts.delete(terminalId)
    }
  }

  /**
   * One-shot late closure for a SETTLED scrape turn (Sol r4 P1): guarded by
   * scrape authority (the file closer owns file-backed terminals), armedAt
   * eligibility, a settled phase, and an UNPROVABLE recovered prompt — null,
   * the recovered label, a collapsed paste placeholder, or a truncated
   * prefix of the attempted bytes. Anything provable that failed identity
   * was genuinely somebody else's turn and is not replayed. The completion
   * event is flagged latencyReported: the settled turn already emitted its
   * public sample once.
   */
  private replaySettledScrapeClosure(
    terminalId: string,
    t: TrackedTerminal,
    pending: PendingDispatch,
    prompt: string
  ): boolean {
    if (this.writesFromFile(terminalId)) return false
    if (t.phase !== 'replied' && t.phase !== 'idle') return false
    if (t.turnStartedAt === 0) return false
    if (t.turnStartedAt < pending.armedAt - IN_FLIGHT_STAMP_SLACK_MS) return false
    if (!promptUnprovable(t.prompt, prompt)) return false
    t.prompt = prompt
    this.pendingDispatch.delete(terminalId)
    this.deliveredPrompt.delete(terminalId)
    const history = this.liveHistory(terminalId)
    const tail = history[history.length - 1]
    this.emit('turn', {
      terminalId,
      durationMs: Math.max(0, (tail?.endedAt ?? Date.now()) - t.turnStartedAt),
      dispatchId: pending.id,
      ...(tail !== undefined ? { turnIndex: tail.index } : {}),
      ...(tail?.uuid !== undefined ? { turnUuid: tail.uuid } : {}),
      latencyReported: true
    } satisfies CompletedTurn)
    return true
  }

  /**
   * Is there an OBSERVED turn here whose finality has not been observed yet
   * (v5 A4)? Attached, the live scrape phase answers; detached, the answer is
   * the persisted fact minted at turn open (or at confirmed delivery) and
   * cleared only by finality — replaceHistory landing a final tail,
   * completeFromHistory, the scrape watching the turn settle — or by
   * interruption/removal. This is a FACT probe, not a status guess: the
   * conductor wires it into holdOpen so a switched-away turn inside a long
   * silent tool call cannot drain its watch just because the status feed
   * went absent.
   */
  hasOpenTurnFact(terminalId: string): boolean {
    const t = this.tracked.get(terminalId)
    if (t) return t.phase === 'thinking' || t.phase === 'waiting'
    return this.openTurnFacts.has(terminalId)
  }

  /** Consume the delivered-prompt fact if a fresh one is waiting. */
  private takeDeliveredPrompt(terminalId: string): string | null {
    const fact = this.deliveredPrompt.get(terminalId)
    if (fact === undefined) return null
    this.deliveredPrompt.delete(terminalId)
    return Date.now() - fact.at <= DELIVERED_PROMPT_WINDOW_MS ? fact.prompt : null
  }

  /**
   * File-observer dispatch closure (v5 A2): for a FILE-BACKED terminal the
   * durable history the session-file reconcile maintains is the only witness
   * that counts, so this is the ONE closer for its dispatches — the scrape,
   * even when a live PTY exists, only reports latency (emitCompletedTurn
   * stands down from the stamp). One authority, one closer: two closers
   * racing was how a dispatch got billed against a history tail the
   * reconcile had not written yet.
   *
   * Called by the sync on quiet polls. Closing takes ALL of:
   * - file authority (`writesFromFile`) — closure must read the durable row
   *   it bills against; a scrape-only terminal has no such row and its own
   *   path closes it;
   * - a record with a reply AND `final === true` — finality, not quiet,
   *   is the evidence: an assistant text block followed by a tool call looks
   *   exactly like a finished reply until the tool result lands, and the
   *   parser stamps `final` only on positive end-of-turn evidence (absent
   *   means "maybe still running", which for billing-grade closure means NO);
   * - the armedAt bound — a turn that opened before the dispatch armed
   *   (slack-adjusted for the two clocks involved) is somebody else's
   *   exchange;
   * - FULL prompt identity — timestamp order is eligibility, the prompt is
   *   proof, and the proof is the whole normalized prompt, never a prefix.
   *
   * Scans every record inside the armed window OLDEST-first, not just
   * `history.at(-1)` (Sol r2 P0, tail overtake; direction per Sol r3 P0-2):
   * a new user prompt arriving between growth and the quiet poll appends a
   * fresh non-final tail, and the dispatched turn's finalized record then
   * sits one row back — where a tail-only closer would never look again.
   * OLDEST-first because the dispatch was delivered FIRST: with producers
   * serialized an identical later human turn should not exist, but if one
   * ever does, the earlier record is the dispatch's own delivery and the
   * later one must not be consumed in its place.
   *
   * A final record with an EMPTY reply still closes (Sol r3 P1-8): a
   * tool/artifact-only turn carries every ownership and finality proof the
   * closure needs, and the dispatch record's hasReply semantics say honestly
   * that no text came back. And the record's parser-native `outcome` rides
   * the event (Sol r3 P1-7) — absent means 'done' until the parser lane
   * lands it — so a natively aborted/errored turn closes the dispatch as a
   * failure instead of stranding it for the sweep.
   */
  completeFromHistory(terminalId: string): void {
    const pending = this.pendingDispatch.get(terminalId)
    if (pending === undefined || !this.writesFromFile(terminalId)) return
    const records = this.histories.get(terminalId)
    if (!records) return
    const cutoff = pending.armedAt - DISPATCH_ARM_SLACK_MS
    // Records are time-ordered: walk back to the armed window's first row,
    // then scan forward so the OLDEST eligible match wins.
    let start = records.length
    while (start > 0 && records[start - 1].startedAt >= cutoff) start -= 1
    for (let i = start; i < records.length; i += 1) {
      const candidate = records[i]
      if (candidate.final !== true) continue
      if (!promptAnswersDispatch(candidate.prompt, pending.prompt)) continue
      this.pendingDispatch.delete(terminalId)
      this.deliveredPrompt.delete(terminalId)
      // Finality observed: the A4 open-turn fact this exchange minted ends.
      const openedAt = this.openTurnFacts.get(terminalId)
      if (openedAt !== undefined && openedAt <= candidate.endedAt + DISPATCH_ARM_SLACK_MS) {
        this.openTurnFacts.delete(terminalId)
      }
      // One public completion per exchange: if the scrape already emitted
      // THIS exchange's latency (matched by record identity — uuid when
      // reconciled, else prompt + queue order; an intervening owner turn
      // keeps its own outstanding entry), this event closes the dispatch but
      // must not mint a second sample.
      const latencyReported = this.consumeScrapeEmitted(terminalId, candidate)
      // Parser-native terminal outcome; absent = done (records written
      // before the parser lane landed the field, or a parser without one).
      const outcome = candidate.outcome
      this.emit('turn', {
        terminalId,
        durationMs: Math.max(0, candidate.endedAt - candidate.startedAt),
        dispatchId: pending.id,
        turnIndex: candidate.index,
        ...(candidate.uuid !== undefined ? { turnUuid: candidate.uuid } : {}),
        ...(latencyReported ? { latencyReported: true } : {}),
        ...(outcome !== undefined ? { outcome } : {})
      } satisfies CompletedTurn)
      return
    }
  }

  /**
   * The durable FINAL record answering (prompt, armedAt), or null. The
   * conductor wires this behind the dispatch sweep's hasFinalAnswer dep
   * (Sol r3 P0-6; payload per Sol r4 P0-3): the sweep commits the returned
   * record's OWN outcome and identity through the normal completion path
   * instead of converting proven finality into a timeout interruption. Same
   * eligibility window, same exact-bytes identity, and the same OLDEST-first
   * scan as completeFromHistory — this is a read-only probe of the identical
   * evidence, consuming nothing.
   */
  hasFinalAnswer(terminalId: string, prompt: string, armedAt: number): FinalTurnAnswer | null {
    const records = this.liveHistory(terminalId)
    const cutoff = armedAt - DISPATCH_ARM_SLACK_MS
    let start = records.length
    while (start > 0 && records[start - 1].startedAt >= cutoff) start -= 1
    for (let i = start; i < records.length; i += 1) {
      const candidate = records[i]
      if (candidate.final !== true) continue
      if (!promptAnswersDispatch(candidate.prompt, prompt)) continue
      return {
        turnIndex: candidate.index,
        ...(candidate.uuid !== undefined ? { uuid: candidate.uuid } : {}),
        ...(candidate.outcome !== undefined ? { outcome: candidate.outcome } : {}),
        ...(candidate.reply.length > 0 ? { reply: candidate.reply } : {})
      }
    }
    return null
  }

  /**
   * Match (and expire) a scrape-emitted latency observation against the
   * durable record that closes a dispatch (Sol r4 P1). Identity, in order of
   * strength: the record uuid a reconcile stamped onto the observation, else
   * the observation's prompt — consumed in QUEUE ORDER, first identifying
   * entry wins. Never a timestamp window: a nearby owner turn's observation
   * has a different prompt/uuid and keeps its own entry. `at` serves only as
   * the TTL clock and a not-older-than-the-record eligibility floor.
   */
  private consumeScrapeEmitted(terminalId: string, record: TurnRecord): boolean {
    const queue = this.scrapeEmitted.get(terminalId)
    if (queue === undefined) return false
    const floor = Date.now() - SCRAPE_EMIT_TTL_MS
    const live = queue.filter((o) => o.observedAt >= floor)
    const index = live.findIndex((o) =>
      o.uuid !== undefined && record.uuid !== undefined
        ? o.uuid === record.uuid
        : observationAnswers(o.prompt, record.prompt) &&
          record.startedAt >= o.startedAt - DISPATCH_ARM_SLACK_MS
    )
    const kept = index === -1 ? live : live.filter((_, i) => i !== index)
    if (kept.length === 0) this.scrapeEmitted.delete(terminalId)
    else this.scrapeEmitted.set(terminalId, kept)
    return index !== -1
  }

  /**
   * Record a scrape-emitted exchange observation, expiring stale entries.
   * Retention runs on OBSERVATION time, never the turn's start (Sol r5 P1):
   * the sample of a turn that ran longer than the TTL must still dedupe its
   * own file closure.
   */
  private noteScrapeEmitted(terminalId: string, startedAt: number, prompt: string | null): void {
    const now = Date.now()
    const floor = now - SCRAPE_EMIT_TTL_MS
    const kept = (this.scrapeEmitted.get(terminalId) ?? []).filter((o) => o.observedAt >= floor)
    this.scrapeEmitted.set(terminalId, [...kept, { startedAt, observedAt: now, prompt }])
  }

  /**
   * Bind outstanding scrape observations to the durable records a reconcile
   * just landed (Sol r4 P1): walk both in order, stamping each unmatched
   * observation with the uuid of the first eligible record whose prompt it
   * identifies. From then on the observation is consumed BY UUID — precise
   * even when two exchanges carry identical prompts. Bounded by the (small,
   * TTL-capped) observation queue, not by history length: the record scan
   * advances a cursor and never restarts.
   */
  private reconcileScrapeObservations(terminalId: string, records: TurnRecord[]): void {
    const queue = this.scrapeEmitted.get(terminalId)
    if (queue === undefined || queue.length === 0) return
    let cursor = 0
    const stamped = queue.map((observation) => {
      if (observation.uuid !== undefined) {
        for (let i = cursor; i < records.length; i += 1) {
          if (records[i].uuid === observation.uuid) {
            cursor = i + 1
            break
          }
        }
        return observation
      }
      for (let i = cursor; i < records.length; i += 1) {
        const record = records[i]
        if (record.uuid === undefined) continue
        if (record.startedAt < observation.startedAt - DISPATCH_ARM_SLACK_MS) continue
        if (!observationAnswers(observation.prompt, record.prompt)) continue
        cursor = i + 1
        return { ...observation, uuid: record.uuid }
      }
      return observation
    })
    this.scrapeEmitted.set(terminalId, stamped)
  }

  /**
   * Announce a finished exchange (the latency sample rides this for every
   * terminal), consuming the pending-dispatch stamp ONLY where the scrape is
   * the closing authority — a scrape-only terminal. A file-backed terminal's
   * stamp belongs to completeFromHistory: consuming it here, at
   * screen-settled time, let the correlation close against a history tail
   * the reconcile had not written yet. Where the scrape does own closure it
   * demands the same two proofs as the file path: the turn opened after the
   * dispatch armed (a human turn already in flight when the dispatch arrived
   * is somebody else's exchange) and the live turn's prompt matches the
   * dispatched one.
   */
  private emitCompletedTurn(
    terminalId: string,
    durationMs: number,
    startedAt: number,
    prompt: string | null,
    turnIndex?: number
  ): void {
    const pending = this.writesFromFile(terminalId)
      ? undefined
      : this.pendingDispatch.get(terminalId)
    // FULL prompt identity, like the file closer — and thanks to the
    // delivered-prompt fact (noteDispatchDelivered) the live prompt compared
    // here is the exact delivered text whenever the tracker holds one, not a
    // screen echo the TUI may have collapsed or truncated.
    const owns =
      pending !== undefined &&
      startedAt >= pending.armedAt &&
      prompt !== null &&
      promptAnswersDispatch(prompt, pending.prompt)
    if (owns) {
      this.pendingDispatch.delete(terminalId)
      this.deliveredPrompt.delete(terminalId)
    }
    this.emit('turn', {
      terminalId,
      durationMs,
      ...(turnIndex !== undefined ? { turnIndex } : {}),
      ...(owns ? { dispatchId: pending.id } : {})
    } satisfies CompletedTurn)
  }

  /** True when the session file owns this terminal's durable history. */
  private writesFromFile(terminalId: string): boolean {
    return this.fileBacked.has(terminalId)
  }

  /** Forget a removed terminal's turns (node deletion, not detach). */
  clearHistory(terminalId: string): void {
    this.histories.delete(terminalId)
    this.snapshots.delete(terminalId)
    this.store?.remove(terminalId)
    this.fileBacked.delete(terminalId)
    this.deliveredPrompt.delete(terminalId)
    this.scrapeEmitted.delete(terminalId)
    this.openTurnFacts.delete(terminalId)
  }

  /** Write out pending history saves now (app quit). */
  flushHistories(): void {
    this.store?.flushAll()
  }

  track(session: PtySession, agent: boolean): void {
    if (this.tracked.has(session.terminalId)) return
    const t: TrackedTerminal = {
      session,
      agent,
      phase: 'idle',
      promptBuffer: '',
      inPaste: false,
      heldInput: '',
      lastSubmitAt: 0,
      sawInputThisTurn: false,
      lastHealScanAt: 0,
      prompt: null,
      snapshot: '',
      turnStartLine: null,
      reply: null,
      title: null,
      titleGen: 0,
      turnStartedAt: 0,
      pushTimer: null,
      pollTimer: null,
      titleTimer: null,
      onInput: (data, source) => this.handleInput(session.terminalId, data, source),
      onData: (data) => this.handleData(session.terminalId, data),
      onExit: () => this.handleExit(session.terminalId)
    }
    // Restore the last exchange across restarts and workspace switches:
    // cards render ask+reply from tracker state, which would otherwise come
    // back blank-idle even though history survived on disk. An unread last
    // turn returns as 'replied' (TURN COMPLETE) — a restart must not count
    // as acknowledgement. A mid-turn agent self-heals to 'thinking' from its
    // live spinner output moments later.
    if (agent) {
      const history = this.liveHistory(session.terminalId)
      const last = history[history.length - 1]
      if (last) {
        t.prompt = last.prompt
        t.reply = last.reply
        t.title = last.title ?? null
        t.phase = last.seenAt === undefined ? 'replied' : 'idle'
      }
    }
    session.on('input', t.onInput)
    session.on('data', t.onData)
    session.on('exit', t.onExit)
    this.tracked.set(session.terminalId, t)
  }

  /**
   * On process exit, broadcast a final idle activity so cards don't freeze
   * mid-'thinking' — without touching the (possibly disposed) screen buffer.
   */
  private handleExit(terminalId: string): void {
    const t = this.tracked.get(terminalId)
    if (t) {
      this.emit('activity', {
        terminalId,
        agent: t.agent,
        phase: 'idle',
        prompt: t.prompt,
        pendingInput: null,
        lines: ['— process exited —'],
        reply: t.reply,
        glance: null,
        title: t.title,
        turnCount: this.historyCount(terminalId),
        turnStartedAt: null,
        turnStartLine: null,
        scrollRow: null,
        scrollBase: null,
        tailLines: null,
        updatedAt: Date.now()
      } satisfies TerminalActivity)
    }
    // The process is gone: no turn can be in flight behind it, so the A4
    // fact (and any waiting delivered prompt) ends here rather than holding
    // a watch open for an agent that no longer exists.
    this.openTurnFacts.delete(terminalId)
    this.deliveredPrompt.delete(terminalId)
    this.untrack(terminalId)
  }

  untrack(terminalId: string): void {
    const t = this.tracked.get(terminalId)
    if (!t) return
    if (t.pushTimer) clearTimeout(t.pushTimer)
    if (t.pollTimer) clearInterval(t.pollTimer)
    if (t.titleTimer) clearTimeout(t.titleTimer)
    t.session.removeListener('input', t.onInput)
    t.session.removeListener('data', t.onData)
    t.session.removeListener('exit', t.onExit)
    this.tracked.delete(terminalId)
  }

  list(): TerminalActivity[] {
    return [...this.tracked.keys()].map((id) => this.activityOf(id)).filter(
      (a): a is TerminalActivity => a !== null
    )
  }

  disposeAll(): void {
    this.stopBackfillPump()
    for (const id of [...this.tracked.keys()]) this.untrack(id)
    // Deliberately NOT cleared by untrack: a workspace switch detaches the
    // view while the agent keeps working, and the stamp must survive to meet
    // the turn when the terminal is re-tracked. Only full teardown drops it —
    // the dispatch side (clearDispatch) handles every per-dispatch ending.
    this.pendingDispatch.clear()
    this.deliveredPrompt.clear()
    this.scrapeEmitted.clear()
    this.openTurnFacts.clear()
  }

  private handleInput(terminalId: string, data: string, source?: 'dispatch'): void {
    const t = this.tracked.get(terminalId)
    if (!t) return
    const fed = feedPromptBuffer(t.promptBuffer, data, t.inPaste, t.heldInput)
    t.promptBuffer = fed.buffer
    t.inPaste = fed.inPaste
    t.heldInput = fed.held
    if (!t.agent) return
    if (fed.submitted.length > 0) t.lastSubmitAt = Date.now()
    if (fed.submitted.length > 0 || fed.buffer.trim().length > 0) t.sawInputThisTurn = true
    if (t.phase === 'waiting' && fed.submitted.length > 0 && t.prompt !== null) {
      // Enter on an approval/question menu answers the SAME real turn — resume
      // thinking with the original prompt and snapshot intact. A PROMPTLESS
      // 'waiting' turn is a self-heal boot phantom (e.g. a fresh Codex whose
      // boot screen tripped attention detection), NOT a menu to answer — the
      // submitted text is the real first prompt, so fall through to startTurn.
      t.phase = 'thinking'
      t.lastSubmitAt = 0
      this.push(t)
      return
    }
    const prompt = fed.submitted.filter((s) => s.length > 0).pop()
    if (prompt !== undefined) {
      // BEFORE the owner's turn opens: preempt an armed dispatch (Sol r3
      // P0-2c). The wired interrupt disarms the stamp synchronously, so the
      // turn that opens below is the owner's alone — never a candidate for
      // the dispatch's closure. Menu answers (empty submits) and typing that
      // never submits do not preempt: they feed the CURRENT turn, whichever
      // producer opened it, and produce no competing exchange. The dispatch's
      // own pty-fallback delivery arrives source-tagged and is exempt by that
      // PROVENANCE (Sol r4 P0-1b) — identical owner bytes still preempt.
      // 'preempt-failed' here is the unguarded belt (the PTY guard refuses
      // the bytes upstream when wired): the bytes already reached the child,
      // but the tracker refuses to open an owner turn beside a reservation
      // whose interrupt could not commit — fail-closed, self-heal will
      // re-derive the screen state once the dispatch resolves.
      if (this.preemptOnOwnerSubmit(terminalId, source) === 'preempt-failed') {
        this.schedulePush(terminalId)
        return
      }
      this.startTurn(t, prompt)
      return
    }
    // No submit: the input box content changed (typing, paste) — surface it
    // as pendingInput on the next throttled push.
    this.schedulePush(terminalId)
  }

  /**
   * The PTY write guard's tracker half (Sol r4 P0-1a), wired by the conductor
   * onto PtySession.beforeOwnerInput and consulted BEFORE proc.write. A pure
   * PEEK: feedPromptBuffer is side-effect-free here — the real state advances
   * only when the delivered bytes come back through handleInput.
   *
   * TWO LAYERS since Sol r6 P0-1. While a dispatch DELIVERY holds the
   * producer lease — its paste possibly half-ingested in the shared input box
   * — every owner byte that does not carry a preempting submission is REFUSED
   * outright: typing, menu Enters and bare Enters alike would land inside (or
   * submit) a buffer containing a partial dispatch delivery. A SUBMITTING
   * owner write still routes to the durable preemption below: owner takeover
   * interrupts the dispatch first, and the displaced delivery leg's
   * stillValid check stops every byte it has not yet written. While a
   * dispatch is merely ARMED (stamped, not delivering — no lease hold),
   * behavior is unchanged: typing and menu answers pass, only a new-prompt
   * submission triggers preemption.
   */
  guardOwnerInput(terminalId: string, data: string): OwnerInputVerdict {
    const delivering = this.lease.holderOf(terminalId)?.kind === 'dispatch'
    const t = this.tracked.get(terminalId)
    if (!t || !t.agent) return delivering ? 'refused' : 'allow'
    if (!delivering && !this.pendingDispatch.has(terminalId)) return 'allow'
    const fed = feedPromptBuffer(t.promptBuffer, data, t.inPaste, t.heldInput)
    if (t.phase === 'waiting' && fed.submitted.length > 0 && t.prompt !== null) {
      // A menu answer submits whatever the input box holds — mid-delivery
      // that includes the dispatch's partial paste, so it is refused with
      // the other non-preempting bytes.
      return delivering ? 'refused' : 'allow'
    }
    const submits = fed.submitted.some((s) => s.length > 0)
    if (!submits) return delivering ? 'refused' : 'allow'
    // A delivery holding the lease with NO armed stamp left to preempt is a
    // leg still unwinding (the interrupt already disarmed it): fail closed
    // until its hold clears rather than submit beside its residue.
    if (delivering && !this.pendingDispatch.has(terminalId)) return 'refused'
    return this.preemptOnOwnerSubmit(terminalId, undefined)
  }

  /**
   * The local-producer serializer's trigger (Sol r3 P0-2c, hardened per
   * Sol r4 P0-1): a NEW prompt is being submitted at a terminal carrying an
   * armed dispatch.
   *
   * - Source-tagged dispatch input (the pty-fallback's own delivery) is
   *   exempt by PROVENANCE — byte equality proves nothing about who typed,
   *   so an owner submitting the identical bytes still preempts (P0-1b).
   * - A dispatch whose answer is already SETTLED is exempt: the live turn
   *   must be `replied` with the dispatched prompt (a still-thinking turn is
   *   not an answer — P0-1c), or a durable final row must match. Preemption
   *   serializes producers racing the delivery; a completed exchange is not
   *   being raced, and interrupting it would overwrite a proven outcome with
   *   a weaker one (the P0-3 inversion).
   * - The preemption is SYNCHRONOUS-DURABLE (P0-1d): the wired callback
   *   interrupts and reports whether the terminal row committed. An explicit
   *   false — the intent parked fail-closed with its reservation — refuses
   *   the owner's write; the stamp stays armed and a later submission
   *   retries the preemption once the ledger recovers.
   */
  private preemptOnOwnerSubmit(terminalId: string, source?: 'dispatch'): OwnerInputVerdict {
    const pending = this.pendingDispatch.get(terminalId)
    if (pending === undefined || source === 'dispatch') return 'allow'
    if (pending.preemptFired === true) return 'allow'
    const t = this.tracked.get(terminalId)
    const answeredOnScreen =
      t !== undefined &&
      t.phase === 'replied' &&
      t.prompt === pending.prompt &&
      t.turnStartedAt >= pending.armedAt - IN_FLIGHT_STAMP_SLACK_MS
    if (
      answeredOnScreen ||
      this.hasFinalAnswer(terminalId, pending.prompt, pending.armedAt) !== null
    ) {
      return 'allow'
    }
    if (this.onOwnerPreempt === null) {
      // Unwired (tests, plain trackers): nothing can interrupt, so record
      // that preemption was owed and let the input through — the historical
      // behavior, safe only because production always wires the callback.
      this.pendingDispatch.set(terminalId, { ...pending, preemptFired: true })
      return 'allow'
    }
    const committed = this.onOwnerPreempt(terminalId)
    if (committed === false) return 'preempt-failed'
    // The wiring normally disarms the stamp synchronously (clearDispatch via
    // the interrupt's release); if a callback chose not to, the flag keeps
    // this dispatch from being preempted twice.
    const still = this.pendingDispatch.get(terminalId)
    if (still !== undefined && still.id === pending.id) {
      this.pendingDispatch.set(terminalId, { ...still, preemptFired: true })
    }
    return 'allow'
  }

  private startTurn(t: TrackedTerminal, prompt: string): void {
    t.snapshot = t.session.fullText()
    // Monotonic tmux anchor when available; the screen-derived count is the
    // non-tmux fallback only (under tmux it saturates at pane rows).
    t.turnStartLine = t.session.scrollAnchor?.() ?? scrollLineOf(t.snapshot)
    t.phase = 'thinking'
    t.lastSubmitAt = 0
    t.sawInputThisTurn = true
    t.prompt = prompt
    t.reply = null
    t.title = null
    t.titleGen += 1
    t.turnStartedAt = Date.now()
    // A TYPED prompt (this path) is already exact — a delivered-prompt fact
    // still waiting here belongs to no turn now, and left behind it could
    // relabel a later self-heal open. Turn open is an A4 fact.
    this.deliveredPrompt.delete(t.session.terminalId)
    this.openTurnFacts.set(t.session.terminalId, t.turnStartedAt)
    if (!t.pollTimer) {
      t.pollTimer = setInterval(() => this.poll(t), POLL_MS)
    }
    this.scheduleTitle(t, TITLE_FIRST_MS)
    this.push(t)
  }

  private scheduleTitle(t: TrackedTerminal, delay: number): void {
    if (t.titleTimer) clearTimeout(t.titleTimer)
    t.titleTimer = setTimeout(() => {
      t.titleTimer = null
      void this.refreshTitle(t)
    }, delay)
  }

  /**
   * Ask the local model (Sous) what the running turn is doing and surface it
   * as the card title. Best effort: a summarizer returning null (no Ollama,
   * timeout) leaves the title untouched, and a generation bump — a new turn
   * started while the request was in flight — discards the stale result.
   */
  private async refreshTitle(t: TrackedTerminal): Promise<void> {
    if (t.phase !== 'thinking' && t.phase !== 'waiting') return
    const gen = t.titleGen
    const delta = diffOutput(t.snapshot, t.session.fullText())
    const title = await this.summarize({
      prompt: t.prompt ?? '',
      tools: parseAgentGlance(delta).tools,
      lines: cleanTurnLines(delta)
    })
    if (this.tracked.get(t.session.terminalId) !== t || t.titleGen !== gen) return
    if (t.phase !== 'thinking' && t.phase !== 'waiting') return
    if (title !== null && title !== t.title) {
      t.title = title
      this.push(t)
    }
    this.scheduleTitle(t, TITLE_REFRESH_MS)
  }

  /**
   * New output while 'waiting' means the human answered (or the agent moved
   * on) — resume 'thinking' so quiescence re-evaluates. Menu redraws flip
   * back and forth harmlessly: quiet + question tail lands on 'waiting'
   * again.
   *
   * Agent output while 'replied'/'idle' is a tracker desync (missed turn
   * start, premature quiescence, tmux reattach mid-turn) — self-heal so a
   * working agent can never stay stuck on a green or idle card.
   */
  private handleData(terminalId: string, data: string): void {
    const t = this.tracked.get(terminalId)
    if (!t) return
    if (t.phase === 'waiting') {
      t.phase = 'thinking'
    } else if (
      t.agent &&
      (t.phase === 'replied' || t.phase === 'idle') &&
      this.shouldSelfHeal(t, data)
    ) {
      this.resumeThinking(t)
    }
    this.schedulePush(terminalId)
  }

  /**
   * Desync signals, in order:
   * - input the tracker saw but never turned into a turn (buffered/pasted
   *   text, or a recent Enter that started nothing) followed by any
   *   agent-transcript output, or
   * - a live spinner in the chunk itself — covers reattach cases where this
   *   tracker never saw the prompt at all, or
   * - a live spinner on the RENDERED screen. tmux repaints changed cells
   *   with cursor addressing, so the spinner line almost never arrives
   *   intact in one chunk; the screen is the reliable source. Throttled —
   *   serializing the viewport on every chunk would be wasteful.
   */
  private shouldSelfHeal(t: TrackedTerminal, chunk: string): boolean {
    if (this.hasPendingInput(t) && detectAgentActivity(chunk)) return true
    if (detectLiveWork(chunk)) return true
    const now = Date.now()
    if (now - t.lastHealScanAt < HEAL_SCAN_MS) return false
    t.lastHealScanAt = now
    return detectLiveWork(t.session.viewportText())
  }

  private hasPendingInput(t: TrackedTerminal): boolean {
    if (t.promptBuffer.trim().length > 0) return true
    return t.lastSubmitAt !== 0 && Date.now() - t.lastSubmitAt < RESUME_WINDOW_MS
  }

  /**
   * Re-enter 'thinking'. From 'replied' this resumes the existing turn
   * context (prompt, snapshot, start time) so the eventual re-completion
   * records the full exchange; from a cold 'idle' (no prior turn) it opens
   * an unlabeled turn anchored at the current buffer state.
   */
  private resumeThinking(t: TrackedTerminal): void {
    if (t.turnStartedAt === 0) {
      t.snapshot = t.session.fullText()
      t.turnStartLine = t.session.scrollAnchor?.() ?? scrollLineOf(t.snapshot)
      t.turnStartedAt = Date.now()
      // Prompt-of-record, strongest first: a confirmed native delivery's
      // EXACT text (noteDispatchDelivered — the screen may show a collapsed
      // "[Pasted text #1 …]" or a truncated echo of it, neither of which can
      // prove prompt identity at closure). Then the TUI's own echo, recovered
      // from the screen (typed before this tracker existed — reattach). Then
      // the still-buffered input: a fresh Codex terminal whose ask pasted the
      // prompt (Enter not yet submitted) has no "> prompt" echo on its boot
      // screen, so recover the prompt we actually captured instead of
      // labelling the first turn '(recovered turn)'.
      const delivered = this.takeDeliveredPrompt(t.session.terminalId)
      t.prompt =
        delivered ??
        extractPromptEcho(cleanTurnLines(t.snapshot)) ??
        (t.promptBuffer.trim() || null)
      // Boot-noise until proven otherwise: only mark input-seen if something
      // real fed this turn — a delivered dispatch prompt, or input the ask
      // had already buffered when this phantom opened.
      t.sawInputThisTurn = delivered !== null || t.promptBuffer.trim().length > 0
    }
    this.openTurnFacts.set(t.session.terminalId, t.turnStartedAt)
    t.phase = 'thinking'
    t.reply = null
    t.lastSubmitAt = 0
    if (!t.pollTimer) {
      t.pollTimer = setInterval(() => this.poll(t), POLL_MS)
    }
    this.scheduleTitle(t, TITLE_FIRST_MS)
    this.push(t)
  }

  private poll(t: TrackedTerminal): void {
    if (t.phase !== 'thinking') return
    const elapsed = Date.now() - t.turnStartedAt
    if (elapsed < GRACE_MS) return

    // Three questions decide whether this turn is over: is the agent still
    // working, is it blocked on the human, and has it gone quiet.
    //
    // herdr's answer is used ASYMMETRICALLY, and the asymmetry is the fix for
    // a live bug: its per-pane detector can STICK (measured: 'idle' seq 1
    // under a 48s spinner, while a neighbouring pane tracked fine). A stuck
    // 'idle' that is trusted outright bypasses both the quiescence gate and
    // the spinner hold — the turn falsely ends, a checkpoint is minted, output
    // keeps flowing, self-heal reopens the turn, and the card flaps
    // READY → WORKING → endpoint-saved in a loop that spams phantom
    // checkpoints (the user watched it happen).
    //
    // So: a POSITIVE herdr signal ('working', 'blocked') may hold a turn open
    // or mark it waiting — worst case is a late turn end. A NEGATIVE one
    // ('idle') may never end a turn on its own — ending needs the observable
    // corroboration (output quiet AND no live spinner) that was always
    // required before herdr existed. Cheap to check, immune to a stuck feed.
    const reported = agentStatus(t.session.sessionName)
    // Hold while herdr says working — this survives long silent tool calls,
    // which is the feed's real value — but not FOREVER: a detector stuck at
    // 'working' would otherwise pin the turn open for the rest of the run.
    if (reported === 'working' && t.session.idleFor() < WORKING_TRUST_MS) return
    if (t.session.idleFor() < QUIESCENCE_MS) return

    const delta = diffOutput(t.snapshot, t.session.fullText())
    // Agents pause well past quiescence mid-turn (long tool calls, slow
    // output). While the tail still shows an in-flight spinner the turn is
    // NOT over — hold it open, REGARDLESS of what the feed claims: the screen
    // is the corroboration a stuck 'idle' cannot fake.
    const glanceStatus = parseAgentGlance(delta).status
    if (glanceStatus !== null && isLiveStatus(glanceStatus)) return
    const lines = cleanTurnLines(delta).filter((l) => !this.isPromptEcho(l, t.prompt))
    if (reported === 'blocked' || detectAttention(lines)) {
      // Blocked on the human — keep the poll alive; handleData resumes
      // 'thinking' when output flows again.
      t.phase = 'waiting'
      this.push(t)
      return
    }
    // Prefer the parsed final assistant message over the raw tail — the tail
    // includes tool-call noise (Bash(...) / ⎿ result lines).
    const finalMessage = parseAgentGlance(delta).message
    t.reply = finalMessage ?? tailLines(lines, REPLY_TAIL).join('\n').trim()
    t.phase = 'replied'
    const id = t.session.terminalId
    this.stopTurnTimers(t)
    // The scrape watched this turn end — the A4 open-turn fact it minted is
    // resolved, discard paths included (a discarded boot phantom is not work
    // in flight either).
    this.openTurnFacts.delete(id)
    // A promptless self-heal turn that ALSO never saw user input is boot
    // noise — a fresh agent's boot screen (e.g. Codex) tripping self-heal,
    // not an exchange. Recording it as '(recovered turn)' would mint a
    // phantom checkpoint and shift every later index, so discard it (boot
    // output in the reply is not a real turn). A promptless turn that DID see
    // input keeps the synthetic label; session-bound agents additionally get
    // the real turn from the session-file reconcile.
    // Use the STICKY per-turn flag, not lastSubmitAt: resumeThinking resets
    // lastSubmitAt to 0, so a first ask that merged into a boot phantom would
    // otherwise finalize looking input-less and be discarded (the Codex
    // first-ask drop). sawInputThisTurn survives the resume.
    if (t.prompt === null && !t.sawInputThisTurn) {
      this.push(t)
      return
    }
    // A typed slash command (/rewind, /clear …) is a UI action, not an
    // exchange — the session file records it as a command, not a user
    // message, so a scrape checkpoint here would break the 1:1 with the
    // session list. Discard it; a real '/…' prompt is re-added on reconcile.
    if (t.prompt !== null && isCommandPrompt(t.prompt)) {
      this.push(t)
      return
    }
    // A real exchange just ended: announce how long it took (latency spec
    // p95-p98). Emitted past the two discards above, so the samples are
    // turns somebody actually waited on — never a boot screen tripping
    // self-heal, never a typed slash command.
    //
    // The tracker does not reach the event log itself — index.ts translates
    // this into store.recordEvent, so latency enters through the same
    // choke-point as every other event and cannot diverge from it.
    //
    // STEP 4: the session file is a file-backed terminal's record. Appending
    // here would be a second writer of the same exchange — historically it
    // landed a uuid-less duplicate that dedupePhantomEchoes then had to
    // throw away. The live turn above (phase, glance, reply, pendingInput)
    // is still ours; only the durable write belongs to the file. The Sous
    // title does NOT get dropped: it lands on the record the reconcile
    // already created for this turn, and if that record has not arrived yet
    // the backfill pump fills it. The latency emit still fires — marked in
    // scrapeEmitted so the file closer enriching the SAME exchange with its
    // dispatch closure never mints a second public sample.
    if (this.writesFromFile(id)) {
      if (t.turnStartedAt > 0) {
        this.noteScrapeEmitted(id, t.turnStartedAt, t.prompt)
        this.emitCompletedTurn(id, Date.now() - t.turnStartedAt, t.turnStartedAt, t.prompt)
      }
      this.push(t)
      const reconciled = this.liveTurnRecordIndex(t)
      if (reconciled !== null) void this.finalizeTitle(t, reconciled)
      return
    }
    // SCRAPE-owned history: the record is appended and deduped BEFORE the
    // completion event fires (Sol r2 P0). The 'turn' listener runs
    // synchronously and closes a dispatch against the history it can see at
    // that instant — emitting first handed it the PREVIOUS exchange as the
    // tail (or an empty history on a first turn), and the dispatch was
    // billed against a turn it did not commission.
    const appended = appendTurnRecord(this.liveHistory(id), {
      prompt: t.prompt ?? RECOVERED_PROMPT_LABEL,
      reply: t.reply,
      ...(t.title !== null ? { title: t.title } : {}),
      ...(t.turnStartLine !== null ? { scrollLine: t.turnStartLine } : {}),
      startedAt: t.turnStartedAt,
      endedAt: Date.now()
    })
    // A split-echo double-submit lands a uuid-less scrape record next to the
    // reconciled uuid original — drop it here so it never persists or shows,
    // instead of waiting for the next reconcile to full-replace it away.
    const newRecord = appended[appended.length - 1]
    const deduped = dedupePhantomEchoes(appended)
    this.setHistory(id, deduped)
    this.store?.scheduleSave(id, deduped)
    const survived = deduped.some((r) => r.index === newRecord.index)
    if (t.turnStartedAt > 0) {
      const recordIndex = survived ? newRecord.index : deduped[deduped.length - 1]?.index
      this.emitCompletedTurn(
        id,
        Date.now() - t.turnStartedAt,
        t.turnStartedAt,
        t.prompt,
        recordIndex
      )
    }
    this.push(t)
    // Skip the title pass when the just-appended turn was itself the phantom.
    if (survived) {
      void this.finalizeTitle(t, newRecord.index)
    }
  }

  /**
   * The reconciled record covering the turn that just finished, when it is
   * already there and still untitled — the target for the final Sous pass on
   * a file-backed terminal. Null when the reconcile has not caught up yet
   * (the backfill pump titles it on a later tick) or the record is titled.
   */
  private liveTurnRecordIndex(t: TrackedTerminal): number | null {
    const history = this.liveHistory(t.session.terminalId)
    const last = history[history.length - 1]
    if (!last || last.title !== undefined) return null
    return promptsMatch(t.prompt ?? '', last.prompt) ? last.index : null
  }

  private stopTurnTimers(t: TrackedTerminal): void {
    if (t.pollTimer) {
      clearInterval(t.pollTimer)
      t.pollTimer = null
    }
    if (t.titleTimer) {
      clearTimeout(t.titleTimer)
      t.titleTimer = null
    }
  }

  /**
   * Final Sous pass once a turn completed: summarize prompt + full reply and
   * back-fill the freshly appended TurnRecord. This is what gives short
   * turns (which end before any mid-turn refresh fires) their title.
   *
   * INDEXED DELTA, not a whole-history map/full-save (Sol r6, r5 P1's
   * evidence): a title is an annotation-only change to ONE record. Locate it,
   * replace just that slot in the tracker-private buffer (the sanctioned
   * in-place bend — see `histories`), and hand the store exactly the changed
   * record via scheduleDelta: the annotation pass folds in one record and the
   * conversation flush writes nothing, because a title never alters a
   * conversation line. The record is normally the tail; when a newer turn
   * landed while Sous summarized, the flush's own tail check simply falls
   * back to the safe full write — correctness never rides on position.
   */
  private async finalizeTitle(t: TrackedTerminal, recordIndex: number): Promise<void> {
    const gen = t.titleGen
    const title = await this.summarize({
      prompt: t.prompt ?? '',
      tools: [],
      lines: (t.reply ?? '').split('\n')
    })
    if (title === null) return
    const id = t.session.terminalId
    const history = this.histories.get(id)
    const at = history === undefined ? -1 : lastPositionOfIndex(history, recordIndex)
    if (history !== undefined && at !== -1) {
      const titled = { ...history[at], title }
      history[at] = titled
      this.snapshots.delete(id)
      this.store?.scheduleDelta(id, history, [titled])
    }
    // Only retitle the live card if no new turn started while summarizing.
    if (this.tracked.get(id) === t && t.titleGen === gen && t.phase === 'replied') {
      t.title = title
      this.push(t)
    }
  }

  private isPromptEcho(line: string, prompt: string | null): boolean {
    if (!prompt) return false
    const trimmed = line.trim()
    return trimmed === prompt || trimmed === `> ${prompt}`
  }

  private schedulePush(terminalId: string): void {
    const t = this.tracked.get(terminalId)
    if (!t || t.pushTimer) return
    t.pushTimer = setTimeout(() => {
      t.pushTimer = null
      this.push(t)
    }, PUSH_THROTTLE_MS)
  }

  private push(t: TrackedTerminal): void {
    const activity = this.activityOf(t.session.terminalId)
    if (activity) this.emit('activity', activity)
  }

  private activityOf(terminalId: string): TerminalActivity | null {
    const t = this.tracked.get(terminalId)
    if (!t) return null
    const inTurn = t.phase === 'thinking' || t.phase === 'waiting'
    // The glance parser needs the RAW delta (status lines are chrome that
    // cleanTurnLines strips); the display tail uses the cleaned one.
    const rawDelta = inTurn ? diffOutput(t.snapshot, t.session.fullText()) : ''
    const lines = inTurn
      ? tailLines(
          cleanTurnLines(rawDelta).filter((l) => !this.isPromptEcho(l, t.prompt)),
          SUMMARY_TAIL
        )
      : tailLines(cleanTurnLines(t.session.viewportText()), SUMMARY_TAIL)
    const pending = t.promptBuffer.trim()
    const pane = t.session.paneScrollState?.() ?? { scrollRow: null, historySize: null }
    return {
      terminalId,
      agent: t.agent,
      phase: t.phase,
      prompt: t.prompt,
      pendingInput: pending.length > 0 ? pending : null,
      lines,
      reply: t.reply,
      glance: t.agent && inTurn ? parseAgentGlance(rawDelta) : null,
      title: t.title,
      turnCount: this.historyCount(terminalId),
      turnStartedAt: inTurn ? t.turnStartedAt : null,
      turnStartLine: inTurn ? t.turnStartLine : null,
      // ONE combined tmux round-trip for both fields (optional-called; fakes
      // may not implement it). Deliberately NOT gated off during a turn: the
      // user can be in copy-mode WHILE the agent streams (scroll→step's main
      // case), and scrollBase must convert anchors at any time. Cost is one
      // ~2ms display-message per throttled push (≥250ms apart per terminal).
      scrollRow: pane.scrollRow,
      scrollBase: pane.historySize,
      // Clip signal only when the tail is settled — mid-turn the renderer
      // shows the whole live stream anyway.
      tailLines: inTurn || !t.agent ? null : latestTailLines(t.session.fullText()),
      updatedAt: Date.now()
    }
  }
}
