import { BrowserNodeData, CanvasNode, TerminalNodeData } from '../shared/model'
import { DEFAULT_ORCH_PRESET } from './presets'

/**
 * Upgrades persisted nodes saved by older builds to the current shape:
 * - kind 'portal' → 'browser' (portal → browser rename)
 * - terminal field 'maestro' → 'orch' (maestro → orch rename)
 * - the seeded orch "Conductor" from before bypass-by-default was a bare
 *   shell; it now opens the default orch preset (Claude, bypassed
 *   permissions). Custom commands and deliberate shells pass through.
 */
export function upgradeNode(node: CanvasNode): CanvasNode {
  if ((node.kind as string) === 'portal') {
    return { ...(node as unknown as BrowserNodeData), kind: 'browser' }
  }
  if (node.kind !== 'terminal') return node
  return upgradeConductorSeed(upgradeMaestroField(node))
}

function upgradeMaestroField(node: TerminalNodeData): TerminalNodeData {
  if (!('maestro' in node)) return node
  const { maestro, ...rest } = node as TerminalNodeData & { maestro: boolean }
  return { ...rest, orch: rest.orch ?? maestro }
}

function upgradeConductorSeed(node: TerminalNodeData): TerminalNodeData {
  const isLegacySeed =
    node.orch && node.name === 'Conductor' && node.preset === 'Shell' && node.command === ''
  if (!isLegacySeed) return node
  return { ...node, preset: DEFAULT_ORCH_PRESET.name, command: DEFAULT_ORCH_PRESET.command }
}
