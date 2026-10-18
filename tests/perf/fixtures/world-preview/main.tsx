import { createRoot } from 'react-dom/client'
import App from '../../../../src/renderer/src/App'
import { cookrew } from '../../../../src/renderer/src/api'
import '../../../../src/renderer/src/styles.css'
import type { CanvasNode } from '../../../../src/shared/model'
// Generated from the workspaces on disk and gitignored, like harness-preview's
// board.json: it is a copy of somebody's real fleet. CI never builds this.
// @ts-ignore -- resolved locally, absent in CI by design
import world from './world.json'

/**
 * THE WORLD VIEW ON THE REAL FLEET, WITH NO BACKEND.
 *
 * The demo api has no board (it is a single-workspace toy), so the two reads
 * the world depends on are patched onto it: `listBoard` and `listWorkspaces`.
 * Everything else — the scene, the camera, the picking, the panel — is the
 * shipped code, running in a headless Chrome, nowhere near the app that is
 * serving these agents to the owner.
 */
interface Seed {
  rows: unknown[]
  workspaces: { id: string; name: string; icon: string; dir: string; dirs: string[] }[]
  activeId: string
  /** The active workspace's cards, so an agent's equipment is real. */
  nodes: { kind: CanvasNode['kind']; id: string; name: string }[]
  connections: { id: string; a: string; b: string }[]
}

const seed = world as Seed

function asCanvasNode(n: Seed['nodes'][number], i: number): CanvasNode {
  const base = {
    id: n.id,
    name: n.name,
    position: { x: (i % 12) * 340, y: Math.floor(i / 12) * 260 },
    size: { width: 320, height: 220 }
  }
  if (n.kind === 'terminal')
    return { kind: 'terminal', ...base, preset: 'Claude Code', command: '', cwd: '~', orch: false, role: null }
  if (n.kind === 'note')
    return { kind: 'note', ...base, customName: n.name, content: `# ${n.name}`, locked: false }
  return { kind: 'browser', ...base, url: 'about:blank' }
}

async function boot(): Promise<void> {
  const api = cookrew() as unknown as Record<string, unknown>
  api.listBoard = () =>
    Promise.resolve({
      rows: seed.rows,
      summary: { waiting: 0, working: 0, total: seed.rows.length },
      activeWorkspaceId: seed.activeId
    })
  api.listWorkspaces = () => Promise.resolve({ workspaces: seed.workspaces, activeId: seed.activeId })

  const real = cookrew()
  for (const [i, node] of seed.nodes.entries()) await real.addNode(asCanvasNode(node, i))
  for (const c of seed.connections) await real.connectNodes(c.a, c.b)
  createRoot(document.getElementById('root')!).render(<App />)
}

void boot()
