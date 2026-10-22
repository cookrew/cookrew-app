// The card the embed's overlay renders, from what api/levels/agents/<id>
// answered. Pure, so it is tested without a renderer.
import type { Harness, LevelsAgentDetail } from '../../../shared/strata'
import type { TerminalNodeData } from '../../../shared/model'

/** A detail as the desktop may serve it: the contract's fields, plus the card's node when it sends one. */
export type EmbedDetail = LevelsAgentDetail & { node?: TerminalNodeData }

const PRESET_OF: Record<Harness, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
  pi: 'Pi',
  shell: 'Shell',
  other: 'Shell'
}

export const isDetail = (value: unknown): value is EmbedDetail => {
  if (typeof value !== 'object' || value === null) return false
  const d = value as Partial<LevelsAgentDetail>
  return (
    typeof d.workspaceId === 'string' &&
    typeof d.agent === 'object' &&
    d.agent !== null &&
    typeof d.agent.id === 'string' &&
    Array.isArray(d.notes) &&
    Array.isArray(d.browsers)
  )
}

/** The card the overlay renders: the desktop's own node when sent, else one drawn up from the agent. */
export function nodeOfDetail(detail: EmbedDetail): TerminalNodeData {
  if (detail.node && detail.node.kind === 'terminal' && detail.node.id === detail.agent.id) return detail.node
  const { agent } = detail
  return {
    kind: 'terminal',
    id: agent.id,
    name: agent.name,
    preset: PRESET_OF[agent.harness],
    command: '',
    cwd: '',
    orch: agent.orch,
    role: null,
    brief: null,
    position: { x: 0, y: 0 },
    size: { width: 0, height: 0 }
  }
}
