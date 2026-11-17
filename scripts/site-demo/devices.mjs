// node scripts/site-demo/devices.mjs — the devices stop as a COMPOSITE: the stop itself (both machines, their names and
// gauges), and under it each machine's screen from the same render, ENLARGED. The stop draws a machine's workspaces at
// the size of a laptop's screen, which at a page's width is too small to read; the enlargements are the same DOM captured
// with a larger clip scale (Chrome re-rasterises it, nothing is scaled up), laid in plain frames on paper and tagged.
//   devices.png        desktop: the stop (1024×640 layout, ×3) over the two enlarged screens (×11)
//   devices-phone.png  phone: each machine as the 390 px layout draws it (×3), its screen (the desktop capture, ×11) under it
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { tab, sleep } from './cdp.mjs'
const SHOOT = process.env.SHOOT_DIR ?? '/tmp/cookrew-site-demo'
const dataUrl = (file) => `data:image/png;base64,${execFileSync('base64', ['-i', file]).toString().replace(/\s/g, '')}`
const t = await tab()
await t.send('Page.addScriptToEvaluateOnNewDocument', { source: "try { if (!sessionStorage.getItem('walked')) { localStorage.clear(); sessionStorage.setItem('walked', '1') } } catch {}" })

const BOXES = `(() => {
  const union = (els) => { const r = els.map((e) => e.getBoundingClientRect()).filter((b) => b.width > 0 && b.height > 0); if (!r.length) return null
    const x = Math.min(...r.map((b) => b.left)), y = Math.min(...r.map((b) => b.top)); return { x, y, w: Math.max(...r.map((b) => b.right)) - x, h: Math.max(...r.map((b) => b.bottom)) - y } }
  return [...document.querySelectorAll('.zv-machine')].filter((m) => m.getClientRects().length).map((m) => ({
    name: (m.querySelector('.zv-machine-label')?.textContent ?? '').trim().split(/\\d/)[0].trim(),
    block: union([m, ...m.querySelectorAll('*')]),
    // Another machine draws its tiles in its own frame (.zv-om-screen); this one's are the live workspaces stop, laid over
    // its frame (.zv-device): the elements of it that sit inside the frame.
    screen: m.querySelector('.zv-om-screen') ? union([...m.querySelectorAll('.zv-om-screen *')]) : union([...document.querySelectorAll('.zv-device *')].filter((e) => {
      const b = e.getBoundingClientRect(), f = m.getBoundingClientRect(), cx = b.left + b.width / 2, cy = b.top + b.height / 2
      return b.width > 0 && cx > f.left && cx < f.right && cy > f.top && cy < f.bottom
    }))
  }))
})()`
const clip = async (box, scale, pad, file) => {
  const { data } = await t.send('Page.captureScreenshot', { format: 'png', clip: { x: box.x - pad, y: box.y - pad, width: box.w + 2 * pad, height: box.h + 2 * pad, scale } })
  writeFileSync(file, Buffer.from(data, 'base64')); return file
}
const open = async (w, h, mobile) => {
  await t.size(w, h, { dsf: 1, mobile }); await t.go('http://127.0.0.1:5397/'); await sleep(4500)
  await t.value(`(() => { document.querySelector('button[aria-label="devices"]').click(); return 1 })()`)
  await sleep(5000) // the gauges answer every 4 s
  return t.value(BOXES)
}

// Desktop.
const desk = (await open(1024, 640, false)).sort((a, b) => a.block.x - b.block.x)
const all = { x: Math.min(...desk.map((m) => m.block.x)), y: Math.min(...desk.map((m) => m.block.y)) }
all.w = Math.max(...desk.map((m) => m.block.x + m.block.w)) - all.x; all.h = Math.max(...desk.map((m) => m.block.y + m.block.h)) - all.y
const stop = await clip(all, 3, 16, `${SHOOT}/dv-stop.png`)
const deskScreens = []
for (const [i, m] of desk.entries()) deskScreens.push({ name: m.name, file: await clip(m.screen, 11, 8, `${SHOOT}/dv-screen-${i}.png`), w: m.screen.w + 16, h: m.screen.h + 16 })
// Phone.
const phone = (await open(390, 844, true)).sort((a, b) => a.block.y - b.block.y)
const phoneParts = []
for (const [i, m] of phone.entries()) phoneParts.push({ name: m.name, block: await clip(m.block, 3, 8, `${SHOOT}/dvp-block-${i}.png`), bw: m.block.w + 16, bh: m.block.h + 16 })
console.log(JSON.stringify({ desk: desk.map((m) => [m.name, m.screen]), phone: phone.map((m) => [m.name, m.block, m.screen]) }))

const CSS = `html,body{margin:0;background:#ebe3d3;font-family:'JetBrains Mono','SF Mono',Menlo,monospace}
img{display:block}.stop{border:3px solid #1d1a16;border-radius:28px;overflow:hidden;background:#f4efe4}
.mag{border:3px solid #1d1a16;border-radius:28px;overflow:hidden;background:#f4efe4;box-shadow:0 20px 60px rgba(40,30,15,.18)}
.tag{font-size:26px;letter-spacing:.14em;color:#5d554a;text-transform:uppercase;margin:0 0 14px}`
const draw = async (w, html, out) => {
  await t.size(w, 400, { dsf: 1 }); await t.go('about:blank'); await sleep(300)
  await t.value(`(() => { document.open(); document.write(${JSON.stringify(`<!doctype html><html><head><style>${CSS}</style></head><body>${html}</body></html>`)}); document.close(); return 1 })()`)
  await sleep(1200)
  const h = await t.value('Math.ceil(document.body.getBoundingClientRect().height)')
  await t.size(w, h, { dsf: 1 }); await sleep(500)
  console.log('drew', await t.shot(out))
}
// Desktop: 2880 wide; the stop at 2800, the two enlargements side by side at one height, filling the row.
const GAP = 60
const H = Math.floor((2800 - GAP * (deskScreens.length - 1)) / deskScreens.reduce((a, s) => a + s.w / s.h, 0))
const widths = deskScreens.map((s) => Math.floor((H * s.w) / s.h))
const gap = GAP
await draw(2880, `<div style="padding:40px">
<img class="stop" src="${dataUrl(stop)}" style="width:2794px">
<div style="display:flex;justify-content:space-between;gap:${Math.max(40, gap)}px;margin-top:56px">${deskScreens.map((s, i) => `<div><p class="tag">${s.name} · its screen, enlarged</p><img class="mag" src="${dataUrl(s.file)}" style="width:${widths[i]}px;height:${H}px"></div>`).join('')}</div></div>`, `${SHOOT}/devices.png`)
// Phone: 1170 wide, each machine then its screen.
await draw(1170, `<div style="padding:30px">${phoneParts.map((p) => `<img class="stop" src="${dataUrl(p.block)}" style="width:1104px;margin-bottom:28px">
<p class="tag">${p.name} · its screen, enlarged</p>${((s) => `<img class="mag" src="${dataUrl(s.file)}" style="width:${Math.min(1104, Math.round((900 * s.w) / s.h))}px;margin:0 auto 60px">`)(deskScreens.find((d) => d.name === p.name))}`).join('')}</div>`, `${SHOOT}/devices-phone.png`)
await t.close(); process.exit(0)
