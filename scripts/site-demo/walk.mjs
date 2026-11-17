// node walk.mjs <prefix> <w> <h> <mobile 0|1> <scheme> '<steps json>'   (DSF=<device scale>, default 2)
// steps: ["click", css, text?] | ["key", "Escape"] | ["wait", ms] | ["shot", name] | ["eval", js] | ["at", x, y]
import { mkdirSync } from 'node:fs'
import { tab, sleep } from './cdp.mjs'
const SHOOT = process.env.SHOOT_DIR ?? '/tmp/cookrew-site-demo'
mkdirSync(SHOOT, { recursive: true })
const [prefix, w, h, mobile, scheme, stepsJson] = process.argv.slice(2)
const t = await tab()
// Every walk starts as a fresh install: no remembered stop, theme or zoom from the last one.
await t.send('Page.addScriptToEvaluateOnNewDocument', { source: "try { if (!sessionStorage.getItem('walked')) { localStorage.clear(); sessionStorage.setItem('walked', '1') } } catch {}" })
await t.size(Number(w), Number(h), { mobile: mobile === '1', dsf: Number(process.env.DSF ?? 2), scheme })
await t.go('http://127.0.0.1:5397/' + (process.env.Q ?? ''))
await sleep(Number(process.env.BOOT ?? 4500))
for (const step of JSON.parse(stepsJson)) {
  const [verb, a, b] = step
  if (verb === 'click') await t.click(a, b, { touch: false })
  else if (verb === 'at') await t.clickAt(a, b, { touch: false })
  else if (verb === 'press') console.log('press', await t.value(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(a)})].find((e) => ${b ? `(e.textContent || e.getAttribute('aria-label') || '').includes(${JSON.stringify(b)})` : 'true'}); if (!el) return 'missing'; el.click(); return 'ok' })()`))
  else if (verb === 'key') await t.key(a)
  else if (verb === 'wait') await sleep(a)
  else if (verb === 'evalfile') console.log('eval:', JSON.stringify(await t.value((await import('node:fs')).readFileSync(a, 'utf8')), null, 1).slice(0, 4000))
  else if (verb === 'eval') console.log('eval:', JSON.stringify(await t.value(a)).slice(0, 1500))
  else if (verb === 'shot') { await sleep(700); console.log('shot', await t.shot(`${SHOOT}/${prefix}-${a}.png`)) }
  if (verb !== 'wait' && verb !== 'shot' && verb !== 'eval') await sleep(1400)
}
if (t.errors.length) console.log('errors', t.errors)
await t.close(); process.exit(0)
