// THE FIRST RUN, PHOTOGRAPHED: the four screens the owner reviews, on the demo
// api's fresh install, at a desktop and a phone width. Walks the real screens:
// the example is tapped, Enter pressed, and the turn the demo plays ends.
//   node scripts/first-run-shoot.mjs <cdpPort> <vitePort> <outDir>
// A probe per shot records the width the page really laid out at: headless
// Chrome clamps its OS window near 500 px, so a width is checked, never assumed.
import { mkdirSync, writeFileSync } from 'node:fs'
import { connectPage } from './perf-dom-probe.mjs'

const [cdpPort, vitePort, out] = process.argv.slice(2)
if (!out) throw new Error('usage: first-run-shoot.mjs <cdpPort> <vitePort> <outDir>')
mkdirSync(out, { recursive: true })
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const page = await connectPage(Number(cdpPort))
const problems = []
page.on('Runtime.exceptionThrown', (p) => problems.push((p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text ?? '').slice(0, 300)))
await page.send('Runtime.enable')
await page.send('Page.enable')
// A fresh install has no remembered harness, zoom stop or prompt pick.
await page.send('Page.addScriptToEvaluateOnNewDocument', { source: 'try { localStorage.clear() } catch {}' })

const value = async (expression) => (await page.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result?.value
const until = async (expression, label, ms = 15000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await value(`!!(${expression})`)) return
    await sleep(120)
  }
  throw new Error(`never saw: ${label}`)
}
const press = (selector, text) =>
  value(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => ${text ? `e.textContent.includes(${JSON.stringify(text)})` : 'true'}); if (!el) return false; el.click(); return true })()`)

const probes = {}
async function shot(name) {
  await sleep(500)
  const { data } = await page.send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(`${out}/${name}.png`, Buffer.from(data, 'base64'))
  probes[name] = await value(`(() => {
    const over = [...document.querySelectorAll('.fr-stage *, .fr-hint, .fr-hint *, .cr-prompt, .cr-prompt *')]
      .filter((e) => e.getClientRects().length && e.getBoundingClientRect().right > innerWidth + 0.5)
      .map((e) => e.className || e.tagName)
    return { innerWidth, scrollWidth: document.documentElement.scrollWidth, overRight: over.slice(0, 6) }
  })()`)
}

async function open(query, w, h) {
  await page.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: w < 700 })
  await page.send('Page.navigate', { url: `http://127.0.0.1:${vitePort}/index.html?${query}` })
  await sleep(600)
}

for (const [label, w, h] of [['1440', 1440, 900], ['412', 412, 915]]) {
  await open('fresh=gaps', w, h)
  await until(`document.querySelectorAll('.fr-row').length === 6`, 'the tool rows')
  await shot(`${label}-1-preflight-gaps`)
  if (await value(`!!document.querySelector('.cr-acct-firstrun')`)) throw new Error('the account card appeared at launch')

  // A fix runs in the Setup card; that card is not the first agent.
  await press('.fr-fix', 'Install tmux')
  await until(`document.querySelector('.fr-setup')`, 'the Setup terminal')
  await shot(`${label}-1b-preflight-fix-running`)
  await press('.fr-go', 'Continue')
  await until(`document.querySelector('.fr-task')`, 'the first screen, past the Setup card')

  await open('fresh=green', w, h)
  await until(`document.querySelectorAll('.fr-row.found').length === 6`, 'six found rows')
  await shot(`${label}-2-preflight-green`)

  await press('.fr-go', 'Continue')
  await until(`document.querySelector('.fr-task') && document.querySelector('.cr-prompt input')?.placeholder.includes('What should')`, 'the first screen')
  await shot(`${label}-3-first-screen`)

  await press('.fr-folder')
  await until(`document.querySelector('.fr-folder.chosen')`, 'the folder chosen')
  await press('.fr-example', 'README')
  await until(`document.querySelector('.cr-prompt input')?.value.includes('README')`, 'the example in the box')
  await shot(`${label}-3b-first-screen-ready`)

  await value(`document.querySelector('.cr-prompt').requestSubmit()`)
  await until(`document.querySelector('.fr-hint')`, 'the phone offer')
  await shot(`${label}-4-first-turn-phone-offer`)

  await press('.fr-go', 'Show the QR')
  await until(`document.querySelector('[aria-label="Pair a phone"] svg, [aria-label="Pair a phone"] .cr-pair-qr')`, 'the QR sheet')
  await shot(`${label}-5-phone-qr`)
  // The account is asked for here, where it is needed, and not one step sooner.
  await press('[aria-label="Pair a phone"] .gs-ghost', 'away from this Wi-Fi')
  await until(`document.querySelector('.cr-acct-firstrun')`, 'the account card, once reached')
  await shot(`${label}-5b-account-asked`)
  await press('.cr-acct-firstrun .gs-ghost', 'NOT NOW')
  await until(`!document.querySelector('[aria-label="Pair a phone"]') && !document.querySelector('.fr-hint') && !document.querySelector('.cr-acct-firstrun')`, 'everything closed')

  // A later turn: words sent to the same agent, as the box sends them.
  await value(`(() => { const box = document.querySelector('.cr-prompt input'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(box, 'Now add a section on how to run it'); box.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
  await sleep(200)
  await value(`document.querySelector('.cr-prompt').requestSubmit()`)
  await until(`document.querySelector('.fr-hint')?.textContent.includes('more than one')`, 'the second-agent hint')
  await shot(`${label}-6-second-agent-hint`)
  await press('.fr-go', 'Got it')
  await until(`!document.querySelector('.fr-hint')`, 'the hint closed')

  await open('fresh=none', w, h)
  await until(`document.querySelectorAll('.fr-row').length === 6`, 'the tool rows')
  await shot(`${label}-7-preflight-no-agent-tool`)
  // No agent tool: Skip leaves the run rather than start a card that would die.
  await press('.fr-quiet', 'Skip')
  await until(`!document.querySelector('.fr-stage') && document.querySelector('.zv-empty')`, 'the plain board')

  await open('fresh=unknown', w, h)
  await until(`document.querySelectorAll('.fr-row.unknown').length === 6`, 'unknown rows')
  await shot(`${label}-8-preflight-unknown`)
}
writeFileSync(`${out}/probes.json`, JSON.stringify({ probes, problems }, null, 1))
console.log(JSON.stringify({ probes, problems }, null, 1))
page.close()
process.exit(problems.length ? 1 : 0)
