// node scripts/site-demo/compose.mjs — the two COMPOSITES the site labels as such, built from renders already in
// $SHOOT_DIR. Nothing is painted into a render: each one is placed whole inside a plain frame on paper.
//   hero.png  the same request on three devices: the desktop renderer (d-peek: the question opened from the dock, over
//             the four agents), the renderer at phone width (p-2-card) and the watch app's own view (watch/w45-01), all
//             on Planner's CHANGELOG question.
//   ops.png   the three operation cards (ops-computer on top, ops-browser and ops-phone below).
import { execFileSync } from 'node:child_process'
import { tab, sleep } from './cdp.mjs'
const SHOOT = process.env.SHOOT_DIR ?? '/tmp/cookrew-site-demo'
const dataUrl = (file) => `data:image/png;base64,${execFileSync('base64', ['-i', file]).toString().replace(/\s/g, '')}`

const HERO = `<!doctype html><html><head><style>
html,body{margin:0;width:2800px;height:1750px;background:#ebe3d3;overflow:hidden;font-family:'JetBrains Mono','SF Mono',Menlo,monospace}
.dev{position:absolute}
.dev img{display:block;width:100%;height:100%;object-fit:cover}
.desk{left:80px;top:70px;width:2060px;height:1287px;border:3px solid #1d1a16;border-radius:22px;overflow:hidden;box-shadow:0 30px 80px rgba(40,30,15,.22)}
.phone{left:2120px;top:330px;width:560px;height:1212px;padding:22px;background:#1d1a16;border-radius:84px;box-shadow:0 30px 80px rgba(40,30,15,.3)}
.phone img{border-radius:64px}
.watch{left:1610px;top:1080px;width:400px;height:489px;padding:30px;background:#1d1a16;border-radius:120px;box-shadow:0 24px 60px rgba(40,30,15,.3)}
.watch img{border-radius:92px}
.tag{position:absolute;font-size:26px;letter-spacing:.16em;color:#5d554a;text-transform:uppercase}
</style></head><body>
<div class="dev desk"><img src="__DESK__"></div>
<div class="dev watch"><img src="__WATCH__"></div>
<div class="dev phone"><img src="__PHONE__"></div>
<div class="tag" style="left:84px;top:1390px">Desktop app</div>
<div class="tag" style="left:1640px;top:1650px">Apple Watch · beta</div>
<div class="tag" style="left:2150px;top:1590px">Phone width</div>
</body></html>`

const t = await tab()
await t.size(2800, 1750, { dsf: 1 })
await t.go('about:blank'); await sleep(300)
const html = HERO.replace('__DESK__', dataUrl(`${SHOOT}/d-peek.png`)).replace('__PHONE__', dataUrl(`${SHOOT}/p-2-card.png`)).replace('__WATCH__', dataUrl(`${SHOOT}/watch/w45-01.png`))
await t.value(`(() => { document.open(); document.write(${JSON.stringify(html)}); document.close(); return 'ok' })()`)
await sleep(1500)
console.log('hero', await t.shot(`${SHOOT}/hero.png`))
await t.close()

// Each card from its title to the foot of its stage; the computer card wide, the other two half width under it.
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', `${SHOOT}/ops-computer.png`, '-i', `${SHOOT}/ops-browser.png`, '-i', `${SHOOT}/ops-phone.png`, '-filter_complex',
  '[0]crop=2640:1680:120:110,scale=2800:-2[c];[1]crop=2640:1680:120:110,scale=1390:-2,pad=1400:ih:0:0:0xebe3d3[b];[2]crop=2640:1680:120:110,scale=1390:-2,pad=1400:ih:10:0:0xebe3d3[p];[b][p]hstack=inputs=2[row];[c]pad=2800:ih+20:0:0:0xebe3d3[top];[top][row]vstack=inputs=2',
  `${SHOOT}/ops.png`])
console.log('ops', `${SHOOT}/ops.png`)
process.exit(0)
