import { createRoot } from 'react-dom/client'
import App from '../../../../src/renderer/src/App'
import { cookrew } from '../../../../src/renderer/src/api'
import '../../../../src/renderer/src/styles.css'
import type { CanvasNode } from '../../../../src/shared/model'
// The dump is gitignored (it is a copy of somebody's live board), so a
// checkout without it must still typecheck: CI has no board.json and does
// not build this fixture. The preview script regenerates it from
// GET /api/workspace before it builds.
// @ts-ignore -- resolved locally, absent in CI by design
import board from './board.json'

/**
 * THE REAL APP ON THE REAL BOARD, WITH NO BACKEND — the harness preview.
 *
 * `board.json` is a geometry-only dump of a live workspace (kinds, names,
 * positions, sizes, cables; no note bodies, no tab urls — see the .gitignore,
 * it is generated, not committed). The page seeds it through the in-memory
 * demo api, sets the canvas view to `harness` before App reads the setting,
 * and mounts the shipped App. What renders is the actual CableHarness layer
 * over the actual cards, in a headless Chrome, without touching the app that
 * is serving those cards to the owner.
 */
interface Seed {
  nodes: { kind: CanvasNode['kind']; id: string; name: string; position: { x: number; y: number }; size: { width: number; height: number } }[]
  connections: { id: string; a: string; b: string }[]
}

function asCanvasNode(n: Seed['nodes'][number]): CanvasNode {
  const base = { id: n.id, name: n.name, position: n.position, size: n.size }
  if (n.kind === 'terminal') return { kind: 'terminal', ...base, preset: 'Claude', command: '', cwd: '~', orch: false, role: null }
  if (n.kind === 'note') return { kind: 'note', ...base, customName: n.name, content: `# ${n.name}`, locked: false }
  return { kind: 'browser', ...base, url: 'about:blank' }
}

async function boot(): Promise<void> {
  window.localStorage.setItem('cookrew-canvas-visual-mode', 'harness')
  const api = cookrew()
  const seed = board as Seed
  for (const node of seed.nodes) await api.addNode(asCanvasNode(node))
  for (const c of seed.connections) await api.connectNodes(c.a, c.b)
  createRoot(document.getElementById('root')!).render(<App />)
}

void boot()
