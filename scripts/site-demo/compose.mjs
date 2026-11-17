// node scripts/site-demo/compose.mjs — the COMPOSITES the site labels as such, built from renders in $SHOOT_DIR. Nothing is
// painted into a render: each one is cropped (to its subject, never scaled up) and placed whole in a plain frame on paper.
//   hero.png        one request on three devices: the desktop renderer (h-peek, cropped to the four agents and the question
//                   opened from the dock), the renderer at phone width (p-card) and the watch app's own view (watch/w45-01).
//   hero-phone.png  the same for a phone screen: the phone render (card and menu) over the watch.
//   ops.png         the three operation cards: the computer screen card wide, the browser and phone cards under it.
//   ops-phone.png   the same three, each cropped to its title and picture, one above the other.
//   watch-phone.png the watch strip's three screens, two over one.
import { execFileSync } from 'node:child_process'
import { tab, sleep } from './cdp.mjs'
const SHOOT = process.env.SHOOT_DIR ?? '/tmp/cookrew-site-demo'
const ff = (args) => execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...args])
const dataUrl = (file) => `data:image/png;base64,${execFileSync('base64', ['-i', file]).toString().replace(/\s/g, '')}`
// A crop in the capture's CSS pixels, at its device scale.
const crop = (src, [x, y, w, h], dsf, out) => { ff(['-i', src, '-vf', `crop=${Math.round(w * dsf)}:${Math.round(h * dsf)}:${Math.round(x * dsf)}:${Math.round(y * dsf)}`, '-update', '1', out]); return out }

const PAGE = (w, h, body) => `<!doctype html><html><head><style>
html,body{margin:0;width:${w}px;height:${h}px;background:#ebe3d3;overflow:hidden;font-family:'JetBrains Mono','SF Mono',Menlo,monospace}
.dev{position:absolute}.dev img{display:block;width:100%;height:100%;object-fit:cover}
.desk{border:3px solid #1d1a16;border-radius:22px;overflow:hidden;box-shadow:0 30px 80px rgba(40,30,15,.22);background:#f4efe4}
.phone{padding:22px;background:#1d1a16;border-radius:84px;box-shadow:0 30px 80px rgba(40,30,15,.3)}.phone img{border-radius:64px}
.crop{border:3px solid #1d1a16;border-radius:40px;overflow:hidden;box-shadow:0 30px 80px rgba(40,30,15,.22)}
.watch{padding:30px;background:#1d1a16;border-radius:120px;box-shadow:0 24px 60px rgba(40,30,15,.3)}.watch img{border-radius:92px}
.tag{position:absolute;font-size:26px;letter-spacing:.16em;color:#5d554a;text-transform:uppercase}
</style></head><body>${body}</body></html>`
const t = await tab()
const draw = async (w, h, html, out) => {
  await t.size(w, h, { dsf: 1 }); await t.go('about:blank'); await sleep(300)
  await t.value(`(() => { document.open(); document.write(${JSON.stringify(html)}); document.close(); return 1 })()`)
  await sleep(1500); console.log('drew', await t.shot(out))
}

// The hero: the desktop crop is 640×520 CSS px of a 1440×900 window at ×4 (2560×2080).
const desk = crop(`${SHOOT}/h-peek.png`, [440, 280, 640, 520], 4, `${SHOOT}/c-peek.png`)
const card = crop(`${SHOOT}/p-card.png`, [0, 280, 390, 564], 3, `${SHOOT}/c-card.png`)
await draw(2800, 1750, PAGE(2800, 1750, `
<div class="dev desk" style="left:80px;top:110px;width:1500px;height:1219px"><img src="${dataUrl(desk)}"></div>
<div class="dev phone" style="left:1650px;top:250px;width:560px;height:1212px"><img src="${dataUrl(`${SHOOT}/p-card.png`)}"></div>
<div class="dev watch" style="left:2270px;top:860px;width:400px;height:489px"><img src="${dataUrl(`${SHOOT}/watch/w45-01.png`)}"></div>
<div class="tag" style="left:84px;top:1370px">Desktop app · cropped</div>
<div class="tag" style="left:1680px;top:1545px">Phone width</div>
<div class="tag" style="left:2270px;top:1445px">Apple Watch<br>· beta</div>`), `${SHOOT}/hero.png`)
await draw(1170, 2560, PAGE(1170, 2560, `
<div class="dev crop" style="left:40px;top:40px;width:1084px;height:1567px"><img src="${dataUrl(card)}"></div>
<div class="tag" style="left:44px;top:1640px">Phone width</div>
<div class="dev watch" style="left:313px;top:1720px;width:484px;height:592px;padding:36px"><img src="${dataUrl(`${SHOOT}/watch/w45-01.png`)}"></div>
<div class="tag" style="left:390px;top:2390px">Apple Watch · beta</div>`), `${SHOOT}/hero-phone.png`)
await t.close()

// The operation cards, rendered at 1024×640 ×2.8125. Desktop: each whole card; phone: each card's left part with its title
// and picture.
const D = 2.8125
const card3 = (name, box) => crop(`${SHOOT}/ops-${name}.png`, box, D, `${SHOOT}/c-ops-${name}.png`)
const [cw, cb, cp] = [card3('computer', [30, 30, 960, 550]), card3('browser', [30, 30, 960, 550]), card3('phone', [30, 30, 960, 550])]
ff(['-i', cw, '-i', cb, '-i', cp, '-filter_complex',
  '[0]scale=2880:-2[c];[1]scale=1430:-2,pad=1440:ih:0:0:0xebe3d3[b];[2]scale=1430:-2,pad=1440:ih:10:0:0xebe3d3[p];[b][p]hstack=inputs=2[row];[c]pad=2880:ih+20:0:0:0xebe3d3[top];[top][row]vstack=inputs=2', '-update', '1', `${SHOOT}/ops.png`])
const [pw, pb, pp] = [crop(`${SHOOT}/ops-computer.png`, [30, 30, 620, 540], D, `${SHOOT}/c-opsp-computer.png`), crop(`${SHOOT}/ops-browser.png`, [30, 30, 620, 540], D, `${SHOOT}/c-opsp-browser.png`), crop(`${SHOOT}/ops-phone.png`, [30, 30, 620, 540], D, `${SHOOT}/c-opsp-phone.png`)]
ff(['-i', pw, '-i', pb, '-i', pp, '-filter_complex', '[0]scale=1170:-2,pad=iw:ih+24:0:0:0xebe3d3[a];[1]scale=1170:-2,pad=iw:ih+24:0:0:0xebe3d3[b];[2]scale=1170:-2[c];[a][b][c]vstack=inputs=3', '-update', '1', `${SHOOT}/ops-phone-stack.png`])
// The watch for a phone: Checker's reply and the crew side by side, the devices under them.
ff(['-f', 'lavfi', '-i', 'color=c=0x1D1A16:s=1278x1542', '-i', `${SHOOT}/watch/w45-05.png`, '-i', `${SHOOT}/watch/w45-13.png`, '-i', `${SHOOT}/watch/w45-19.png`, '-filter_complex',
  '[0][1]overlay=30:30[a];[a][2]overlay=654:30[b];[b][3]overlay=342:786', '-frames:v', '1', '-update', '1', `${SHOOT}/watch-phone.png`])
console.log('ops, ops-phone-stack, watch-phone written')
process.exit(0)
