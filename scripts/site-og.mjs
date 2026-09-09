// Renders the site's share card (1200×630) with headless Chrome → registry/assets/site/og-site.jpg
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dir = mkdtempSync(path.join(tmpdir(), 'og-'))
const html = `<!doctype html><meta charset="utf-8"><style>
body{margin:0;width:1200px;height:630px;background:#faf8f4;font-family:Inter,-apple-system,sans-serif;color:#2d2a20;position:relative;overflow:hidden}
.bar{position:absolute;left:0;right:0;top:0;height:64px;background:#fffef5;border-bottom:3px solid #2d2a20;display:flex;align-items:center;padding:0 48px;gap:16px}
.mark{font:700 22px 'Courier New',monospace;letter-spacing:.14em}.mark b{color:#d97706}
.tag{font:700 12px 'Courier New',monospace;letter-spacing:.14em;background:#ffd600;border:2px solid #2d2a20;padding:4px 10px}
h1{position:absolute;left:48px;top:120px;width:720px;font-size:56px;line-height:1.08;letter-spacing:-.02em;margin:0}
p{position:absolute;left:48px;top:330px;width:700px;font-size:22px;line-height:1.5;color:#5c4a1f;margin:0}
.crt{position:absolute;right:48px;top:110px;width:330px;height:440px;background:#14110a;border:3px solid #2d2a20;box-shadow:10px 10px 0 #2d2a20;color:#e9b949;font:22px/1.3 'Courier New',monospace;padding:22px;box-sizing:border-box}
.crt .d{color:#8a6d1c}.crt .g{color:#6bbe58}
.foot{position:absolute;left:48px;bottom:40px;font:700 14px 'Courier New',monospace;letter-spacing:.12em;color:#78716c}
</style><body>
<div class="bar"><span class="mark">COOK<b>REW</b></span><span class="tag">OPEN SOURCE</span><span class="tag" style="background:#fffef5">cookrew.dev</span></div>
<h1>Run a team of AI coding agents on one canvas — or rent someone’s.</h1>
<p>Claude Code, Codex, OpenCode and Pi as one crew. Every turn a checkpoint. Serve a team at cookrew.dev; anyone opens it from a browser.</p>
<div class="crt"><div class="d">$ cookrew.dev/@drej/cookrew-alpha</div><div>Pilot&gt; ready — one door,<br>3 behind it</div><br><div class="d">❯ audit the checkout sheet</div><div class="d">  ⏺ Forge · Magpie …</div><div class="g">  Forge: done</div><div>Pilot: handled.<br>Checkpoint saved.</div><div>❯ █</div></div>
<div class="foot">MIT · MAC &amp; WINDOWS · MARKETPLACE OF SERVED AGENT TEAMS</div>
</body>`
const file = path.join(dir, 'og.html')
writeFileSync(file, html)
const png = path.join(dir, 'og.png')
// Headless Chrome does not always exit after --screenshot; the file is what matters.
try {
  execFileSync('timeout', ['40', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', `--user-data-dir=${dir}/profile`, '--window-size=1200,630', '--force-device-scale-factor=1', '--timeout=15000', '--virtual-time-budget=5000', `--screenshot=${png}`, `file://${file}`], { stdio: 'ignore', timeout: 60000 })
} catch {
  // a timeout after the capture is fine
}
if (!existsSync(png)) throw new Error('no screenshot was written')
const out = path.join(root, 'registry', 'assets', 'site', 'og-site.jpg')
execFileSync('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '85', png, '--out', out], { stdio: 'ignore' })
console.log('wrote', out)
