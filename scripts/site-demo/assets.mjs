// node assets.mjs <dest registry/assets/site> — the site's files from the renders: the day set in $SHOOT_DIR and the night
// set in $NIGHT_DIR (shoot-all.sh with NIGHT=1). Every frame is CROPPED to its subject from a high-density render (the
// product's own pixels, never scaled up): the box is in the capture's CSS pixels, times its device scale. Each frame is
// written at its full width (at most 2880) with 1440 and 800 twins below that, and, where a phone needs its own framing,
// a -phone file (at most 1170 wide); the night set the same with -night after the name. The sizes go to
// registry/src/site-frame-sizes.ts, which the pages read; nothing there is typed by hand.
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
const dest = process.argv[2]
if (!dest) throw new Error('usage: assets.mjs <dest>')
mkdirSync(dest, { recursive: true })
const DAY = process.env.SHOOT_DIR ?? '/tmp/cookrew-site-demo'
const NIGHT = process.env.NIGHT_DIR
if (!NIGHT) throw new Error('NIGHT_DIR: the night set (shoot-all.sh with NIGHT=1)')
const ff = (args) => execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...args])
const size = (file) => execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file]).toString().trim().split(',').map(Number)
const even = (n) => Math.floor(n / 2) * 2
const sizes = {}

const cut = (src, box, dsf, out) => {
  const vf = box ? [`crop=${even(box[2] * dsf)}:${even(box[3] * dsf)}:${Math.round(box[0] * dsf)}:${Math.round(box[1] * dsf)}`] : []
  ff(['-i', src, ...(vf.length ? ['-vf', vf[0]] : []), '-update', '1', out])
  return out
}
const jpg = (src, file, width) => ff(['-i', src, '-vf', `scale=${width}:-2:flags=lanczos`, '-q:v', width > 1500 ? '4' : '3', `${dest}/${file}`])

/** No night twin: the app's night palette draws a chip in these unreadable (the routing banner's "wired by" chip, the
 *  board's workspace filter; 2026-11-18), so at night the site shows their day render. Drop one when the app is fixed. */
const DAY_ONLY = new Set(['demo-routing', 'demo-board'])

