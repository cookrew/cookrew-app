// Renders the site's share card (1200×630) → registry/assets/site/og-site.jpg, in the ink theme:
// paper, the ink lockup from registry/src/site-brand.ts (drawn still), the front page's headline
// ("Let your tokens flow freely", owner 2026-11-18) and its subline, and the hero picture (the same
// question on three devices, the current interface on demo data, site-frames.ts DEMO.hero) under them.
//
//   node scripts/site-og.mjs [cdpPort]
//
// With a CDP port (a headless shell already running) it renders over the DevTools protocol;
// without one it launches Chrome --headless as before.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const brand = readFileSync(path.join(root, 'registry', 'src', 'site-brand.ts'), 'utf8')
const constant = (name) => JSON.parse(new RegExp(`export const ${name} = (".*")`).exec(brand)[1])
const lockup = constant('BRAND_LOCKUP_HTML')
const crew = path.join(root, 'registry', 'assets', 'site', 'demo-hero-devices-1440.jpg')
const dir = mkdtempSync(path.join(tmpdir(), 'og-'))
const html = `<!doctype html><meta charset="utf-8"><style>
body{margin:0;width:1200px;height:630px;background:#f4efe4;color:#1d1a16;position:relative;overflow:hidden;font-family:'Iowan Old Style','Palatino Linotype',Palatino,Georgia,serif}
body::before{content:'';position:absolute;inset:0;background:radial-gradient(900px 420px at 10% -10%,rgba(168,140,98,.18),transparent 70%),radial-gradient(700px 500px at 110% 40%,rgba(168,140,98,.16),transparent 70%)}
.brand{position:absolute;left:56px;top:34px;color:#1d1a16}.brand svg{width:210px;height:auto;display:block;overflow:visible}
h1{position:absolute;left:60px;top:128px;width:1080px;font-size:64px;line-height:1.05;font-weight:600;margin:0;letter-spacing:-.015em}
h1 em{font-style:normal;background:linear-gradient(transparent 62%,#e2b866 62%,#e2b866 92%,transparent 92%);padding:0 .04em}
p{position:absolute;left:62px;top:212px;width:1080px;font-size:25px;line-height:1.4;color:#5d554a;margin:0}
.foot{position:absolute;right:60px;top:52px;font:600 13px 'SF Mono',Menlo,monospace;letter-spacing:.16em;color:#8f5520}
.shot{position:absolute;left:60px;right:60px;top:280px;height:400px;border-radius:16px;overflow:hidden;background:#fbf8f1;box-shadow:0 1px 2px rgba(40,30,15,.08),0 18px 44px rgba(40,30,15,.16);border:1px solid rgba(29,26,22,.12)}
.shot img{display:block;width:100%}
.ink-draw{stroke-dashoffset:0!important;animation:none!important}
</style><body>
${lockup}
<h1>Let your tokens <em>flow freely</em>.</h1>
<p>One account. Across devices, across agents, across models.</p>
<div class="shot"><img src="file://${crew}"></div>
<div class="foot">OPEN SOURCE · MIT · COOKREW.DEV</div>
</body>`
const file = path.join(dir, 'og.html')
writeFileSync(file, html)
const png = path.join(dir, 'og.png')
const port = process.argv[2]
if (port) {
  const { connectPage } = await import(path.join(root, 'scripts', 'perf-dom-probe.mjs'))
  const page = await connectPage(Number(port))
  await page.send('Page.enable')
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 630, deviceScaleFactor: 1, mobile: false })
  await page.send('Page.navigate', { url: `file://${file}` })
  await new Promise((r) => setTimeout(r, 2500))
  const { data } = await page.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: 1200, height: 630, scale: 1 } })
  writeFileSync(png, Buffer.from(data, 'base64'))
  await page.send('Page.navigate', { url: 'about:blank' })
  page.close()
} else {
  try {
    execFileSync('timeout', ['40', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--allow-file-access-from-files', `--user-data-dir=${dir}/profile`, '--window-size=1200,630', '--force-device-scale-factor=1', '--timeout=15000', '--virtual-time-budget=5000', `--screenshot=${png}`, `file://${file}`], { stdio: 'ignore', timeout: 60000 })
  } catch {
    // a timeout after the capture is fine
  }
}
if (!existsSync(png)) throw new Error('no screenshot was written')
const out = path.join(root, 'registry', 'assets', 'site', 'og-site.jpg')
execFileSync('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '85', png, '--out', out], { stdio: 'ignore' })
console.log('wrote', out)
