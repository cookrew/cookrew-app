// Sous, holding the wheel.
//
// One sentence arrives from any of four doors — the Mac's ⌘-hold, the phone's
// 🎙️, the living-room speaker via voice-gateway, `cookrew sous "…"` — with
// the surface it came from. It is parsed (shared/sous-intent, deterministic),
// then EXECUTED here against the same store operations the socket verbs use,
// and one spoken sentence goes back for the surface to say however it says
// things. The controller never speaks and never listens; it only decides and
// does, which is what makes the CLI a complete driver for it.
//
// The caller is the OWNER, not an agent, so nothing here is gated by
// requireOrch — but the intent set is closed, and free text has exactly one
// sink: `submit`, the paste-safe prompt path into an agent the owner named.

import {
  PENDING_PROMPT_MS,
  parseUtterance,
  type IntentRoster,
  type Lang,
  type PendingPrompt,
  type Refusal,
  type SousIntent,
  type Surface
} from '../shared/sous-intent'
import { randomUUID } from 'node:crypto'
import { rankHearings, vocabularyOf } from '../shared/sous-hearing'
import type { UiCommand } from '../shared/sous-ui'
import { DECISION_HOLD_MS, DECISION_TTL_MS, decide, type Alternate, type DecideCandidate, type DecisionDraft, type DecisionMode, type Harness, type RoutingFacts, type StatusFacts } from '../shared/sous-decide'

export type { DecisionMode } from '../shared/sous-decide'

export interface SousControlDeps {
  /** The live roster, read per sentence — names change under a running app. */
  roster: () => IntentRoster
  activeWorkspaceId: () => string | null
  switchWorkspace: (workspaceId: string) => void | Promise<void>
  /** A new card in the ACTIVE workspace, booted. */
  createTerminal: (input: { preset: string; name: string }) => { id: string; name: string }
  /** A browser card anchored to and connected with that terminal. */
  createBrowser: (anchorTerminalId: string, name: string) => Promise<void>
  connect: (a: string, b: string) => void
  rename: (agentId: string, name: string) => void
  /**
   * Put text into the agent. `enter` false types it into the input box and
   * leaves it there for the owner to read and send — Typeless behaviour, for
   * the surface where they are looking at the box; true submits it, for the
   * surfaces where nobody can press Enter (a speaker in a room). Resolves at
   * submission; the reply is the ledger's business.
   */
  submit: (agentId: string, text: string, options: { enter: boolean }) => Promise<void>
  /**
   * Thinking-aloud → the text they meant (shared/sous-polish). Given the raw
   * transcript, returns the cleaned one or the raw one, never nothing.
   */
  polish?: (text: string) => Promise<{ text: string; polished: boolean }>
  ui: (command: UiCommand, workspaceId: string) => void
  /** One ledger line per executed intent, so a misheard rename has a trail. */
  note?: (kind: string, subjectId: string | null, detail: string) => void
  now?: () => number
  /**
   * THE DECIDE STEP (route program R3). A sentence the intent core does not
   * match is a brief for the crew, and these are what Sous needs to pick who:
   * the cards as the Board sees them, the active workdir, and a way to
   * recruit a card beside the orch. Absent = the old behaviour, `none`.
   */
  decide?: {
    candidates: () => Promise<DecideCandidate[]> | DecideCandidate[]
    workdir: () => string | null
    /** A new card in the ACTIVE workspace, placed beside `besideId` (sous-decide placeBeside), wired to it, carrying the sentence as its `brief` (never as a role). */
    recruit: (input: { preset: Harness; name: string; brief: string; besideId: string | null; cwd: 'repo' | 'chores' }) => Promise<{ id: string; name: string }> | { id: string; name: string }
    /**
     * The brief into the recruited card, through the dispatch engine (its boot
     * wait, its ledger, its cable pulse from `originId`). Resolves once the
     * prompt reached the card; throws when it did not — the echo says "sent"
     * only after this resolves.
     */
    deliver: (input: { nodeId: string; sentence: string; originId: string | null; token?: string }) => Promise<{ dispatchId: string } | void>
    /** Mint the token a decision travels under. */
    token?: () => string
    /** Routability from the route service: whether a default route is set, which harnesses can be routed. */
    routing?: () => RoutingFacts | undefined
    /** What a status question is answered from, beyond the candidates. */
    status?: () => StatusFacts
    /**
     * The target card's route (or the recruit's intended one), and whether
     * taking the brief will respawn it — a respawn starts the hold paused.
     * Forge's `routeOfCard`; null until his lane lands (feature-detected).
     */
    routeOf?: (input: { cardId: string | null; harness: Harness | null }) => { route: string; effective: string | null; respawn: boolean } | null
    /** The Sous ledger: one row per decision, patched as it moves (sous-ledger.ts). */
    ledger?: { write: (patch: { token: string } & Record<string, unknown>) => void }
    /** Late revisions reach the box through this (IPC `sous:decision-updated`, SSE `sous`). */
    decisionUpdated?: (update: { token: string; alternates: Alternate[] }) => void
  }
}

