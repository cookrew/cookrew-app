export interface AgentPreset {
  name: string
  command: string
}

/**
 * Agent presets available for terminal creation and `cookrew recruit`.
 * Claude Code runs with bypassed permissions by default — canvas agents are
 * orchestrated headlessly and would otherwise stall on 'waiting' approvals.
 */
export const PRESETS: AgentPreset[] = [
  { name: 'Claude Code', command: 'claude --permission-mode bypassPermissions' },
  { name: 'Codex', command: 'codex' },
  { name: 'OpenCode', command: 'opencode' },
  { name: 'Shell', command: '' }
]
