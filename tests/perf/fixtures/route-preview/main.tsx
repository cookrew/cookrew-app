import { createRoot } from 'react-dom/client'
import App from '../../../../src/renderer/src/App'
import { cookrew } from '../../../../src/renderer/src/api'
import '../../../../src/renderer/src/styles.css'

/**
 * THE REAL APP WITH THE ROUTING PANEL WORTH LOOKING AT — a preview fixture.
 *
 * The demo api answers the route fixture (shared/route-fixture.ts) and lets
 * the page flip it between absent / offline / online through
 * `window.__routeStatus`, so a headless Chrome can open the panel in each
 * state and photograph it. Three agent cards are seeded so the live routes
 * carry names and a zoomed card shows the RTE dial. Nothing here touches the
 * app that is serving the owner's real cards.
 */
async function boot(): Promise<void> {
  const api = cookrew()
  let x = 0
  for (const name of ['Forge', 'Tinker', 'Orch']) {
    const created = await api.createTerminal({ name, preset: 'Claude Code', position: { x, y: 620 }, orch: name === 'Orch' })
    // The fixture's live rows name cards by these ids.
    await api.updateNode(created.id, { name })
    x += 700
  }
  // The demo api has no tuning record, and the rail only draws when there is
  // one; the preview answers a plausible record so the RTE dial has MDL and
  // EFF beside it, exactly as on a real card.
  Object.assign(api, {
    terminalTuning: async () => ({
      harness: 'claude',
      knobs: ['model', 'effort'],
      records: ['model', 'effort'],
      tuning: { model: 'claude-opus-5', effort: 'high', at: Date.now() - 60_000 },
      asks: [],
      caveat: null,
      choices: { route: ['direct', 'group/smart', 'group/opus-anywhere', 'claude/claude-opus-5-5', 'claude/claude-sonnet-5', 'codex/gpt-5.5', 'deepseek/deepseek-v4', 'deepseek/deepseek-v4-flash', 'ollama/qwen3:32b'] }
    }),
    onTerminalTuning: () => () => undefined,
    tuneTerminal: async () => ({ ok: true })
  })
  // What the buttons typed, for the click test: every byte that reached a
  // PTY, by card, and whether the Setup screen holds the keyboard focus.
  const typed: { terminalId: string; data: string }[] = []
  const realInput = api.ptyInput.bind(api)
  Object.assign(api, {
    ptyInput: (terminalId: string, data: string) => {
      typed.push({ terminalId, data })
      realInput(terminalId, data)
    }
  })
  Object.assign(window, {
    __typed: () => typed,
    __setupFocused: () => document.activeElement !== null && document.activeElement.closest('.cr-routing-screen') !== null
  })
  if (new URLSearchParams(location.search).get('phone') === '1') document.body.classList.add('cookrew-mobile')
  createRoot(document.getElementById('root')!).render(<App />)
}

void boot()