/** Why a hold starts paused — the one of the four that applied. */
export function holdMode(input: { kind: DecisionDraft['kind']; answer: boolean; exposure: number; respawn: boolean; rewritten: boolean; box: boolean }): DecisionMode {
  if (input.kind === 'question') return input.answer ? 'answer' : 'question'
  if (input.exposure >= 2 || input.respawn || input.rewritten || !input.box) return 'paused'
  return 'ticking'
}

/** The exposure tier from which a plain commit is refused and `ack: 'send-anyway'` is required. */
export const ACK_EXPOSURE = 2

/**
 * A draft decision stamped for the box: the token to commit it under, how
 * long to hold. The HP facts (mode, exposure, boundaries, domain, route) ride
 * on the draft (shared DecisionFacts) — optional on the wire, always set here.
 */
export type Decision = DecisionDraft & { token: string; holdMs: number; sentence: string }

/** Who is committing or cancelling: the surface and caller the decision was minted for. */
export interface Caller {
  surface: Surface
  callerId?: string
}

/** What `commit` may change: the ask's target, or the recruit's harness. */
export interface CommitChoice {
  /** For `ask`: another candidate's id. For `recruit`: `harness:<name>`. */
  target?: string
  /** Exposure ≥ 2 commits only as a distinct act: the SEND ANYWAY control, which appends the Boundaries line to the brief. */
  ack?: 'send-anyway'
}

export interface SousCommandInput {
  text: string
  /**
   * What the other ears heard of the same audio. Tried, in order, when the
   * primary sentence is not a command or names someone the roster does not
   * have — the zh-CN ear's garbled syllables are the en-US ear's Conductor. Never used for
   * dictation: prose goes in as the primary heard it.
   */
  alternates?: readonly string[]
  surface: Surface
  /**
   * The sentence came from A BOX — a surface that will show the decision
   * echo and commit or cancel it (CommandBox on the desktop, the phone bar).
   * Push-to-talk, the CLI and the gateway only speak what comes back, so a
   * decision minted for them would be held by nobody; they send false (or
   * nothing) and keep the regex core exactly as before.
   */
  box?: boolean
  /**
   * WHO is speaking on that surface — the desktop, one phone, one speaker.
   * A surface is a class of door, not a device: two phones are both 'phone',
   * and a question Sous asked one of them must not be answered by the other.
   */
  callerId?: string
  /**
   * In the zoom view, the agent on screen. Trusted from the desktop and the
   * CLI (same trust boundary as the owner's keyboard); a network door must
   * NOT pass it — the controller remembers where it last zoomed each caller
   * and uses that instead, so free text over HTTP still cannot reach an agent
   * nobody named.
   */
  focusedAgentId?: string | null
}

