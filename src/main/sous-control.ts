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
import type { UiCommand } from '../shared/sous-ui'

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
}

export interface SousCommandInput {
  text: string
  /**
   * What the other ears heard of the same audio. Tried, in order, when the
   * primary sentence is not a command or names someone the roster does not
   * have — the zh-CN ear's 双球 is the en-US ear's Conductor. Never used for
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
  intent: SousIntent['kind'] | 'refused'
  spoken: string
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

export class SousController {
  /**
   * "需要问 Conductor 什么呢？" — asked by one caller on one surface, answered
   * by the same one. Keyed by both, so two phones, or the phone and the
   * speaker, never complete each other's questions.
   */
  private readonly pending = new Map<string, PendingPrompt>()
  /** Where Sous last zoomed each caller — the only focus a network door gets. */
  private readonly focus = new Map<string, string>()

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
    if (!isCommandThatResolved(parsed)) {
      for (const alternate of input.alternates ?? []) {
        const other = parseUtterance(alternate, ctx, roster, now)
        if (isCommandThatResolved(other)) {
          parsed = other
          break
        }
      }
    }
    if (!parsed.ok) {
      return {
        intent: 'refused',
        spoken: parsed.spoken,
        needs: parsed.needs,
        ...(parsed.choices ? { choices: parsed.choices } : {})
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
