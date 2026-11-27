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
  { name: 'Pi', command: 'pi' },
  // accept-edits: edits run, shell commands ask. agy's default Auto mode ran
  // `rm` unasked in the 2026-11-26 capture; the owner can choose otherwise.
  { name: 'Antigravity CLI', command: 'agy --mode accept-edits' },
  // Devin's default `auto` permission mode runs read-only tools and asks before writes and commands.
  { name: 'Devin', command: 'devin' },
  // Its default sandbox writes inside the folder and asks for anything past it.
  { name: 'DeepSeek Harness', command: 'cookrew-acp dsh' },
  { name: 'Shell', command: '' }
]

/**
 * Preset the seeded orch terminal ("Conductor") opens with. Bypass-permission
 * Claude Code for now; meant to become a user setting once Cookrew grows a
 * settings surface.
 */
export const DEFAULT_ORCH_PRESET: AgentPreset = PRESETS[0]