export interface SousCommandResult {
  intent: SousIntent['kind'] | 'refused' | 'decide'
  spoken: string
  /** The decide step's answer, shown for `holdMs` then committed by token. */
  decision?: Decision
  needs?: 'prompt' | Refusal
  choices?: string[]
  /**
   * Why a commit was refused, for a door that answers in status codes:
   * `bad-target` is not one of the decision's choices (400), `expired` is a
   * token that was spent or outlived its hold (410).
   */
  error?: 'bad-target' | 'expired' | 'not-yours' | 'in-flight' | 'needs-ack'
  /** The agent the sentence ended up about, when there is one. */
  agentId?: string
  /** The text that went into the agent, after polish — so a surface can show it. */
  text?: string
  polished?: boolean
}

const FAILED = {
  zh: (what: string) => `没做成：${what}`,
  en: (what: string) => `That did not work: ${what}`
} as const

/** Typed into the box, not sent: the owner is looking at it. */
const IN_THE_BOX = {
  zh: (agent: string) => `已放进 ${agent} 的输入框，回车发送`,
  en: (agent: string) => `In ${agent}'s box — Enter sends`
} as const

/** Where a dictated sentence is typed and left, rather than submitted. */
const TYPES_WITHOUT_ENTER: ReadonlySet<Surface> = new Set(['zoom'])
/** The surfaces with a box: the only ones a decision is minted for. */
const DECIDING_SURFACES: ReadonlySet<Surface> = new Set(['canvas', 'phone'])
const NOT_A_CHOICE = { en: 'That is not one of the choices.', zh: '这不在可选项里。' } as const
const NOT_YOURS = { en: 'That decision was made for another box.' } as const
const IN_FLIGHT = { en: 'That brief is already on its way.' } as const
const NEEDS_ACK = { en: 'This one leaves the tree — send it anyway, with its boundary line.', zh: '这一步会影响仓库之外，请点「仍然发送」，并带上边界行。' } as const
/** Appended to a recruit echo whose harness runs direct (no default route, or not routable). */
export const DIRECT_NOTE = ' · will run direct'

const EXPIRED = { en: 'That decision expired — say it again.', zh: '这个决定已过期，再说一次。' } as const
const SENT = {
  zh: (agent: string) => `已派给 ${agent}`,
  en: (agent: string) => `Sent to ${agent}`
} as const
/** Said only after the brief reached the new card — never on creation alone. */
const RECRUITED = {
  zh: (harness: string, name: string) => `新建了 ${harness} 卡「${name}」，已派出`,
  en: (harness: string, name: string) => `New ${harness} card · ${name} · sent`
} as const

/** The line under the box: who, and the three reasons — or the question back. */
export function echoOf(decision: Decision, lang: Lang): string {
  if (decision.kind === 'ask') return `→ ${decision.target.name} (${decision.reasons.join(' · ')})`
  if (decision.kind === 'recruit') return `+ ${decision.harness} card · ${decision.name} (${decision.reasons.join(' · ')})${decision.direct ? DIRECT_NOTE : ''}`
  return decision.mode === 'answer' && decision.answer ? decision.answer : decision.question
}

/** A decision shown and not yet spent; `recruited` survives a failed delivery so a retry does not mint a second card. */
interface DecisionSlot {
  decision: Decision
  surface: Surface
  key: string
  lang: Lang
  until: number
  committing: boolean
  recruited?: { id: string; name: string; harness: Harness }
  /** Set once the commit ran to the end: a late revise is ignored from here. */
  spent: boolean
}

export class SousController {
  /**
   * "What should I ask Conductor?" — asked by one caller on one surface, answered
   * by the same one. Keyed by both, so two phones, or the phone and the
   * speaker, never complete each other's questions.
   */
  private readonly pending = new Map<string, PendingPrompt>()
  /** Where Sous last zoomed each caller — the only focus a network door gets. */
  private readonly focus = new Map<string, string>()
  /** Decisions shown and not yet committed, by token; each dies after DECISION_TTL_MS. */
  private readonly decisions = new Map<string, DecisionSlot>()

  constructor(private readonly deps: SousControlDeps) {}

  /** What Sous is still waiting on for a caller, if anything unexpired. */
  pendingFor(surface: Surface, callerId?: string): PendingPrompt | null {
    const key = callerKey(surface, callerId)
    const slot = this.pending.get(key)
    if (!slot) return null
    if (slot.until <= this.now()) {
      this.pending.delete(key)
      return null
    }
    return slot
  }

