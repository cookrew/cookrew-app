// The Co in ink (scheme 7 of coo-logo-schemes.html, the owner's pick for every icon on
// 2026-11-05: the C round ONE lens), stamped for the app, for the web build's tab, home screen
// and manifest, and for the watch. Same C and lens as the site's lockup
// (scripts/brand-ink/site-brand-ink.mjs), so the Dock, cookrew.dev and the companion page agree.
//
//   node scripts/brand-ink/app-icon.mjs
//
// App:   resources/icon.png (1024, rounded tile) + resources/icon.icns.
//        The Dock icon is read at startup (src/main/index.ts · app.dock.setIcon), so the running
//        app picks it up on the next launch; packaged builds bundle the .icns.
// Watch: watch/App/Assets.xcassets/AppIcon.appiconset/icon-1024.png, square and opaque.
// Web:   src/renderer/public/{favicon.svg,apple-touch-icon.png,icon-192.png,icon-512.png,
//        icon-maskable-512.png,manifest.webmanifest}. These are SQUARE and full-bleed on purpose: iOS and Android
//        apply their own mask, so a corner radius baked in would be rounded twice. They sit at
//        the web root because the companion reads a first path segment as a workspace slug —
//        /brand/icon.svg is answered "No workspace at /brand".
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
// left lens, then that lens in one stroke. Mirrors site-brand-ink.mjs.
const D = Math.PI / 180
const L = { cx: 50, cy: 50, r: 11 }
const lens = (c, start, turns, r1) => I.arc(c.cx, c.cy, c.r, start, start + Math.PI * 2 * turns, 1.15, 0.6, r1)
const C = I.arc(L.cx, L.cy, 19.5, -90 * D, -300 * D, 1.1, 0.85, 19.5)
const FIRST_O = lens(L, 0, -1.04, 10.4)
// dry: 0, unlike the site's pens. A dry pen ends its stroke in bristle hairlines, which this
// script does not draw (see brush below), so a dry tail is simply missing: at 0.2 the first O
// stood open by a third of its ring, and the C stopped short of 5 o'clock.
const PEN = { width: 9, nib: 0.12, angle: 0, jitter: 0.05, dry: 0 }
const LENS_PEN = { width: 4.6, nib: 0.5, angle: -0.6, jitter: 0.1, dry: 0 }

const tidy = (d) => d.replace(/(\d+\.\d)\d+/g, '$1').replace(/\.0(?=\D)/g, '')
// The mark is drawn ~10× its own size, so the brush is sampled finer than the site's and the
// outline is left clean: the noise filter and the bristle hairlines that give the 430 px lockup
// its tooth turn into a chewed edge on a 1024 px tile.
const brush = (pts, pen) => tidy(I.brushFromLine(I.resample(I.spline(pts), 0.5), pen).body)

/** The mark's box in its own coordinates, measured off the two brushed paths. */
const BOX = { x: 25.9, y: 26.3, w: 37.3, h: 46.8 }

/** The share of the tile the mark's longer side takes: an icon is read at 16 px, so it keeps a margin. */
const ICON_SHARE = 0.76
/** The watch crops to a circle, which the box's corners have to clear. */
const WATCH_SHARE = 0.62
/**
 * An Android adaptive icon shows the middle 72 of its 108 units, so a launcher's circle has a
 * radius of a third of the tile, not the 40% the maskable spec names. The box's corners fit in it.
 */
const MASKABLE_SHARE = 0.5

/**
 * The COO on a paper square. `rounded` bakes the macOS corner in (the .icns has to carry it);
 * the web icons leave the square square and let the platform mask it.
 */
function stamp({ rounded, share = ICON_SHARE }) {
  const strokes = [brush(C, PEN), brush(FIRST_O, LENS_PEN)]
  const s = (TILE * share) / Math.max(BOX.w, BOX.h)
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

const webOut = join(root, 'src', 'renderer', 'public')
mkdirSync(webOut, { recursive: true })
writeFileSync(join(webOut, 'favicon.svg'), stamp({ rounded: false }) + '\n')
const square = render(stamp({ rounded: false }), 'web')
for (const [px, name] of [[512, 'icon-512.png'], [192, 'icon-192.png'], [180, 'apple-touch-icon.png']]) {
  execFileSync('sips', ['-s', 'format', 'png', '-Z', String(px), square, '--out', join(webOut, name)], { stdio: 'ignore' })
}
const maskable = render(stamp({ rounded: false, share: MASKABLE_SHARE }), 'maskable')
execFileSync('sips', ['-s', 'format', 'png', '-Z', '512', maskable, '--out', join(webOut, 'icon-maskable-512.png')], { stdio: 'ignore' })
// The App Store refuses an icon with an alpha channel, and sips keeps one through a plain
// conversion: a JPEG in between is what drops it. Flat ink on paper survives that unchanged.
const watchOut = join(root, 'watch', 'App', 'Assets.xcassets', 'AppIcon.appiconset', 'icon-1024.png')
const watchFlat = join(work, 'watch.jpg')
execFileSync('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', 'best', render(stamp({ rounded: false, share: WATCH_SHARE }), 'watch'), '--out', watchFlat], { stdio: 'ignore' })
execFileSync('sips', ['-s', 'format', 'png', watchFlat, '--out', watchOut], { stdio: 'ignore' })

const manifest = {
  name: 'Cookrew',
  short_name: 'Cookrew',
  description: 'A spatial workspace for a team of AI coding agents.',
  // Relative: a manifest resolves against its own address, and the phone's usual page is
  // /relay/@user/desktop/<id>/ on cookrew.dev, where "/" is the site's home page.
  start_url: '.',
  scope: '.',
  display: 'fullscreen',
  background_color: PAPER,
  theme_color: PAPER,
  icons: [
    { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: 'icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
  ]
}
writeFileSync(join(webOut, 'manifest.webmanifest'), JSON.stringify(manifest, null, 2) + '\n')

console.log('wrote resources/icon.{png,icns} and src/renderer/public/{favicon.svg,apple-touch-icon.png,icon-192,512.png,icon-maskable-512.png,manifest.webmanifest}')
