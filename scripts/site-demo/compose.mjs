// node scripts/site-demo/compose.mjs — the COMPOSITES the site labels as such, built from renders in $SHOOT_DIR. Nothing is
// painted into a render: each one is cropped (to its subject, never scaled up) and placed whole in a plain frame on paper.
//   hero.png        one request on three devices, one bezel each, on one baseline, untagged (owner 2026-11-18): the desktop
//                   renderer (h-peek, cropped to the four agents and the question from the dock), the renderer at phone width
//                   (p-card) and the watch app's own view (watch/w45-01, or w45n-01 at night).
//   hero-phone.png  the same for a phone screen: the phone render (card and menu) over the watch.
//   ops.png         the three operation cards: the computer screen card wide, the browser and phone cards under it.
//   ops-phone.png   the same three, each cropped to its title and picture, one above the other.
//   watch-phone.png the watch strip's three screens, two over one.
import { execFileSync } from 'node:child_process'
import { tab, sleep, NIGHT } from './cdp.mjs'
const SHOOT = process.env.SHOOT_DIR ?? '/tmp/cookrew-site-demo'
const ff = (args) => execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...args])
const dataUrl = (file) => `data:image/png;base64,${execFileSync('base64', ['-i', file]).toString().replace(/\s/g, '')}`
// A crop in the capture's CSS pixels, at its device scale.
const crop = (src, [x, y, w, h], dsf, out) => { ff(['-i', src, '-vf', `crop=${Math.round(w * dsf)}:${Math.round(h * dsf)}:${Math.round(x * dsf)}:${Math.round(y * dsf)}`, '-update', '1', out]); return out }

// Day or night (cdp.mjs NIGHT): the paper the frames lie on, and the frames' bezel.
const PAPER = NIGHT ? '#15130f' : '#ebe3d3'
const BEZEL = NIGHT ? '#050403' : '#1d1a16'
const RIM = NIGHT ? 'box-shadow:0 0 0 2px rgba(236,228,210,.22),0 30px 80px rgba(0,0,0,.5)' : 'box-shadow:0 30px 80px rgba(40,30,15,.26)'
/** One bezel for every device (owner 2026-11-18: the desktop framed like the phone and the watch, the same thickness). */
const B = 28
const PAGE = (w, h, body) => `<!doctype html><html><head><style>
html,body{margin:0;width:${w}px;height:${h}px;background:${PAPER};overflow:hidden}
.dev{position:absolute;box-sizing:content-box;padding:${B}px;background:${BEZEL};${RIM}}
.dev img{display:block;width:100%;height:100%;object-fit:cover}
</style></head><body>${body}</body></html>`
const t = await tab()
const draw = async (w, h, html, out) => {
  await t.size(w, h, { dsf: 1 }); await t.go('about:blank'); await sleep(300)
  await t.value(`(() => { document.open(); document.write(${JSON.stringify(html)}); document.close(); return 1 })()`)
  await sleep(1500); console.log('drew', await t.shot(out))
}
/** A device: its screen's size, the bezel's outer and inner radius. */
const device = (img, x, y, w, h, r, extra = '') => `<div class="dev" style="left:${x}px;top:${y}px;width:${w}px;height:${h}px;border-radius:${r + B}px${extra}"><img src="${dataUrl(img)}" style="border-radius:${r}px"></div>`

