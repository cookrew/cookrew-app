// node assets.mjs <dest registry/assets/site> — the site's files from the raw captures, each at 1400 (or its own
// width for portraits) and an 800 twin, as JPEG; the hero clip and its poster as they are.
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
// desktop, 1440×900 at 2× → 1400×875
jpg(`${raw}/d-1-agents.png`, 'demo-devices')
jpg(`${raw}/d-0-workspaces.png`, 'demo-workspaces')
jpg(`${raw}/d-3-agents.png`, 'demo-agents')
jpg(`${raw}/d-4-card.png`, 'demo-hitl-desk')
jpg(`${raw}/a-1-artifacts.png`, 'demo-artifacts')
jpg(`${raw}/o-1-peek.png`, 'demo-browser-card')
// the Routing panel: the panel's top, without the rows below the catalogue
jpg(`${raw}/r-2-routing.png`, 'demo-routing', { crop: '2200:1300:340:40' })
// phone, 390×844 at 2× → 700 wide portrait, 400 twin
jpg(`${raw}/p-1-crew.png`, 'demo-crew-phone', { width: 700, small: 400 })
jpg(`${raw}/p-2-card.png`, 'demo-hitl-phone', { width: 700, small: 400 })
// the watch: three 45 mm screens on paper, one strip
ff(['-f', 'lavfi', '-i', 'color=c=0x1D1A16:s=2052x816', '-i', `${raw}/watch/w45-01.png`, '-i', `${raw}/watch/w45-02.png`, '-i', `${raw}/watch/w45-13.png`, '-filter_complex',
  '[0][1]overlay=45:45[a];[a][2]overlay=729:45[b];[b][3]overlay=1413:45', '-frames:v', '1', `${raw}/watch-strip.png`])
jpg(`${raw}/watch-strip.png`, 'demo-watch')
// the hero clip and its poster (the first beat: the workspaces stop)
copyFileSync(`${raw}/hero.mp4`, `${dest}/demo-hero.mp4`)
ff(['-ss', '0.6', '-i', `${raw}/hero.mp4`, '-frames:v', '1', '-q:v', '3', `${dest}/demo-hero.jpg`])
ff(['-ss', '0.6', '-i', `${raw}/hero.mp4`, '-frames:v', '1', '-vf', 'scale=800:-2', '-q:v', '4', `${dest}/demo-hero-800.jpg`])
console.log('assets written to', dest)
