// node scripts/site-demo/ops.mjs — the three operation cards (browser, computer, phone) as one COMPOSITE.
// The browser card renders its page itself. The demo has no screen behind a screen:// or window:// card, so a
// picture of the same local page (desktop size, and phone width) is laid over each card's empty stage: the card's
// own chrome around it (name, USED BY, the bar, the buttons) is the product's, the picture inside is composited,
// and the site labels the figure "Composite of product UI renders on demo data · illustration".
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tab, sleep } from './cdp.mjs'
const SHOOT = process.env.SHOOT_DIR ?? '/tmp/cookrew-site-demo'
mkdirSync(SHOOT, { recursive: true })
const PAGE = 'http://notes.example/release-notes.html'

// 1. The pictures that go inside: a neutral desktop (pages/desktop.html: the same page and a build in a terminal)
// at the stage's size, and the page at a phone's width.
const pic = await tab()
await pic.size(1288, 673, { dsf: 2 })
await pic.go('http://notes.example/desktop.html'); await sleep(1500)
await pic.shot(`${SHOOT}/pic-desktop.png`)
await pic.size(390, 844, { dsf: 3, mobile: true })
await pic.go(PAGE); await sleep(1200)
await pic.shot(`${SHOOT}/pic-phone.png`)
await pic.close()
const dataUrl = (file) => `data:image/png;base64,${execFileSync('base64', ['-i', file]).toString().replace(/\s/g, '')}`

// 2. The cards, opened by their own buttons; the picture laid over the stage that says no screen stands behind it.
const t = await tab()
await t.send('Page.addScriptToEvaluateOnNewDocument', { source: "try { if (!sessionStorage.getItem('walked')) { localStorage.clear(); sessionStorage.setItem('walked', '1') } } catch {}" })
await t.size(1440, 900, { dsf: 2 })
const press = (css, text) => t.value(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(css)})].find((e) => (e.textContent || e.getAttribute('aria-label') || '').includes(${JSON.stringify(text ?? '')})); if (!el) return 'missing'; el.click(); return 'ok' })()`)
const OVERLAY = `(src, fit, at) => {
  const words = [...document.querySelectorAll('body *')].find((e) => e.children.length === 0 && /is a screen on this Mac/.test(e.textContent || ''))
  if (!words) return 'no stage'
  let stage = words.parentElement
  while (stage && stage.getBoundingClientRect().height < 300) stage = stage.parentElement
  const b = at ?? stage.getBoundingClientRect()
  const img = document.createElement('img')
  img.src = src
  img.style.cssText = 'position:fixed;z-index:9999;left:' + b.left + 'px;top:' + b.top + 'px;width:' + b.width + 'px;height:' + b.height + 'px;object-fit:' + fit + ';background:#1d1a16;border-radius:0 0 10px 10px'
  document.body.appendChild(img)
  return { left: b.left, top: b.top, width: b.width, height: b.height }
}`
// The phone card's stage moves while it opens: it takes the computer card's stage, which is the same box.
let stageBox = null
const overlay = (src, fit) => t.value(`(${OVERLAY})(${JSON.stringify(src)}, ${JSON.stringify(fit)}, ${JSON.stringify(stageBox)})`)
const shots = []
for (const [name, label, picture, fit] of [['browser', 'Release notes', null, ''], ['computer', 'Main display', `${SHOOT}/pic-desktop.png`, 'cover'], ['phone', 'iPhone 17 Pro', `${SHOOT}/pic-phone.png`, 'contain']]) {
  await t.go('http://127.0.0.1:5397/'); await sleep(4500)
  console.log(name, await press('.zv-group.items .zv-group-stop'))
  await sleep(1200)
  console.log(name, await press('.zv-ip .zv-who, .zv-ip', label))
  await sleep(2500)
  if (picture) { const box = await overlay(dataUrl(picture), fit); if (stageBox === null && typeof box === 'object') stageBox = box; console.log(name, JSON.stringify(box)); await sleep(600) }
  shots.push(await t.shot(`${SHOOT}/ops-${name}.png`))
}
await t.close()
// 3. Side by side: each card from its title to the foot of its stage.
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...shots.flatMap((f) => ['-i', f]), '-filter_complex',
  '[0]crop=2640:1680:120:110,scale=900:-2[a];[1]crop=2640:1680:120:110,scale=900:-2[b];[2]crop=2640:1680:120:110,scale=900:-2[c];[a][b][c]hstack=inputs=3', `${SHOOT}/ops-strip.png`])
writeFileSync(`${SHOOT}/ops.json`, JSON.stringify({ shots, page: PAGE }, null, 1))
console.log('ops strip', `${SHOOT}/ops-strip.png`, 'errors', t.errors)
process.exit(0)
