import { createRoot } from 'react-dom/client'
import App from '../../../../src/renderer/src/App'
import { cookrew } from '../../../../src/renderer/src/api'
import { activityStore } from '../../../../src/renderer/src/activity-thumb-store'
import { tuningStore } from '../../../../src/renderer/src/tuning-store'
import '../../../../src/renderer/src/styles.css'
import type { CanvasNode } from '../../../../src/shared/model'
import type { TerminalActivity, TurnPhase } from '../../../../src/shared/turn'
import type { AgentTuning } from '../../../../src/shared/agent-tuning'
// The dump is gitignored (it is a copy of somebody's live board), so a
// checkout without it must still typecheck: CI has no board.json and does
// not build this fixture. The preview script regenerates it before it builds.
// @ts-ignore -- resolved locally, absent in CI by design
import board from './board.json'

/**
 * THE ANATOMY CANVAS ON THE REAL BOARD, WITH NO BACKEND.
 *
 * Same trick as harness-preview: a geometry-only dump of a live workspace
 * (kinds, names, presets, cables — no note bodies, no tab urls) seeded through
 * the in-memory demo api, then the shipped App mounted with the canvas view
 * already set to `anatomy`. Phases and model tags are seeded straight into
 * their stores, because those arrive over a bridge this page does not have,
 * and the status lens and the "opus high" tag are two of the things worth
 * looking at.
 *
 * `?container=room|board|bench` and `?orient=portrait|landscape` drive the two
 * choices the view persists, so the shooter can photograph each without
 * clicking through.
 */
interface Seed {
  nodes: {
    kind: CanvasNode['kind']
    id: string
    name: string
    preset?: string
    position: { x: number; y: number }
    size: { width: number; height: number }
  }[]
  connections: { id: string; a: string; b: string }[]
}

function asCanvasNode(n: Seed['nodes'][number]): CanvasNode {
  const base = { id: n.id, name: n.name, position: n.position, size: n.size }
  if (n.kind === 'terminal')
    return {
      kind: 'terminal',
      ...base,
      preset: n.preset ?? 'Claude Code',
      command: '',
      cwd: '~',
      orch: false,
      role: null
    }
  if (n.kind === 'note')
    return { kind: 'note', ...base, customName: n.name, content: `# ${n.name}`, locked: false }
  return { kind: 'browser', ...base, url: 'about:blank' }
}

const PHASES: TurnPhase[] = ['idle', 'thinking', 'waiting', 'replied']
const MODELS: Array<[string, string]> = [
  ['opus', 'high'],
  ['sonnet', 'medium'],
  ['gpt-5.6', 'xhigh'],
  ['qwen3', 'low']
]

function seedLive(terminals: Seed['nodes']): void {
  activityStore.seed(
    terminals.map((node, i) => {
      // Partial + cast, the same shape every activity fixture in tests/ uses:
      // the view reads `phase` and nothing else off this.
      const activity = {
        terminalId: node.id,
        agent: true,
        // A spread of phases on purpose: the lens colours are the point.
        phase: PHASES[i % PHASES.length],
        prompt: null,
        pendingInput: null,
        lines: [],
        reply: null,
        glance: null,
        title: node.name,
        turnCount: 1
      } as unknown as TerminalActivity
      return [node.id, activity] as [string, TerminalActivity]
    })
  )
  tuningStore.seed(
    terminals.map((node, i) => {
      const [model, effort] = MODELS[i % MODELS.length]
      const tuning: AgentTuning = { model, effort, at: Date.now() }
      return [node.id, tuning] as [string, AgentTuning]
    })
  )
}

async function boot(): Promise<void> {
  const params = new URLSearchParams(window.location.search)
  window.localStorage.setItem('cookrew-canvas-visual-mode', 'anatomy')
  window.localStorage.setItem('cookrew-anatomy-container', params.get('container') ?? 'bench')
  const orient = params.get('orient')
  if (orient === 'portrait' || orient === 'landscape') {
    window.localStorage.setItem('cookrew-anatomy-orientation', orient)
  } else {
    window.localStorage.removeItem('cookrew-anatomy-orientation')
  }
  const api = cookrew()
  const seed = board as Seed
  for (const node of seed.nodes) await api.addNode(asCanvasNode(node))
  for (const c of seed.connections) await api.connectNodes(c.a, c.b)
  seedLive(seed.nodes.filter((n) => n.kind === 'terminal'))
  createRoot(document.getElementById('root')!).render(<App />)
}

void boot()
