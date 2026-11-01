// The COO in ink, stamped four ways: the app's own icon, and the icons the web build wears in
// a browser tab, on a phone's home screen and in its manifest. Same geometry and brush as the
// site's lockup (scripts/brand-ink/site-brand-ink.mjs, coo-stroke.html version B), so the Dock,
// cookrew.dev and the companion page all carry one mark.
//
//   node scripts/brand-ink/app-icon.mjs
//
// App:   resources/icon.png (1024, rounded tile) + resources/icon.icns.
//        The Dock icon is read at startup (src/main/index.ts · app.dock.setIcon), so the running
//        app picks it up on the next launch; packaged builds bundle the .icns.
// Web:   src/renderer/public/brand/icon.svg, icon-180.png, icon-192.png, icon-512.png and
//        manifest.webmanifest. These are SQUARE and full-bleed on purpose: iOS and Android
//        apply their own mask, so a corner radius baked in would be rounded twice.
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path, { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..', '..')
const sandbox = {}
vm.runInNewContext(readFileSync(join(here, 'ink-marks.js'), 'utf8'), { globalThis: sandbox, window: sandbox })
const I = sandbox.InkMarks

const PAPER = '#f4efe4'
const INK = '#1b1814'
const TILE = 1024
const RADIUS = 229 // the macOS squircle's corner, as a fraction of the 1024 tile

// The mark's own coordinates (240 × 110): the C from 12 o'clock counter-clockwise round the
// left lens, then the glasses in one stroke. Mirrors site-brand-ink.mjs.
const D = Math.PI / 180
const L = { cx: 50, cy: 50, r: 11 }
const R = { cx: 76.5, cy: 50, r: 11 }
const lens = (c, start, turns, r1) => I.arc(c.cx, c.cy, c.r, start, start + Math.PI * 2 * turns, 1.15, 0.6, r1)
const C = I.arc(L.cx, L.cy, 19.5, -90 * D, -300 * D, 1.1, 0.85, 19.5)
const GLASSES = [
  [101, 41.6, 0.35], [96, 40.8, 0.6], [91.2, 44, 0.85],
  ...lens(R, -0.42, 1.55, 10.3),
  [65.4, 47.6, 0.45], [63.25, 44.6, 0.35], [61.1, 47.6, 0.45],
  ...lens(L, 0, -1.04, 10.4)
]
const PEN = { width: 7, nib: 0.12, angle: 0, jitter: 0.05, dry: 0.08 }
const GLASS_PEN = { width: 3.2, nib: 0.5, angle: -0.6, jitter: 0.1, dry: 0.2 }

const tidy = (d) => d.replace(/(\d+\.\d)\d+/g, '$1').replace(/\.0(?=\D)/g, '')
// The mark is drawn ~10× its own size, so the brush is sampled finer than the site's and the
// outline is left clean: the noise filter and the bristle hairlines that give the 430 px lockup
// its tooth turn into a chewed edge on a 1024 px tile.
const brush = (pts, pen) => tidy(I.brushFromLine(I.resample(I.spline(pts), 0.5), pen).body)

/** The mark's box in its own coordinates, so the stamp can be centred without measuring:
 *  the C's outer edge (r 19.5 + a 7-wide brush) to the right lens's (r 11 + 3.2). */
const BOX = { x: 26.8, y: 27, w: 62.4, h: 46 }

/**
 * The COO on a paper square. `rounded` bakes the macOS corner in (the .icns has to carry it);
 * the web icons leave the square square and let the platform mask it.
 */
function stamp({ rounded }) {
  // `GLASSES` opens on a short arm above the right lens — it reads as a whisker at icon
  // size, so the mark is just C and two eyes.
  const strokes = [brush(C, PEN), brush(GLASSES.slice(3), GLASS_PEN)]
  // 76% of the tile: an icon is read at 16 px, so the mark keeps a wide margin.
  const s = (TILE * 0.76) / BOX.w
  const tx = TILE / 2 - (BOX.x + BOX.w / 2) * s
  const ty = TILE / 2 - (BOX.y + BOX.h / 2) * s
  const body = strokes.map((d, i) => `<path id="s${i}" d="${d}"/>`).join('')
  const rect = `<rect x="0" y="0" width="${TILE}" height="${TILE}"${rounded ? ` rx="${RADIUS}"` : ''} fill="${PAPER}"/>`
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${TILE} ${TILE}" width="${TILE}" height="${TILE}">` +
    rect +
    `<g transform="translate(${tx.toFixed(1)} ${ty.toFixed(1)}) scale(${s.toFixed(4)})" fill="${INK}" color="${INK}">${body}</g>` +
    `</svg>`
  )
}

