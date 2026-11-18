import { createRoot } from 'react-dom/client'
import App from '../../../../src/renderer/src/App'
import { cookrew } from '../../../../src/renderer/src/api'
// The sheets src/renderer/src/main.tsx loads, in its order: the painter
// measures what they lay out, so a page without them is not the app.
import '../../../../src/renderer/src/styles.css'
import '../../../../src/renderer/src/night.css'
import '../../../../src/renderer/src/zoom/ink-theme.css'
import '../../../../src/renderer/src/zoom/root-theme.css'
import '../../../../src/renderer/src/phone-type.css'
import { AGENTS, seedNodes } from './seed'

/**
 * THE APP, as shipped, with no backend: a plain page gets the in-memory demo
 * api (src/renderer/src/demo-api.ts), so this is the real App, the real zoom
 * view and its real parts — only the workspace is seeded. The render-count
 * gate (tests/perf/render-count.perf.ts) loads it in a headless Chrome behind
 * the React DevTools hook shim and counts what motion and edits render.
 */
interface CensusHooks {
  /** One agent renamed through the api: must reach that agent's node alone. */
  __renameAgent: (id: string, name: string) => Promise<unknown>
  /** Every agent renamed: the canary that every agent's node CAN be seen rendering. */
  __renameAll: (suffix: string) => Promise<unknown>
  /** One note's first line rewritten (what its thumbnail shows): proves ItemNode is a name the counter sees. */
  __editNote: (id: string, firstLine: string) => Promise<unknown>
  /** One agent's preset changed (a face's own prop): proves InkAvatar is seen. */
  __setPreset: (id: string, preset: string) => Promise<unknown>
}

async function boot(): Promise<void> {
  const api = cookrew()
  for (const node of seedNodes()) await api.addNode(node)
  const hooks: CensusHooks = {
    __renameAgent: (id, name) => api.updateNode(id, { name }),
    __renameAll: async (suffix) => {
      for (let i = 0; i < AGENTS; i += 1) await api.updateNode(`agent-${i}`, { name: `Agent ${i} ${suffix}` })
    },
    __editNote: (id, firstLine) => api.updateNode(id, { content: `# ${firstLine}\n\nRewritten by the render census.` }),
    __setPreset: (id, preset) => api.updateNode(id, { preset })
  }
  Object.assign(window, hooks)
  document.body.classList.add('cr-ink')
  createRoot(document.getElementById('root')!).render(<App />)
}

void boot()