  async handle(input: SousCommandInput): Promise<SousCommandResult> {
    const roster = this.deps.roster()
    const key = callerKey(input.surface, input.callerId)
    const ctx = {
      surface: input.surface,
      activeWorkspaceId: this.deps.activeWorkspaceId(),
      focusedAgentId: input.focusedAgentId ?? this.focus.get(key) ?? null,
      pending: this.pendingFor(input.surface, input.callerId)
    }
    const now = this.now()
    let parsed = parseUtterance(input.text, ctx, roster, now)
    // Another ear may have heard the names right. Only a COMMAND is worth
    // switching for, and only when the primary came up empty-handed: `none`,
    // or a name nobody on the roster has. A prompt stays the primary's words.
    //
    // WHICH ear, though, was decided by the order they were SPAWNED in: the
    // loop kept the first command-shaped hypothesis, including one that had
    // only got as far as "which Conductor?" — so the owner was asked a
    // question the ear beside it had already answered. Two ears race on one
    // microphone and their order is an accident of process startup; it must
    // not decide which agent gets the sentence.
    //
    // So the ears are ordered by how much of the CANVAS each one named
    // (sous-hearing.ts) and read in two passes: one that settled outright
    // beats one that is merely command-shaped.
    if (!isCommandThatResolved(parsed)) {
      const heard = rankHearings(input.alternates ?? [], vocabularyOf(roster))
      const tried = heard.map((alternate) => parseUtterance(alternate, ctx, roster, now))
      const settled = tried.find(
        (other) => other.ok && other.intent.kind !== 'none' && other.intent.kind !== 'prompt'
      )
      const better = settled ?? tried.find(isCommandThatResolved)
      if (better !== undefined) parsed = better
    }
    if (!parsed.ok) {
      return {
        intent: 'refused',
        spoken: parsed.spoken,
        needs: parsed.needs,
        ...(parsed.choices ? { choices: parsed.choices } : {})
      }
    }
    // THE DECIDE STEP: not a command the core knows, a sentence rather than
    // a word, and a surface that HAS a box to show the echo in and commit
    // from — the canvas and the phone. Voice, the CLI and the gateway only
    // speak what comes back, so a decision minted for them would expire
    // unseen; they keep the regex core and nothing more.
    if (parsed.intent.kind === 'none' && this.deps.decide && input.box === true && DECIDING_SURFACES.has(input.surface) && input.text.trim().length > 0) {
      try {
        return await this.decideStep(input.text.trim(), key, input.surface, parsed.lang)
      } catch (error) {
        const what = error instanceof Error ? error.message : String(error)
        console.error('Sous: decide failed:', error)
        return { intent: 'refused', spoken: FAILED[parsed.lang](what) }
      }
    }
    try {
      return await this.run(parsed.intent, parsed.spoken, key, roster, input.surface, parsed.lang)
    } catch (error) {
      const what = error instanceof Error ? error.message : String(error)
      console.error(`Sous: ${parsed.intent.kind} failed:`, error)
      return { intent: 'refused', spoken: FAILED[parsed.lang](what) }
    }
  }

