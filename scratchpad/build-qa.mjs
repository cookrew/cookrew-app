import esbuild from 'esbuild'
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
const root = path.resolve(import.meta.dirname, '..')
const req = createRequire(import.meta.url)
const built = await esbuild.build({
  entryPoints: [path.join(root, 'scratchpad/qa-render.tsx')],
  bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic',
  write: false, loader: { '.css': 'empty' }, logLevel: 'error'
})
let captured = ''
const real = process.stdout.write.bind(process.stdout)
process.stdout.write = (c) => { captured += c; return true }
const mod = { exports: {} }
new Function('module','exports','require', built.outputFiles[0].text)(mod, mod.exports, req)
process.stdout.write = real
const css = (f) => readFileSync(path.join(root, 'src/renderer/src', f), 'utf8')
const styles = css('styles.css')
const rootBlock = styles.match(/:root\s*\{[\s\S]*?\}/)?.[0] ?? ''
writeFileSync(path.join(root, 'scratchpad/qa-share-on-save.html'), `<!DOCTYPE html><html><head><meta charset="utf-8">
<title>QA — share on save (real components)</title>
<link href="https://fonts.googleapis.com/css2?family=Silkscreen&family=JetBrains+Mono&family=Inter&display=swap" rel="stylesheet">
<style>${rootBlock}${css('team-fork.css')}
body{margin:0;background:#2b2822;color:#eee;font-family:var(--font-body,system-ui);padding:24px}
h1{font-family:var(--font-pixel,monospace);font-size:15px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(380px,1fr));gap:20px}
.qa h2{font-family:var(--font-pixel,monospace);font-size:10px;color:#d9d3c5;text-transform:uppercase}
.stage{background:var(--cream-lo,#ece6da);padding:18px;border-radius:8px}
.tf-panel{background:var(--cream-hi);border:2px solid var(--line);box-shadow:5px 5px 0 var(--amber-deep);color:var(--ink)}
.note{color:#aaa;font-size:12px;max-width:52ch}
</style></head><body>
<h1>QA — SHARE ON SAVE · rendered from the shipped ShareOnSave component</h1>
<div class="grid">${captured}</div></body></html>`)
console.log('ok')
