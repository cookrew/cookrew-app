// node clip.mjs <out.mp4> — the canvas clip: real clicks through the renderer on the demo cast, screencast frames
// paced by their arrival time, encoded with ffmpeg. Every beat is the product answering one click.
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tab, sleep } from './cdp.mjs'

const out = process.argv[2] ?? `${process.env.SHOOT_DIR ?? '/tmp/cookrew-site-demo'}/hero.mp4`
const W = 1400, H = 874
const t = await tab()
await t.send('Page.addScriptToEvaluateOnNewDocument', { source: "try { if (!sessionStorage.getItem('walked')) { localStorage.clear(); sessionStorage.setItem('walked', '1') } } catch {}" })
await t.size(W, H, { dsf: 1 })
await t.go('http://127.0.0.1:5397/')
await sleep(5000)

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
const beat = async (label, css, text, hold) => {
  await pointAt(css, text)
  await sleep(350)
  console.log(label, await press(css, text))
  await sleep(hold)
}

const start = Date.now()
await t.send('Page.startScreencast', { format: 'jpeg', quality: 88, maxWidth: W, maxHeight: H, everyNthFrame: 1 })
await sleep(2200)
await beat('agents', '.zv-door.agents', 'Release Room', 2600)
await beat('planner', '.zv-m.waiting .cr-name-text', 'Planner', 3400)
await t.key('Escape'); await sleep(900)
await beat('artifacts', '.zv-group.items .zv-group-stop', null, 2200)
await beat('browser', '.zv-ip .zv-who, .zv-ip', 'Release notes', 3000)
await beat('out', 'button.zv-back', null, 1600)
await beat('workspaces', 'button[aria-label="workspaces"]', null, 2000)
await t.send('Page.stopScreencast')
const end = Date.now()
await t.close()

// One frame per 1/25 s of wall clock: the latest screencast frame at or before that moment.
const dir = out.replace(/\.mp4$/, '-frames')
mkdirSync(dir, { recursive: true })
const fps = 25
let n = 0
for (let at = start; at <= end; at += 1000 / fps) {
  const frame = [...frames].reverse().find((f) => f.at <= at) ?? frames[0]
  if (!frame) continue
  writeFileSync(`${dir}/f${String(n++).padStart(5, '0')}.jpg`, Buffer.from(frame.data, 'base64'))
}
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(fps), '-i', `${dir}/f%05d.jpg`, '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-c:v', 'libx264', '-crf', '24', '-preset', 'slow', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out])
console.log(JSON.stringify({ out, frames: frames.length, written: n, seconds: (end - start) / 1000, errors: t.errors }))
process.exit(0)
