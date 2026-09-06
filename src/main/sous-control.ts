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
  /** Resolves when the prompt is SUBMITTED; the reply is the ledger's business. */
  submit: (agentId: string, text: string) => Promise<void>
  ui: (command: UiCommand, workspaceId: string) => void
  /** One ledger line per executed intent, so a misheard rename has a trail. */
  note?: (kind: string, subjectId: string | null, detail: string) => void
  now?: () => number
}

export interface SousCommandInput {
  text: string
  surface: Surface
  /** In the zoom view, the agent on screen. */
  focusedAgentId?: string | null
}

export interface SousCommandResult {
  intent: SousIntent['kind'] | 'refused'
  spoken: string
  needs?: 'prompt' | Refusal
  choices?: string[]
  /** The agent the sentence ended up about, when there is one. */
  agentId?: string
}

const FAILED = {
  zh: (what: string) => `没做成：${what}`,
  en: (what: string) => `That did not work: ${what}`
} as const

export class SousController {
  /**
   * "需要问 Conductor 什么呢？" — asked on one surface, answered on the same
   * one. Keyed by surface so the phone and the speaker never complete each
   * other's questions.
   */
  private readonly pending = new Map<Surface, PendingPrompt>()

  constructor(private readonly deps: SousControlDeps) {}

  /** What Sous is still waiting on for a surface, if anything unexpired. */
  pendingFor(surface: Surface): PendingPrompt | null {
    const slot = this.pending.get(surface)
    if (!slot) return null
    if (slot.until <= this.now()) {
      this.pending.delete(surface)
      return null
    }
    return slot
  }

  async handle(input: SousCommandInput): Promise<SousCommandResult> {
    const roster = this.deps.roster()
    const parsed = parseUtterance(
      input.text,
      {
        surface: input.surface,
        activeWorkspaceId: this.deps.activeWorkspaceId(),
        focusedAgentId: input.focusedAgentId ?? null,
        pending: this.pendingFor(input.surface)
      },
      roster,
      this.now()
    )
    if (!parsed.ok) {
      return {
        intent: 'refused',
        spoken: parsed.spoken,
        needs: parsed.needs,
        ...(parsed.choices ? { choices: parsed.choices } : {})
      }
    }
    try {
      return await this.run(parsed.intent, parsed.spoken, input.surface, roster)
    } catch (error) {
      const what = error instanceof Error ? error.message : String(error)
      console.error(`Sous: ${parsed.intent.kind} failed:`, error)
      return { intent: 'refused', spoken: FAILED[parsed.lang](what) }
    }
  }

  private async run(
    intent: SousIntent,
    spoken: string,
    surface: Surface,
    roster: IntentRoster
  ): Promise<SousCommandResult> {
    const active = this.deps.activeWorkspaceId()
    switch (intent.kind) {
      case 'none':
        return { intent: 'none', spoken: '' }
      case 'back':
        if (active) this.deps.ui({ kind: 'zoom-back' }, active)
        return { intent: 'back', spoken }
      case 'open':
        if (active) this.deps.ui({ kind: 'zoom-back' }, active)
        this.note('open', null, 'cookrew')
        return { intent: 'open', spoken }
      case 'switch': {
        await this.moveTo(intent.workspaceId)
        this.deps.ui({ kind: 'zoom-back' }, intent.workspaceId)
        this.note('switch', intent.workspaceId, workspaceName(roster, intent.workspaceId))
        return { intent: 'switch', spoken }
      }
      case 'ask': {
        const agent = agentOf(roster, intent.agentId)
        await this.moveTo(agent.workspaceId)
        this.deps.ui({ kind: 'zoom', nodeId: agent.id }, agent.workspaceId)
        this.deps.ui({ kind: 'focus-input', nodeId: agent.id }, agent.workspaceId)
        if (intent.prompt === null) {
          this.pending.set(surface, { kind: 'prompt', agentId: agent.id, until: this.now() + PENDING_PROMPT_MS })
          this.note('ask', agent.id, agent.name)
          return { intent: 'ask', spoken, needs: 'prompt', agentId: agent.id }
        }
        this.pending.delete(surface)
        await this.deps.submit(agent.id, intent.prompt)
        this.note('prompt', agent.id, agent.name)
        return { intent: 'ask', spoken, agentId: agent.id }
      }
      case 'prompt': {
        const agent = agentOf(roster, intent.agentId)
        this.pending.delete(surface)
        await this.deps.submit(agent.id, intent.text)
        this.note('prompt', agent.id, agent.name)
        return { intent: 'prompt', spoken, agentId: agent.id }
      }
      case 'create': {
        const target = intent.workspaceId ?? active
        if (target) await this.moveTo(target)
        const node = this.deps.createTerminal({ preset: intent.preset, name: intent.preset })
        if (intent.browser) await this.deps.createBrowser(node.id, `${node.name} browser`)
        const workspaceId = this.deps.activeWorkspaceId() ?? target ?? ''
        this.deps.ui({ kind: 'zoom', nodeId: node.id }, workspaceId)
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
