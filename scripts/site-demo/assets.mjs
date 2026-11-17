// node assets.mjs <dest registry/assets/site> — the site's files from the raw captures, each at 1400 (or its own
// width for portraits) and an 800 twin, as JPEG; the canvas clip and its poster as they are.
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync } from 'node:fs'
const dest = process.argv[2]
if (!dest) throw new Error('usage: assets.mjs <dest>')
mkdirSync(dest, { recursive: true })
const raw = process.env.SHOOT_DIR ?? '/tmp/cookrew-site-demo'
const ff = (args) => execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...args])
const jpg = (src, name, { crop = null, width = 1400, small = 800 } = {}) => {
  const pre = crop ? `crop=${crop},` : ''
  ff(['-i', src, '-vf', `${pre}scale=${width}:-2:flags=lanczos`, '-q:v', '3', `${dest}/${name}.jpg`])
  ff(['-i', src, '-vf', `${pre}scale=${small}:-2:flags=lanczos`, '-q:v', '4', `${dest}/${name}-800.jpg`])
}
// desktop, 1440×900 at 2× → 1400×875 (walk.mjs prefix d)
jpg(`${raw}/d-devices.png`, 'demo-devices')
jpg(`${raw}/d-workspaces.png`, 'demo-workspaces')
jpg(`${raw}/d-agents.png`, 'demo-agents')
jpg(`${raw}/d-hitl.png`, 'demo-hitl-desk')
jpg(`${raw}/d-artifacts.png`, 'demo-artifacts')
// the browser card as ops.mjs opened it (nothing laid over this one; the page loaded)
jpg(`${raw}/ops-browser.png`, 'demo-browser-card')
// the Routing panel: the panel's top, down to the model catalogue
jpg(`${raw}/r-routing.png`, 'demo-routing', { crop: '2200:1300:340:40' })
// phone, 390×844 at 2× → 700 wide portrait, 400 twin (walk.mjs prefix p)
jpg(`${raw}/p-1-crew.png`, 'demo-crew-phone', { width: 700, small: 400 })
jpg(`${raw}/p-2-card.png`, 'demo-hitl-phone', { width: 700, small: 400 })
// the watch: three 45 mm screens on ink, one strip (Checker's reply, the crew, the devices: w45-19, as 13b shifts the
// numbers after it by one); w45-01 is in the hero
ff(['-f', 'lavfi', '-i', 'color=c=0x1D1A16:s=2052x816', '-i', `${raw}/watch/w45-05.png`, '-i', `${raw}/watch/w45-13.png`, '-i', `${raw}/watch/w45-19.png`, '-filter_complex',
  '[0][1]overlay=45:45[a];[a][2]overlay=729:45[b];[b][3]overlay=1413:45', '-frames:v', '1', `${raw}/watch-strip.png`])
jpg(`${raw}/watch-strip.png`, 'demo-watch')
// the composites (compose.mjs): one question on three devices, and the three operation cards
jpg(`${raw}/hero.png`, 'demo-hero-devices')
jpg(`${raw}/ops.png`, 'demo-ops-cards')
// the canvas clip (clip.mjs) and its poster (the first beat: the workspaces stop)
copyFileSync(`${raw}/canvas.mp4`, `${dest}/demo-canvas.mp4`)
ff(['-ss', '0.6', '-i', `${raw}/canvas.mp4`, '-frames:v', '1', '-q:v', '3', `${dest}/demo-canvas.jpg`])
console.log('assets written to', dest)
