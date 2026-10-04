import { createRoot } from 'react-dom/client'
import App from '../../../../src/renderer/src/App'
import { cookrew } from '../../../../src/renderer/src/api'
import '../../../../src/renderer/src/styles.css'

/**
 * THE REAL APP WITH THE SCREEN WALL WORTH LOOKING AT — a preview fixture.
 *
 * The demo api boots with one workspace and no pictures, which is the one
 * wall that shows nothing. This page makes three more, paints a canvas-like
 * JPEG for two of them, and offers two saved teams, so a headless Chrome can
 * open the wall on a phone-sized viewport and photograph what the owner would
 * see: pictures, ages, the NEW screen, the action strip, the create sheet.
 * Nothing here touches the app that is serving the owner's real cards.
 */
function paintedCanvas(hue: number): string {
  const canvas = document.createElement('canvas')
  canvas.width = 860
  canvas.height = 520
  const g = canvas.getContext('2d')!
  g.fillStyle = '#f3ecd8'
  g.fillRect(0, 0, 860, 520)
  for (let i = 0; i < 6; i++) {
    g.fillStyle = `hsl(${hue + i * 18} 38% 32%)`
    g.fillRect(40 + i * 132, 50 + (i % 2) * 230, 116, 170)
    g.fillStyle = '#f3ecd8'
    g.fillRect(48 + i * 132, 58 + (i % 2) * 230, 100, 14)
  }
  return canvas.toDataURL('image/jpeg', 0.7)
}

async function boot(): Promise<void> {
  const api = cookrew()
  const lab = await api.createWorkspace('Lab', '/Users/me/workspace/lab')
  const voice = await api.createWorkspace('Voice Gateway', '/Users/me/workspace/voice-gateway')
  await api.createWorkspace('Scratch', '/Users/me/scratch')
  await api.switchWorkspace('demo-ws')
  const now = Date.now()
  const shots = {
    'demo-ws': { src: paintedCanvas(30), at: now - 90_000 },
    [lab.id]: { src: paintedCanvas(200), at: now - 5 * 3_600_000 },
  }
  // The demo api answers nothing for these; the preview answers something.
  Object.assign(api, {
    workspaceShots: async () => shots,
    teamList: async () => [
      { name: 'goat team', savedAt: now - 86_400_000, nodeCount: 5, terminalCount: 3 },
      { name: 'solo', savedAt: now - 3 * 86_400_000, nodeCount: 1, terminalCount: 1 },
    ],
  })
  if (new URLSearchParams(location.search).get('phone') === '1') document.body.classList.add('cookrew-mobile')
  createRoot(document.getElementById('root')!).render(<App />)
}

void boot()