  private async run(
    intent: SousIntent,
    spoken: string,
    key: string,
    roster: IntentRoster,
    surface: Surface,
    lang: Lang
  ): Promise<SousCommandResult> {
    const active = this.deps.activeWorkspaceId()
    switch (intent.kind) {
      case 'none':
        return { intent: 'none', spoken: '' }
      case 'back':
        if (active) this.deps.ui({ kind: 'zoom-back' }, active)
        this.focus.delete(key)
        return { intent: 'back', spoken }
      case 'open':
        if (active) this.deps.ui({ kind: 'zoom-back' }, active)
        this.focus.delete(key)
        this.note('open', null, 'cookrew')
        return { intent: 'open', spoken }
      case 'switch': {
        await this.moveTo(intent.workspaceId)
        this.deps.ui({ kind: 'zoom-back' }, intent.workspaceId)
        this.focus.delete(key)
        this.note('switch', intent.workspaceId, workspaceName(roster, intent.workspaceId))
        return { intent: 'switch', spoken }
      }
      case 'ask': {
        const agent = agentOf(roster, intent.agentId)
        await this.moveTo(agent.workspaceId)
        this.deps.ui({ kind: 'zoom', nodeId: agent.id }, agent.workspaceId)
        this.deps.ui({ kind: 'focus-input', nodeId: agent.id }, agent.workspaceId)
        this.focus.set(key, agent.id)
        if (intent.prompt === null) {
          this.pending.set(key, { kind: 'prompt', agentId: agent.id, until: this.now() + PENDING_PROMPT_MS })
          this.note('ask', agent.id, agent.name)
          return { intent: 'ask', spoken, needs: 'prompt', agentId: agent.id }
        }
        this.pending.delete(key)
        const sent = await this.deliver(agent, intent.prompt, surface, lang, spoken)
        return { intent: 'ask', ...sent }
      }
      case 'prompt': {
        const agent = agentOf(roster, intent.agentId)
        this.pending.delete(key)
        const sent = await this.deliver(agent, intent.text, surface, lang, spoken)
        return { intent: 'prompt', ...sent }
      }
      case 'create': {
        const target = intent.workspaceId ?? active
        if (target) await this.moveTo(target)
        const node = this.deps.createTerminal({ preset: intent.preset, name: intent.preset })
        if (intent.browser) await this.deps.createBrowser(node.id, `${node.name} browser`)
        const workspaceId = this.deps.activeWorkspaceId() ?? target ?? ''
        this.deps.ui({ kind: 'zoom', nodeId: node.id }, workspaceId)
        this.focus.set(key, node.id)
        this.note('create', node.id, `${node.name}${intent.browser ? ' + browser' : ''}`)
        return { intent: 'create', spoken, agentId: node.id }
      }
      case 'connect': {
        const a = agentOf(roster, intent.fromId)
        const b = agentOf(roster, intent.toId)
        this.deps.connect(a.id, b.id)
        this.note('connect', a.id, `${a.name} ↔ ${b.name}`)
        return { intent: 'connect', spoken }
      }
      case 'rename': {
        const agent = agentOf(roster, intent.agentId)
        this.deps.rename(agent.id, intent.to)
        this.note('rename', agent.id, `${agent.name} → ${intent.to}`)
        return { intent: 'rename', spoken, agentId: agent.id }
      }
    }
  }

  private async decideStep(sentence: string, key: string, surface: Surface, lang: Lang): Promise<SousCommandResult> {
    const deps = this.deps.decide
    if (!deps) return { intent: 'none', spoken: '' }
    const draft = decide(sentence, { candidates: await deps.candidates(), workdir: deps.workdir(), now: this.now(), routing: deps.routing?.(), status: deps.status?.() })
    const token = deps.token?.() ?? randomUUID()
    const routeFacts =
      deps.routeOf?.({ cardId: draft.kind === 'ask' ? draft.target.id : null, harness: draft.kind === 'recruit' ? draft.harness : draft.kind === 'ask' ? draft.recruit.harness : null }) ?? null
    const mode = holdMode({ kind: draft.kind, answer: draft.mode === 'answer', exposure: draft.exposure ?? 0, respawn: routeFacts?.respawn ?? false, rewritten: false, box: true })
    const decision = { ...draft, token, holdMs: DECISION_HOLD_MS, sentence, mode, route: routeFacts ? { route: routeFacts.route, effective: routeFacts.effective } : null } as Decision
    this.sweepDecisions()
    // A question is answered in the box and creates nothing — there is nothing to commit.
    if (draft.kind !== 'question') {
      this.decisions.set(token, { decision, surface, key, lang, until: this.now() + DECISION_TTL_MS, committing: false, spent: false })
      deps.ledger?.write({
        token,
        at: this.now(),
        sentence,
        domain: draft.domain ?? 'repo',
        exposure: draft.exposure ?? 0,
        mode,
        target: draft.kind === 'ask' ? draft.target : { id: `harness:${draft.harness}`, name: draft.harness },
        alternates: draft.alternates.map((a) => a.id),
        outcome: 'pending'
      })
    }
    this.note('decide', draft.kind === 'ask' ? draft.target.id : null, `${draft.kind}: ${draft.reasons.join(' · ')}`)
    return { intent: 'decide', spoken: echoOf(decision, lang), decision }
  }

