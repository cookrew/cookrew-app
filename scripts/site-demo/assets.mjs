// node assets.mjs <dest registry/assets/site> — the site's files from the renders in $SHOOT_DIR (2026-11-17, second round).
// Every frame is CROPPED to its subject from a high-density render (the product's own pixels, never scaled up): the box is
// in the capture's CSS pixels, times its device scale. Each frame is written at its full width (at most 2880) with 1440 and
// 800 twins below that, and, where a phone needs its own framing, a -phone file (at most 1170 wide). The sizes go to
// registry/src/site-frame-sizes.ts, which the pages read; nothing there is typed by hand.
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
const dest = process.argv[2]
if (!dest) throw new Error('usage: assets.mjs <dest>')
mkdirSync(dest, { recursive: true })
const raw = process.env.SHOOT_DIR ?? '/tmp/cookrew-site-demo'
const ff = (args) => execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...args])
const size = (file) => execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file]).toString().trim().split(',').map(Number)
const even = (n) => Math.floor(n / 2) * 2
const sizes = {}

/** A crop of `src` (CSS px box at device scale `dsf`, or the whole file) written as `name` and its twins. */
const cut = (src, box, dsf, out) => {
  const vf = box ? [`crop=${even(box[2] * dsf)}:${even(box[3] * dsf)}:${Math.round(box[0] * dsf)}:${Math.round(box[1] * dsf)}`] : []
  ff(['-i', src, ...(vf.length ? ['-vf', vf[0]] : []), '-update', '1', out])
  return out
}
const jpg = (src, file, width) => ff(['-i', src, '-vf', `scale=${width}:-2:flags=lanczos`, '-q:v', width > 1500 ? '4' : '3', `${dest}/${file}`])
function frame(name, src, { box = null, dsf = 1, max = 2880, phone = null } = {}) {
  const master = cut(src, box, dsf, `${raw}/m-${name}.png`)
  const [mw] = size(master)
  const width = even(Math.min(mw, max))
  jpg(master, `${name}.jpg`, width)
  const twins = [1440, 800].filter((w) => w < width)
  for (const w of twins) jpg(master, `${name}-${w}.jpg`, w)
  const [, height] = size(`${dest}/${name}.jpg`)
  const entry = { width, height, twins }
  if (phone) {
    const pm = cut(phone.src ?? src, phone.box ?? null, phone.dsf ?? dsf, `${raw}/m-${name}-phone.png`)
    const pw = even(Math.min(size(pm)[0], 1170))
    jpg(pm, `${name}-phone.jpg`, pw)
    const [, ph] = size(`${dest}/${name}-phone.jpg`)
    entry.phone = { width: pw, height: ph }
  }
  sizes[`${name}.jpg`] = entry
}

// Desktop stops: 1024×640 at ×6 (walk.mjs prefix h, DSF=6). Boxes frame the subject, not the window.
frame('demo-agents', `${raw}/h-agents.png`, { box: [295, 180, 430, 270], dsf: 6 })
frame('demo-workspaces', `${raw}/h-workspaces.png`, { box: [215, 135, 590, 370], dsf: 6 })
// Docs Site's stop is L-shaped (its header top left, the two faces stacked to the right): the crop is the faces, at ×8 so
// the narrow column is still over 1170 px; the caption names the workspace.
frame('demo-docs-crew', `${raw}/h8-docs.png`, { box: [420, 185, 185, 260], dsf: 8 })
frame('demo-hitl-desk', `${raw}/h-hitl.png`, { box: [0, 60, 700, 520], dsf: 6, phone: { box: [25, 375, 430, 200] } })
frame('demo-artifacts', `${raw}/h-artifacts.png`, { box: [215, 110, 585, 450], dsf: 6, phone: { box: [250, 240, 520, 305] } })
frame('demo-browser-card', `${raw}/h-browser.png`, { box: [60, 50, 910, 540], dsf: 6, phone: { box: [70, 60, 450, 500] } })
frame('demo-board', `${raw}/h-board.png`, { box: [445, 50, 570, 475], dsf: 6, phone: { box: [450, 110, 410, 410] } })
// The devices stop with each machine's screen enlarged under it (devices.mjs); on a phone, the 390 px layout's machines.
frame('demo-devices', `${raw}/devices.png`, { phone: { src: `${raw}/devices-phone.png` } })
// Routing: 1440×900 at ×4, the panel down to the model catalogue; on a phone, the harness rows and the accounts.
frame('demo-routing', `${raw}/h-routing.png`, { box: [185, 15, 1070, 657], dsf: 4, phone: { box: [195, 70, 525, 440] } })
// Phone renders: 390×844 at ×3, each cropped to its subject.
frame('demo-crew-phone', `${raw}/p-crew.png`, { box: [0, 130, 390, 520], dsf: 3 })
frame('demo-hitl-phone', `${raw}/p-card.png`, { dsf: 3 })
frame('demo-phone-workspaces', `${raw}/p-workspaces.png`, { box: [0, 60, 390, 700], dsf: 3 })
// The watch: three 45 mm screens on ink (w45-01 is in the hero); on a phone, two over one (compose.mjs).
ff(['-f', 'lavfi', '-i', 'color=c=0x1D1A16:s=2052x816', '-i', `${raw}/watch/w45-05.png`, '-i', `${raw}/watch/w45-13.png`, '-i', `${raw}/watch/w45-19.png`, '-filter_complex',
  '[0][1]overlay=45:45[a];[a][2]overlay=729:45[b];[b][3]overlay=1413:45', '-frames:v', '1', '-update', '1', `${raw}/watch-strip.png`])
frame('demo-watch', `${raw}/watch-strip.png`, { phone: { src: `${raw}/watch-phone.png` } })
// The composites (compose.mjs).
frame('demo-hero-devices', `${raw}/hero.png`, { phone: { src: `${raw}/hero-phone.png` } })
frame('demo-ops-cards', `${raw}/ops.png`, { phone: { src: `${raw}/ops-phone-stack.png` } })
// The canvas clip (clip.mjs: 2048×1280 frames from a headful Chrome, each step cropped, 1280×800) and its poster: the
// browser card step (14 s), a view no other figure on the canvas page shows. Phones are not shown the clip (a 1024 px movie is
// unreadable at 390, and a still would not be the twenty seconds its caption describes).
copyFileSync(`${raw}/canvas.mp4`, `${dest}/demo-canvas.mp4`)
ff(['-ss', '14', '-i', `${raw}/canvas.mp4`, '-frames:v', '1', '-q:v', '3', `${dest}/demo-canvas.jpg`])
const [cw, ch] = size(`${dest}/demo-canvas.mp4`)
sizes['demo-canvas.mp4'] = { width: cw, height: ch, twins: [] }

const ts = `// GENERATED by scripts/site-demo/assets.mjs from the renders it crops: do not edit.\nexport const FRAME_SIZES: Readonly<Record<string, { width: number; height: number; twins: readonly number[]; phone?: { width: number; height: number } }>> = ${JSON.stringify(sizes, null, 2)}\n`
writeFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'registry', 'src', 'site-frame-sizes.ts'), ts)
console.log('assets written to', dest, Object.keys(sizes).length, 'frames')
