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
import { rankHearings, vocabularyOf } from '../shared/sous-hearing'
import type { UiCommand } from '../shared/sous-ui'
import { DECISION_HOLD_MS, DECISION_TTL_MS, decide, type DecideCandidate, type DecisionDraft, type Harness } from '../shared/sous-decide'

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
    /** A new card in the ACTIVE workspace, placed beside `besideId` (sous-decide placeBeside), wired to it, role = the brief. */
    recruit: (input: { preset: Harness; name: string; role: string; besideId: string | null }) => Promise<{ id: string; name: string }> | { id: string; name: string }
    /** Mint the token a decision travels under. */
    token?: () => string
  }
}

/** A draft decision stamped for the box: the token to commit it under, how long to hold. */
export type Decision = DecisionDraft & { token: string; holdMs: number; sentence: string }

/** What `commit` may change: the ask's target, or the recruit's harness. */
export interface CommitChoice {
  /** For `ask`: another candidate's id. For `recruit`: `harness:<name>`. */
  target?: string
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

const EXPIRED = { en: 'That decision expired — say it again.', zh: '这个决定已过期，再说一次。' } as const
const SENT = {
  zh: (agent: string) => `已派给 ${agent}`,
  en: (agent: string) => `Sent to ${agent}`
} as const
const RECRUITED = {
  zh: (harness: string, name: string) => `新建了 ${harness} 卡「${name}」`,
  en: (harness: string, name: string) => `New ${harness} card · ${name}`
} as const

/** The line under the box: who, and the three reasons — or the question back. */
export function echoOf(decision: Decision, lang: Lang): string {
  if (decision.kind === 'ask') return `→ ${decision.target.name} (${decision.reasons.join(' · ')})`
  if (decision.kind === 'recruit') return `+ ${decision.harness} card · ${decision.name} (${decision.reasons.join(' · ')})`
  return lang === 'zh' ? decision.question : decision.question
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
  private readonly decisions = new Map<string, { decision: Decision; surface: Surface; key: string; lang: Lang; until: number }>()

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
    // THE DECIDE STEP: not a command the core knows, not dictation into a
    // zoomed terminal, and a sentence rather than a word — Sous picks who.
    if (parsed.intent.kind === 'none' && this.deps.decide && input.surface !== 'zoom' && input.text.trim().length > 0) {
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
    const draft = decide(sentence, { candidates: await deps.candidates(), workdir: deps.workdir(), now: this.now() })
    const token = deps.token?.() ?? `d-${this.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    const decision: Decision = { ...draft, token, holdMs: DECISION_HOLD_MS, sentence }
    this.sweepDecisions()
    // A question is answered in the box and creates nothing — there is nothing to commit.
    if (draft.kind !== 'question') this.decisions.set(token, { decision, surface, key, lang, until: this.now() + DECISION_TTL_MS })
    this.note('decide', draft.kind === 'ask' ? draft.target.id : null, `${draft.kind}: ${draft.reasons.join(' · ')}`)
    return { intent: 'decide', spoken: echoOf(decision, lang), decision }
  }

  /**
   * The box's commit: the decision shown under the token, executed ONCE —
   * on the hold's expiry, on Enter, or after the owner picked the alternate.
   * A token that was spent or that outlived DECISION_TTL_MS is refused, so a
   * stale box cannot send a brief twice.
   */
  async commit(token: string, choice: CommitChoice = {}): Promise<SousCommandResult> {
    this.sweepDecisions()
    const slot = this.decisions.get(token)
    if (!slot) return { intent: 'refused', spoken: EXPIRED.en }
    this.decisions.delete(token)
    const { decision, key, lang } = slot
    const roster = this.deps.roster()
    try {
      if (decision.kind === 'ask') {
        const targetId = choice.target ?? decision.target.id
        const agent = agentOf(roster, targetId)
        await this.moveTo(agent.workspaceId)
        this.deps.ui({ kind: 'zoom', nodeId: agent.id }, agent.workspaceId)
        this.deps.ui({ kind: 'focus-input', nodeId: agent.id }, agent.workspaceId)
        this.focus.set(key, agent.id)
        // Committed from the box: the owner has read the sentence already, so it goes in and is sent.
        const sent = await this.deliver(agent, decision.sentence, 'canvas', lang, SENT[lang](agent.name))
        return { intent: 'ask', ...sent, spoken: SENT[lang](agent.name) }
      }
      if (decision.kind === 'recruit') {
        const deps = this.deps.decide
        if (!deps) throw new Error('recruiting is not wired on this desktop')
        const harness = (choice.target?.startsWith('harness:') ? choice.target.slice('harness:'.length) : decision.harness) as Harness
        const node = await deps.recruit({ preset: harness, name: decision.name, role: decision.sentence, besideId: decision.beside?.id ?? null })
        if (decision.beside) this.deps.connect(decision.beside.id, node.id)
        const workspaceId = this.deps.activeWorkspaceId() ?? ''
        this.deps.ui({ kind: 'zoom', nodeId: node.id }, workspaceId)
        this.focus.set(key, node.id)
        this.note('recruit', node.id, `${harness} · ${node.name}${decision.beside ? ` ↔ ${decision.beside.name}` : ''}`)
        return { intent: 'create', spoken: RECRUITED[lang](harness, node.name), agentId: node.id, text: decision.sentence }
      }
      return { intent: 'decide', spoken: decision.question }
    } catch (error) {
      const what = error instanceof Error ? error.message : String(error)
      console.error(`Sous: commit ${decision.kind} failed:`, error)
      return { intent: 'refused', spoken: FAILED[lang](what) }
    }
  }

  private sweepDecisions(): void {
    const now = this.now()
    for (const [token, slot] of this.decisions) if (slot.until <= now) this.decisions.delete(token)
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