  /**
   * A late revision (a scorer that answered after the echo was drawn): it may
   * ONLY append alternates — never change the target, the mode or the brief
   * of a decision the owner has already seen. After the commit ran, nothing.
   */
  revise(token: string, alternates: readonly Alternate[]): boolean {
    const slot = this.decisions.get(token)
    if (!slot || slot.spent || slot.committing) return false
    const d = slot.decision
    if (d.kind === 'question') return false
    const have = new Set(d.alternates.map((a) => a.id))
    const fresh = alternates.filter((a) => !have.has(a.id))
    if (fresh.length === 0) return false
    const merged = [...d.alternates, ...fresh]
    slot.decision = { ...d, alternates: merged } as Decision
    this.deps.decide?.decisionUpdated?.({ token, alternates: merged })
    this.deps.decide?.ledger?.write({ token, alternates: merged.map((a) => a.id) })
    return true
  }

  /**
   * The box's commit: the decision shown under the token, executed ONCE —
   * on the hold's expiry, on Enter, or after the owner picked the alternate.
   * A token that was spent or that outlived DECISION_TTL_MS is refused, so a
   * stale box cannot send a brief twice.
   */
  async commit(token: string, choice: CommitChoice = {}, caller?: Caller): Promise<SousCommandResult> {
    this.sweepDecisions()
    const slot = this.decisions.get(token)
    if (!slot) return { intent: 'refused', spoken: EXPIRED.en, error: 'expired' }
    // THE TOKEN IS THE CALLER'S. A decision minted for one box is committed
    // or cancelled by that box and no other paired caller.
    if (caller && callerKey(caller.surface, caller.callerId) !== slot.key) return { intent: 'refused', spoken: NOT_YOURS.en, error: 'not-yours' }
    // A second commit while the first is landing is not a stale token: the
    // brief is on its way, and the box is told that rather than "expired".
    if (slot.committing) return { intent: 'refused', spoken: IN_FLIGHT.en, error: 'in-flight' }
    const { decision, key, lang } = slot
    const allowed = decision.kind === 'ask' ? [decision.target.id, ...decision.alternates.map((a) => a.id)] : decision.kind === 'recruit' ? [`harness:${decision.harness}`, ...decision.alternates.map((a) => a.id)] : []
    if (choice.target !== undefined && !allowed.includes(choice.target)) {
      return { intent: 'refused', spoken: NOT_A_CHOICE[lang], error: 'bad-target' }
    }
    // EXPOSURE ≥ 2 IS A DISTINCT ACT: the hold never commits it, Enter does
    // not commit it, and a plain commit is refused — only the SEND ANYWAY
    // control does, and the brief then carries its Boundaries line.
    const tier = decision.exposure ?? 0
    if (tier >= ACK_EXPOSURE && choice.ack !== 'send-anyway') {
      return { intent: 'refused', spoken: NEEDS_ACK[lang], error: 'needs-ack' }
    }
    const brief = tier >= ACK_EXPOSURE && decision.boundaries ? `${decision.sentence}\n\nBoundaries: ${decision.boundaries}` : decision.sentence
    const ledger = this.deps.decide?.ledger
    ledger?.write({ token, ownerResponse: choice.ack === 'send-anyway' ? 'send-anyway' : 'commit', proposalText: brief })
    const roster = this.deps.roster()
    // Marked BEFORE the first await: a cancel that arrives while the brief is
    // on its way answers false — the brief lands, and the box is told so.
    slot.committing = true
    try {
      let result: SousCommandResult
      // The chosen path, which may be the OTHER one: an ask committed with a
      // `harness:` target recruits; a recruit committed with a card id asks.
      const path = chosenPath(decision, choice.target)
      if (path.kind === 'question') {
        result = { intent: 'decide', spoken: decision.kind === 'question' ? decision.question : '' }
      } else if (path.kind === 'ask') {
        const deps = this.deps.decide
        if (!deps) throw new Error('deciding is not wired on this desktop')
        const agent = agentOf(roster, path.agentId)
        await this.moveTo(agent.workspaceId)
        this.deps.ui({ kind: 'zoom', nodeId: agent.id }, agent.workspaceId)
        this.deps.ui({ kind: 'focus-input', nodeId: agent.id }, agent.workspaceId)
        this.focus.set(key, agent.id)
        // Through the dispatch engine, as the owner: the ledger gets a record
        // and the sous row can RETRY from the text the owner saw.
        ledger?.write({ token, deliveredTo: agent.id })
        const delivered = await deps.deliver({ nodeId: agent.id, sentence: brief, originId: null, token })
        ledger?.write({ token, dispatchId: delivered?.dispatchId ?? null, outcome: 'delivered' })
        this.note('prompt', agent.id, agent.name)
        result = { intent: 'ask', spoken: SENT[lang](agent.name), agentId: agent.id, text: brief }
      } else {
        const deps = this.deps.decide
        if (!deps) throw new Error('recruiting is not wired on this desktop')
        // A card recruited by an earlier commit whose delivery failed is
        // reused: the retry delivers to it instead of minting a second one.
        const harness = slot.recruited?.harness ?? path.harness
        const beside = path.beside
        let node = slot.recruited
        if (!node) {
          const made = await deps.recruit({ preset: harness, name: path.name, brief: brief, besideId: beside?.id ?? null, cwd: path.cwd })
          node = { ...made, harness }
          slot.recruited = node
          if (beside) this.deps.connect(beside.id, node.id)
          this.note('recruit', node.id, `${harness} · ${node.name}${beside ? ` ↔ ${beside.name}` : ''}`)
        }
        const workspaceId = this.deps.activeWorkspaceId() ?? ''
        this.deps.ui({ kind: 'zoom', nodeId: node.id }, workspaceId)
        this.focus.set(key, node.id)
        // The sentence goes in through the dispatch engine, which waits for
        // the harness to reach its prompt; "sent" is said only once it has.
        ledger?.write({ token, deliveredTo: node.id })
        const delivered = await deps.deliver({ nodeId: node.id, sentence: brief, originId: beside?.id ?? null, token })
        ledger?.write({ token, dispatchId: delivered?.dispatchId ?? null, outcome: 'delivered' })
        this.note('prompt', node.id, node.name)
        result = { intent: 'create', spoken: RECRUITED[lang](harness, node.name), agentId: node.id, text: brief }
      }
      // Spent only now: a delivery that threw left the token in place, so the
      // same echo can be committed again instead of typing the brief twice.
      slot.spent = true
      this.decisions.delete(token)
      return result
    } catch (error) {
      const what = error instanceof Error ? error.message : String(error)
      console.error(`Sous: commit ${decision.kind} failed:`, error)
      slot.committing = false
      ledger?.write({ token, outcome: 'failed' })
      return { intent: 'refused', spoken: FAILED[lang](what) }
    }
  }