const shell = join(
  homedir(),
  'Library/Caches/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-mac-arm64/chrome-headless-shell'
)
const work = join(tmpdir(), 'cookrew-icon')
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })

/** Render one SVGO string to a PNG at TILE px through the headless shell. */
function render(svg, name) {
  const page = join(work, `${name}.html`)
  writeFileSync(page, `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;padding:0;background:transparent}svg{display:block}</style>${svg}`)
  const png = join(work, `${name}.png`)
  execFileSync(
    shell,
    [
      '--no-sandbox',
      '--single-process',
      '--disable-gpu',
      '--hide-scrollbars',
      '--default-background-color=00000000',
      `--window-size=${TILE},${TILE}`,
      `--screenshot=${png}`,
      `file://${page}`
    ],
    { stdio: 'ignore', timeout: 60000 }
  )
  return png
}

const appOut = join(root, 'resources')
const tile = render(stamp({ rounded: true }), 'app')
execFileSync('sips', ['-s', 'format', 'png', tile, '--out', join(appOut, 'icon.png')], { stdio: 'ignore' })

// The .icns, packed here rather than by iconutil: iconutil refuses every iconset on this
// machine (even one built from the previous icon), so the container is written directly —
// a header, then one PNG per slot with the type Apple assigns it.
const slots = [
  ['icp4', 16],
  ['icp5', 32],
  ['ic12', 64],
  ['ic07', 128],
  ['ic08', 256],
  ['ic09', 512],
  ['ic10', 1024]
]
const chunks = slots.map(([type, px]) => {
  const file = join(work, `icon-${px}.png`)
  execFileSync('sips', ['-s', 'format', 'png', '-Z', String(px), join(appOut, 'icon.png'), '--out', file], { stdio: 'ignore' })
  const data = readFileSync(file)
  const head = Buffer.alloc(8)
  head.write(type, 0, 'ascii')
  head.writeUInt32BE(data.length + 8, 4)
  return Buffer.concat([head, data])
})
const total = 8 + chunks.reduce((n, chunk) => n + chunk.length, 0)
const header = Buffer.alloc(8)
header.write('icns', 0, 'ascii')
header.writeUInt32BE(total, 4)
writeFileSync(join(appOut, 'icon.icns'), Buffer.concat([header, ...chunks]))

const webOut = join(root, 'src', 'renderer', 'public', 'brand')
mkdirSync(webOut, { recursive: true })
writeFileSync(join(webOut, 'icon.svg'), stamp({ rounded: false }) + '\n')
const square = render(stamp({ rounded: false }), 'web')
for (const [px, name] of [[512, 'icon-512.png'], [192, 'icon-192.png'], [180, 'icon-180.png']]) {
  execFileSync('sips', ['-s', 'format', 'png', '-Z', String(px), square, '--out', join(webOut, name)], { stdio: 'ignore' })
}
const manifest = {
  name: 'Cookrew',
  short_name: 'Cookrew',
  description: 'A spatial workspace for a team of AI coding agents.',
  start_url: '/',
  scope: '/',
  display: 'standalone',
  background_color: PAPER,
  theme_color: PAPER,
  icons: [
    { src: '/brand/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: '/brand/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' }
  ]
}
writeFileSync(join(webOut, 'manifest.webmanifest'), JSON.stringify(manifest, null, 2) + '\n')

console.log('wrote resources/icon.{png,icns} and src/renderer/public/brand/{icon.svg,icon-180,192,512.png,manifest.webmanifest}')
