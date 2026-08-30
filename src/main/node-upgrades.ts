import {
  BrowserNodeData,
  CanvasNode,
  CanvasPosition,
  CanvasSize,
  DEFAULT_BROWSER_SIZE,
  DEFAULT_CANVAS_POSITION,
  DEFAULT_NOTE_SIZE,
  DEFAULT_TERMINAL_SIZE,
  TerminalNodeData
} from '../shared/model'
import { DEFAULT_ORCH_PRESET } from './presets'

/**
 * Upgrades persisted nodes saved by older builds to the current shape:
 * - kind 'portal' → 'browser' (portal → browser rename)
 * - terminal field 'maestro' → 'orch' (maestro → orch rename)
 * - the seeded orch "Conductor" from before bypass-by-default was a bare
 *   shell; it now opens the default orch preset (Claude, bypassed
 *   permissions). Custom commands and deliberate shells pass through.
 * - imported-session proxies created before orch-mirror accepted --origin
 *   used shell-style env assignments that Herdr cannot execute directly.
 * - missing/invalid canvas geometry from older or unvalidated API writes gets
 *   usable defaults instead of crashing React Flow or semantic zoom.
 */
export function upgradeNode(node: CanvasNode): CanvasNode {
  let upgraded = node
  if ((node.kind as string) === 'portal') {
    upgraded = { ...(node as unknown as BrowserNodeData), kind: 'browser' }
  }
  upgraded = upgradeGeometry(upgraded)
  if (upgraded.kind !== 'terminal') return upgraded
  return upgradeCrewLineCard(
    upgradeLegacyOrchMirrorCommand(upgradeConductorSeed(upgradeMaestroField(upgraded)))
  )
}

/**
 * A card placed by the retired crew import lane is NEUTRALIZED, not rewired.
 *
 * The temptation was to rebuild it as an orch-line card from the origin, slug
 * and script path in its persisted command. Every one of those is data the
 * REMOTE DOOR supplied (the old lane took the face's name verbatim and never
 * validated the link beyond a parse), and rebuilding a command out of it would
 * execute attacker-influenced strings at app start, with no user action — a
 * worse position than the lane we are reverting. The script path is the
 * sharpest edge: `/tmp/x/crew-line.mjs` would have become `/tmp/x/orch-line.mjs`
 * and been run by node.
 *
 * So the card becomes an ordinary inert shell that keeps its name. Its door is
 * reachable again in one deliberate act — + IMPORT, which validates the
 * address and the face before anything is built. The stale `servedTranscript`
 * key goes in every case: the field left the model with the lane.
 */
function upgradeCrewLineCard(node: TerminalNodeData): TerminalNodeData {
  const persisted = node as TerminalNodeData & { servedTranscript?: unknown }
  const stripped =
    'servedTranscript' in persisted
      ? (({ servedTranscript, ...rest }): TerminalNodeData => {
          void servedTranscript
          return rest as TerminalNodeData
        })(persisted)
      : node
  if (!/[\\/]crew-line\.mjs["']?\s/.test(stripped.command)) return stripped
  return { ...stripped, preset: 'Shell', command: '' }
}

const LEGACY_ORCH_MIRROR_COMMAND =
  /^NODE_TLS_REJECT_UNAUTHORIZED=0 COOKREW_MOBILE_ORIGIN=(\S+) node (\S*[\\/]orch-mirror\.mjs) ([0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}) --name ("(?:[^"\\]|\\.)*")$/

function upgradeLegacyOrchMirrorCommand(node: TerminalNodeData): TerminalNodeData {
  const match = LEGACY_ORCH_MIRROR_COMMAND.exec(node.command)
  if (!match) return node
  const [, origin, script, targetId, quotedName] = match
  return {
    ...node,
    command: `node ${script} ${targetId} --origin ${origin} --name ${quotedName}`
  }
}

function validPosition(value: unknown): value is CanvasPosition {
  const position = value as Partial<CanvasPosition> | null | undefined
  return Number.isFinite(position?.x) && Number.isFinite(position?.y)
}

function validSize(value: unknown): value is CanvasSize {
  const size = value as Partial<CanvasSize> | null | undefined
  return (
    Number.isFinite(size?.width) &&
    Number.isFinite(size?.height) &&
    (size?.width ?? 0) > 0 &&
    (size?.height ?? 0) > 0
  )
}

function defaultSize(node: CanvasNode): CanvasSize {
  if (node.kind === 'terminal') return { ...DEFAULT_TERMINAL_SIZE }
  if (node.kind === 'note') return { ...DEFAULT_NOTE_SIZE }
  return { ...DEFAULT_BROWSER_SIZE }
}

function upgradeGeometry(node: CanvasNode): CanvasNode {
  const persisted = node as CanvasNode & { position?: CanvasPosition; size?: CanvasSize }
  const position = validPosition(persisted.position)
    ? persisted.position
    : { ...DEFAULT_CANVAS_POSITION }
  const size = validSize(persisted.size) ? persisted.size : defaultSize(node)
  if (position === persisted.position && size === persisted.size) return node
  return { ...node, position, size } as CanvasNode
}

function upgradeMaestroField(node: TerminalNodeData): TerminalNodeData {
  if (!('maestro' in node)) return typeof node.orch === 'boolean' ? node : { ...node, orch: false }
  const { maestro, ...rest } = node as TerminalNodeData & { maestro: boolean }
  return { ...rest, orch: rest.orch ?? maestro }
}

function upgradeConductorSeed(node: TerminalNodeData): TerminalNodeData {
  const isLegacySeed =
    node.orch && node.name === 'Conductor' && node.preset === 'Shell' && node.command === ''
  if (!isLegacySeed) return node
  return { ...node, preset: DEFAULT_ORCH_PRESET.name, command: DEFAULT_ORCH_PRESET.command }
}
