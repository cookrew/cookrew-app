// node clip.mjs <out.mp4> — the canvas clip: real clicks through the renderer on the demo cast, screencast frames paced by
// their arrival time, each step CROPPED to what it is about (the product's own pixels, never scaled up), encoded with ffmpeg.
//
// A headless Chrome's screencast sends CSS-size frames whatever the device scale; a HEADFUL Chrome on a Retina display
// sends device pixels. So run it against a headful Chrome (its own profile, never the Cookrew app or the user's browser),
// e.g. "Google Chrome" --remote-debugging-port=9335 --user-data-dir=/tmp/cookrew-headful-shoot --no-proxy-server
// "--host-resolver-rules=MAP notes.example 127.0.0.1:5398"
// --window-position=-3000,0 --window-size=1100,760, and CDP_PORT=9335. It stops if the frames are not 2× the layout.
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tab, sleep } from './cdp.mjs'

const out = process.argv[2] ?? `${process.env.SHOOT_DIR ?? '/tmp/cookrew-site-demo'}/canvas.mp4`
// Laid out at 1024×640; the frames 2048×1280; the clip 1280×800, so a 640×400 box is shown 1:1 and a bigger one smaller.
const VW = 1024, VH = 640, K = 2, OW = 1280, OH = 800
const t = await tab(Number(process.env.CDP_PORT ?? 9334))
await t.send('Page.addScriptToEvaluateOnNewDocument', { source: "try { if (!sessionStorage.getItem('walked')) { localStorage.clear(); sessionStorage.setItem('walked', '1') } } catch {}" })
await t.size(VW, VH, { dsf: K })
await t.go('http://127.0.0.1:5397/')
await sleep(4500)

const frames = []
t.on('Page.screencastFrame', (p) => {
  frames.push({ at: Date.now(), data: p.data })
  t.send('Page.screencastFrameAck', { sessionId: p.sessionId }).catch(() => {})
})
const press = (css, text) => t.value(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(css)})].find((e) => ${text ? `(e.textContent || e.getAttribute('aria-label') || '').includes(${JSON.stringify(text)})` : 'true'}); if (!el) return 'missing ' + ${JSON.stringify(css)}; el.click(); return 'ok' })()`)
const pointAt = async (css, text) => {
  const at = await t.value(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(css)})].find((e) => e.getClientRects().length && ${text ? `(e.textContent || e.getAttribute('aria-label') || '').includes(${JSON.stringify(text)})` : 'true'}); if (!el) return null; const b = el.getBoundingClientRect(); return [b.left + b.width / 2, b.top + b.height / 2] })()`)
  if (at) await t.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at[0], y: at[1] })
}
// Each step: where it starts on the clock, and the box (CSS px of the 1024×640 layout, 16:10) the clip shows of it.
const steps = []
const mark = (box) => steps.push({ at: Date.now(), box })
const beat = async (label, css, text, hold, box) => {
  await pointAt(css, text)
  await sleep(350)
  console.log(label, await press(css, text))
  mark(box)
  await sleep(hold)
}
const DEVICES = [32, 20, 960, 600], TILES = [190, 120, 640, 400], CARD = [0, 60, 832, 520], ITEMS = [150, 110, 720, 450], PAGE = [56, 40, 912, 570], BOARD = [190, 40, 832, 520]

// The steps dwell on the dense views (the devices with their gauges, the workspaces, Planner's question, the browser card,
// the BOARD) and pass through a crew and the artifacts only as the way between them.
console.log('devices', await press('button[aria-label="devices"]'))
await sleep(5000) // the gauges answer every 4 s: they are on screen before the first frame
const start = Date.now()
await t.send('Page.startScreencast', { format: 'jpeg', quality: 90, maxWidth: VW * K, maxHeight: VH * K, everyNthFrame: 1 })
mark(DEVICES)
await sleep(2600)
await beat('workspaces', 'button[aria-label="workspaces"]', null, 2200, TILES)
await beat('agents', '.zv-door.agents', 'Release Room', 1100, TILES)
await beat('planner', '.zv-m.waiting .cr-name-text', 'Planner', 3600, CARD)
await t.key('Escape'); await sleep(500)
await beat('artifacts', '.zv-group.items .zv-group-stop', null, 1000, ITEMS)
await beat('browser', '.zv-ip .zv-who, .zv-ip', 'Release notes', 3000, PAGE)
await beat('out', 'button.zv-back', null, 700, ITEMS)
await beat('workspaces', 'button[aria-label="workspaces"]', null, 700, TILES)
await beat('board', '.cr-board-badge', null, 3200, BOARD)
await t.send('Page.stopScreencast')
const end = Date.now()
await t.close()

const first = Buffer.from(frames[0].data, 'base64')
let fw = 0
for (let i = 2; i < first.length; ) { const m = first[i + 1]; const len = first.readUInt16BE(i + 2); if (m >= 0xc0 && m <= 0xc2) { fw = first.readUInt16BE(i + 7); break } i += 2 + len }
if (fw < VW * K) throw new Error(`frames are ${fw} px wide, not ${VW * K}: run against a headful Chrome on a 2× display (see the top of this file)`)

// One frame per 1/25 s of wall clock: the latest screencast frame at or before that moment.
const dir = out.replace(/\.mp4$/, '-frames')
mkdirSync(dir, { recursive: true })
const fps = 25
let n = 0
for (let at = start; at <= end; at += 1000 / fps) {
  const frame = [...frames].reverse().find((f) => f.at <= at) ?? frames[0]
  writeFileSync(`${dir}/f${String(n++).padStart(5, '0')}.jpg`, Buffer.from(frame.data, 'base64'))
}
// Each step's frames cropped to its box and brought to the clip's size (a box is never smaller than 640×400 CSS px).
const sec = (ms) => ((ms - start) / 1000).toFixed(3)
const parts = steps.map((s, i) => {
  const [x, y, w, h] = s.box.map((v) => v * K)
  const to = i + 1 < steps.length ? `:end=${sec(steps[i + 1].at)}` : ''
  return `[0:v]trim=start=${sec(Math.max(s.at, start))}${to},setpts=PTS-STARTPTS,crop=${w}:${h}:${x}:${y},scale=${OW}:${OH}:flags=lanczos,setsar=1[s${i}]`
})
const filter = `${parts.join(';')};${steps.map((_, i) => `[s${i}]`).join('')}concat=n=${steps.length}:v=1:a=0[v]`
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(fps), '-i', `${dir}/f%05d.jpg`, '-filter_complex', filter, '-map', '[v]', '-c:v', 'libx264', '-crf', '22', '-preset', 'slow', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out])
console.log(JSON.stringify({ out, frameWidth: fw, frames: frames.length, written: n, seconds: (end - start) / 1000, steps: steps.map((s) => [sec(s.at), s.box.join('x')]), errors: t.errors }))
process.exit(0)
