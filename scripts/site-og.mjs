// Renders the site's share card (1200×630) → registry/assets/site/og-site.jpg, in the ink theme:
// paper, the ink lockup from registry/src/site-brand.ts (drawn still), the headline in serif, and
// a real frame of the app (the crew view) on the right.
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
const crew = path.join(root, 'registry', 'assets', 'site', 'seq-canvas-1.jpg')
const dir = mkdtempSync(path.join(tmpdir(), 'og-'))
const html = `<!doctype html><meta charset="utf-8"><style>
body{margin:0;width:1200px;height:630px;background:#f4efe4;color:#1d1a16;position:relative;overflow:hidden;font-family:'Iowan Old Style','Palatino Linotype',Palatino,Georgia,serif}
body::before{content:'';position:absolute;inset:0;background:radial-gradient(900px 420px at 10% -10%,rgba(168,140,98,.18),transparent 70%),radial-gradient(700px 500px at 110% 40%,rgba(168,140,98,.16),transparent 70%)}
.brand{position:absolute;left:56px;top:40px;color:#1d1a16}.brand svg{width:340px;height:auto;display:block;overflow:visible}
h1{position:absolute;left:60px;top:200px;width:560px;font-size:50px;line-height:1.08;font-weight:600;margin:0;letter-spacing:-.01em}
p{position:absolute;left:62px;top:440px;width:540px;font-size:21px;line-height:1.5;color:#5d554a;margin:0}
.foot{position:absolute;left:62px;bottom:38px;font:600 13px 'SF Mono',Menlo,monospace;letter-spacing:.16em;color:#8f5520}
.foot::before{content:'';display:inline-block;width:22px;height:1px;background:currentColor;vertical-align:middle;margin-right:10px}
.shot{position:absolute;right:-60px;top:70px;width:560px;border-radius:14px;overflow:hidden;background:#fbf8f1;box-shadow:0 1px 2px rgba(40,30,15,.08),0 18px 44px rgba(40,30,15,.16);border:1px solid rgba(29,26,22,.12)}
.shot img{display:block;width:100%}
.ink-draw{stroke-dashoffset:0!important;animation:none!important}
</style><body>
${lockup}
<h1>Run a team of AI coding agents on one canvas — or rent someone’s.</h1>
<p>Claude Code, Codex, OpenCode and Pi as one crew. Every turn is a checkpoint.</p>
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