  /**
   * The box closed with the decision uncommitted: the token is dropped and
   * nothing runs. False when the token is not this caller's, was spent, or
   * is committing right now — the brief is landing and cannot be unsent.
   */
  cancel(token: string, caller?: Caller): boolean {
    const slot = this.decisions.get(token)
    if (!slot) {
      // No decision under that token, but the box still closed: whatever Sous
      // was asking THIS caller ("what should I ask Forge?") goes with it.
      if (caller) this.pending.delete(callerKey(caller.surface, caller.callerId))
      return false
    }
    if (caller && callerKey(caller.surface, caller.callerId) !== slot.key) return false
    if (slot.committing) return false
    // The box closed: whatever Sous was still asking this caller goes too —
    // a draft question left pending would answer the NEXT sentence instead.
    this.pending.delete(slot.key)
    this.deps.decide?.ledger?.write({ token, ownerResponse: 'cancel', outcome: 'cancelled' })
    return this.decisions.delete(token)
  }

  /** The commit's decisions spent or alive right now, for a door that wants to know. */
  pendingDecisions(): number {
    this.sweepDecisions()
    return this.decisions.size
  }

  private sweepDecisions(): void {
    const now = this.now()
    for (const [token, slot] of this.decisions) {
      if (slot.until > now) continue
      this.decisions.delete(token)
      if (!slot.spent) this.deps.decide?.ledger?.write({ token, ownerResponse: 'expired', outcome: 'expired' })
    }
  }

