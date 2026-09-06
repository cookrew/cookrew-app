import { createRoot } from 'react-dom/client'
import App from '../../../../src/renderer/src/App'
import { cookrew } from '../../../../src/renderer/src/api'
import '../../../../src/renderer/src/styles.css'
import { seedNodes } from './seed'

/**
 * THE APP, as shipped, with no backend: a plain page gets the in-memory demo
 * api (src/renderer/src/demo-api.ts), so this is the real App, the real
 * ReactFlow and the real card components — only the workspace is seeded.
 * tests/perf/render-count.perf.ts loads this in a headless Chrome behind the
 * React DevTools hook shim and counts what a pan renders.
 */
async function boot(): Promise<void> {
  const api = cookrew()
  for (const node of seedNodes()) await api.addNode(node)
  createRoot(document.getElementById('root')!).render(<App />)
}

void boot()