// The hero: three devices on one baseline, one bezel. The desktop's screen is a 640×520 CSS px crop of a 1440×900 window
// at ×4 (the four agents and the question from the dock); the phone the 390 px render whole; the watch its own view.
const desk = crop(`${SHOOT}/h-peek.png`, [440, 280, 640, 520], 4, `${SHOOT}/c-peek.png`)
// The phone's question opens from its dock (as on the desktop): Planner's face, the question and its rows.
const card = crop(`${SHOOT}/p-card.png`, [0, 230, 390, 614], 3, `${SHOOT}/c-card.png`)
const watchFile = `${SHOOT}/watch/${NIGHT ? 'w45n-01' : 'w45-01'}.png`
{
  const W = 2800, M = 70, G = 64
  const dw = 1440, dh = Math.round((dw * 520) / 640)
  const pw = 500, ph = Math.round((pw * 2532) / 1170)
  const ww = 380, wh = Math.round((ww * 726) / 594)
  const total = dw + pw + ww + 6 * B + 2 * G
  const x0 = Math.round((W - total) / 2)
  const base = M + dh + 2 * B
  const H = base + M
  await draw(W, H, PAGE(W, H, `
${device(desk, x0, base - dh - 2 * B, dw, dh, 24)}
${device(`${SHOOT}/p-card.png`, x0 + dw + 2 * B + G, base - ph - 2 * B, pw, ph, 56)}
${device(watchFile, x0 + dw + pw + 4 * B + 2 * G, base - wh - 2 * B, ww, wh, 92)}`), `${SHOOT}/hero.png`)
}
// For a phone: the phone render's card and menu over the watch, the same bezel.
{
  const W = 1170, cw = W - 2 * 40 - 2 * B, chh = Math.round((cw * 614) / 390)
  const ww = 420, wh = Math.round((ww * 726) / 594)
  const H = 40 + chh + 2 * B + 56 + wh + 2 * B + 40
  await draw(W, H, PAGE(W, H, `
${device(card, 40, 40, cw, chh, 36)}
${device(watchFile, Math.round((W - ww - 2 * B) / 2), 40 + chh + 2 * B + 56, ww, wh, 100)}`), `${SHOOT}/hero-phone.png`)
}
await t.close()

// The operation cards, rendered at 1024×640 ×2.8125. Desktop: each whole card; phone: each card's left part with its title
// and picture.
const D = 2.8125
const PAD = NIGHT ? '0x15130f' : '0xebe3d3'
const card3 = (name, box) => crop(`${SHOOT}/ops-${name}.png`, box, D, `${SHOOT}/c-ops-${name}.png`)
const [cw, cb, cp] = [card3('computer', [30, 30, 960, 550]), card3('browser', [30, 30, 960, 550]), card3('phone', [30, 30, 960, 550])]
ff(['-i', cw, '-i', cb, '-i', cp, '-filter_complex',
  `[0]scale=2880:-2[c];[1]scale=1430:-2,pad=1440:ih:0:0:${PAD}[b];[2]scale=1430:-2,pad=1440:ih:10:0:${PAD}[p];[b][p]hstack=inputs=2[row];[c]pad=2880:ih+20:0:0:${PAD}[top];[top][row]vstack=inputs=2`, '-update', '1', `${SHOOT}/ops.png`])
const [pw, pb, pp] = [crop(`${SHOOT}/ops-computer.png`, [30, 30, 620, 540], D, `${SHOOT}/c-opsp-computer.png`), crop(`${SHOOT}/ops-browser.png`, [30, 30, 620, 540], D, `${SHOOT}/c-opsp-browser.png`), crop(`${SHOOT}/ops-phone.png`, [30, 30, 620, 540], D, `${SHOOT}/c-opsp-phone.png`)]
ff(['-i', pw, '-i', pb, '-i', pp, '-filter_complex', `[0]scale=1170:-2,pad=iw:ih+24:0:0:${PAD}[a];[1]scale=1170:-2,pad=iw:ih+24:0:0:${PAD}[b];[2]scale=1170:-2[c];[a][b][c]vstack=inputs=3`, '-update', '1', `${SHOOT}/ops-phone-stack.png`])
const W45 = NIGHT ? 'w45n-' : 'w45-'
// The watch for a phone: Checker's reply and the crew side by side, the devices under them.
ff(['-f', 'lavfi', '-i', 'color=c=0x1D1A16:s=1278x1542', '-i', `${SHOOT}/watch/${W45}05.png`, '-i', `${SHOOT}/watch/${W45}13.png`, '-i', `${SHOOT}/watch/${W45}19.png`, '-filter_complex',
  '[0][1]overlay=30:30[a];[a][2]overlay=654:30[b];[b][3]overlay=342:786', '-frames:v', '1', '-update', '1', `${SHOOT}/watch-phone.png`])
console.log('ops, ops-phone-stack, watch-phone written')
process.exit(0)