  /**
   * Free text into the agent the owner named: cleaned up first when Sous can
   * (thinking-aloud → the sentence they meant), typed-and-left where the
   * owner is looking at the box, submitted where nobody can press Enter.
   */
  private async deliver(
    agent: IntentRoster['agents'][number],
    raw: string,
    surface: Surface,
    lang: Lang,
    spoken: string
  ): Promise<Omit<SousCommandResult, 'intent'>> {
    const cleaned = this.deps.polish ? await this.deps.polish(raw) : { text: raw, polished: false }
    const text = cleaned.text.trim() === '' ? raw : cleaned.text
    const enter = !TYPES_WITHOUT_ENTER.has(surface)
    await this.deps.submit(agent.id, text, { enter })
    this.note(enter ? 'prompt' : 'typed', agent.id, agent.name)
    return {
      spoken: enter ? spoken : IN_THE_BOX[lang](agent.name),
      agentId: agent.id,
      text,
      polished: cleaned.polished
    }
  }

  /** Switch only when not already there — a switch rebuilds PTY clients. */
  private async moveTo(workspaceId: string): Promise<void> {
    if (this.deps.activeWorkspaceId() === workspaceId) return
    await this.deps.switchWorkspace(workspaceId)
  }

  private note(kind: string, subjectId: string | null, detail: string): void {
    this.deps.note?.(kind, subjectId, detail)
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }
}

/** A command whose names all resolved — the thing an alternate ear can beat. */
function isCommandThatResolved(parsed: ReturnType<typeof parseUtterance>): boolean {
  if (!parsed.ok) return parsed.needs === 'which-agent' || parsed.needs === 'which-workspace' || parsed.needs === 'bad-name'
  return parsed.intent.kind !== 'none' && parsed.intent.kind !== 'prompt'
}

/** Where a commit goes: the decision's own path, or the alternate the owner picked — across kinds. */
type ChosenPath = { kind: 'ask'; agentId: string } | { kind: 'recruit'; harness: Harness; name: string; beside: { id: string; name: string } | null; cwd: 'repo' | 'chores' } | { kind: 'question' }

export function chosenPath(decision: Decision, target: string | undefined): ChosenPath {
  if (decision.kind === 'question') return { kind: 'question' }
  if (decision.kind === 'ask') {
    if (target?.startsWith('harness:')) return { kind: 'recruit', ...decision.recruit, harness: target.slice('harness:'.length) as Harness, cwd: 'repo' }
    return { kind: 'ask', agentId: target ?? decision.target.id }
  }
  if (target !== undefined && !target.startsWith('harness:')) return { kind: 'ask', agentId: target }
  const harness = (target ? target.slice('harness:'.length) : decision.harness) as Harness
  return { kind: 'recruit', harness, name: decision.name, beside: decision.beside, cwd: decision.cwd ?? 'repo' }
}

function callerKey(surface: Surface, callerId: string | undefined): string {
  return `${surface}:${callerId ?? ''}`
}

function agentOf(roster: IntentRoster, id: string): IntentRoster['agents'][number] {
  const agent = roster.agents.find((a) => a.id === id)
  // The parser only ever names ids it took from this same roster; a miss here
  // means the roster changed between parse and run, which is a real error.
  if (!agent) throw new Error(`agent ${id} is no longer on the roster`)
  return agent
}

function workspaceName(roster: IntentRoster, id: string): string {
  return roster.workspaces.find((w) => w.id === id)?.name ?? id
}