/** Every frame, from one directory; `tail` is '' for the day set and '-night' for the night one. */
function frames(raw, tail) {
  function frame(name, src, { box = null, dsf = 1, max = 2880, phone = null } = {}) {
    if (tail && DAY_ONLY.has(name)) return
    const file = `${name}${tail}`
    const master = cut(src, box, dsf, `${raw}/m-${name}.png`)
    const width = even(Math.min(size(master)[0], max))
    jpg(master, `${file}.jpg`, width)
    const twins = [1440, 800].filter((w) => w < width)
    for (const w of twins) jpg(master, `${file}-${w}.jpg`, w)
    const [, height] = size(`${dest}/${file}.jpg`)
    const entry = { width, height, twins }
    if (phone) {
      const pm = cut(phone.src ?? src, phone.box ?? null, phone.dsf ?? dsf, `${raw}/m-${name}-phone.png`)
      const pw = even(Math.min(size(pm)[0], 1170))
      jpg(pm, `${file}-phone.jpg`, pw)
      entry.phone = { width: pw, height: size(`${dest}/${file}-phone.jpg`)[1] }
    }
    sizes[`${file}.jpg`] = entry
  }
  // Desktop stops: 1024×640 at ×6 (walk.mjs prefix h). Boxes frame the subject, not the window.
  frame('demo-devices', `${raw}/h-devices.png`, { box: [20, 165, 980, 350], dsf: 6, phone: { src: `${raw}/p-devices.png`, box: [0, 150, 390, 590], dsf: 3 } })
  frame('demo-agents', `${raw}/h-agents.png`, { box: [295, 180, 430, 270], dsf: 6 })
  frame('demo-workspaces', `${raw}/h-workspaces.png`, { box: [215, 135, 590, 370], dsf: 6 })
  frame('demo-hitl-desk', `${raw}/h-hitl.png`, { box: [HITL[0], HITL[1], HITL[2], HITL[3]], dsf: 6, phone: { box: HITL_PHONE } })
  frame('demo-artifacts', `${raw}/h-artifacts.png`, { box: [215, 110, 585, 450], dsf: 6, phone: { box: [250, 240, 520, 305] } })
  frame('demo-browser-card', `${raw}/h-browser.png`, { box: [60, 50, 910, 540], dsf: 6, phone: { box: [70, 60, 450, 500] } })
  frame('demo-board', `${raw}/h-board.png`, { box: [445, 50, 570, 475], dsf: 6, phone: { box: [450, 110, 410, 410] } })
  // Docs Site's stop is L-shaped (its header top left, the two faces stacked to the right): the crop is the faces.
  frame('demo-docs-crew', `${raw}/h8-docs.png`, { box: [420, 185, 185, 260], dsf: 8 })
  // Routing: 1440×900 at ×4, the panel down to the model catalogue; on a phone, the harness rows and the accounts.
  frame('demo-routing', `${raw}/h-routing.png`, { box: [185, 15, 1070, 657], dsf: 4, phone: { box: [195, 70, 525, 440] } })
  // Phone renders: 390×844 at ×3, each cropped to its subject.
  frame('demo-crew-phone', `${raw}/p-crew.png`, { box: [0, 130, 390, 520], dsf: 3 })
  frame('demo-hitl-phone', `${raw}/p-card.png`, { dsf: 3 })
  frame('demo-phone-workspaces', `${raw}/p-workspaces.png`, { box: [0, 60, 390, 700], dsf: 3 })
  // The watch: three 45 mm screens on ink (the first is in the hero); on a phone, two over one (compose.mjs).
  const w = tail ? 'w45n-' : 'w45-'
  ff(['-f', 'lavfi', '-i', 'color=c=0x1D1A16:s=2052x816', '-i', `${raw}/watch/${w}05.png`, '-i', `${raw}/watch/${w}13.png`, '-i', `${raw}/watch/${w}19.png`, '-filter_complex',
    '[0][1]overlay=45:45[a];[a][2]overlay=729:45[b];[b][3]overlay=1413:45', '-frames:v', '1', '-update', '1', `${raw}/watch-strip.png`])
  frame('demo-watch', `${raw}/watch-strip.png`, { phone: { src: `${raw}/watch-phone.png` } })
  // The composites (compose.mjs).
  frame('demo-hero-devices', `${raw}/hero.png`, { phone: { src: `${raw}/hero-phone.png` } })
  frame('demo-ops-cards', `${raw}/ops.png`, { phone: { src: `${raw}/ops-phone-stack.png` } })
  // The canvas clip (clip.mjs: 2048×1280 frames from a headful Chrome, each step cropped, 1280×800) and its poster, the
  // browser card step (14 s).
  copyFileSync(`${raw}/canvas.mp4`, `${dest}/demo-canvas${tail}.mp4`)
  ff(['-ss', '14', '-i', `${raw}/canvas.mp4`, '-frames:v', '1', '-q:v', '3', `${dest}/demo-canvas${tail}.jpg`])
  const [cw, ch] = size(`${dest}/demo-canvas${tail}.mp4`)
  sizes[`demo-canvas${tail}.mp4`] = { width: cw, height: ch, twins: [] }
}
// The question opened from the dock at 1024×640 (the card alone no longer shows its rows): the crew above, the question under.
const HITL = [280, 140, 510, 375]
const HITL_PHONE = [438, 288, 334, 218]
frames(DAY, '')
frames(NIGHT, '-night')

const ts = `// GENERATED by scripts/site-demo/assets.mjs from the renders it crops: do not edit.\nexport const FRAME_SIZES: Readonly<Record<string, { width: number; height: number; twins: readonly number[]; phone?: { width: number; height: number } }>> = ${JSON.stringify(sizes, null, 2)}\n`
writeFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'registry', 'src', 'site-frame-sizes.ts'), ts)
console.log('assets written to', dest, Object.keys(sizes).length, 'frames')
