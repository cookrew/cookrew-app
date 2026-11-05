// THE FIRST RUN, PHOTOGRAPHED: the screens the owner reviews, on the demo api's
// fresh install, at a desktop and a phone width. Walks the real screens: the
// example is tapped, Enter pressed, and the turn the demo plays ends.
//   COOKREW_TELEMETRY=0 node scripts/first-run-shoot.mjs <cdpPort> <vitePort> <outDir>
// The demo has no main process and no network: nothing here reaches a registry,
// and it refuses to drive anything but loopback.
// A probe per shot records the width the page really laid out at: headless
// Chrome clamps its OS window near 500 px, so a width is checked, never assumed.
import { mkdirSync, writeFileSync } from 'node:fs'
import { connectPage } from './perf-dom-probe.mjs'

const [cdpPort, vitePort, out] = process.argv.slice(2)
if (!out) throw new Error('usage: first-run-shoot.mjs <cdpPort> <vitePort> <outDir>')
if (process.env.COOKREW_TELEMETRY !== '0') throw new Error('set COOKREW_TELEMETRY=0: a QA run must never count as an install')
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
  await until(`document.querySelectorAll('.fr-row').length === 8`, 'the tool rows')
  await shot(`${label}-1-preflight-gaps`)
  if (await value(`!!document.querySelector('.cr-acct-firstrun')`)) throw new Error('the account card appeared at launch')

  // A fix runs in the Setup card; that card is not the first agent.
  await press('.fr-fix', 'Install tmux')
  await until(`document.querySelector('.fr-setup')`, 'the Setup terminal')
  await shot(`${label}-1b-preflight-fix-running`)
  await press('.fr-go', 'Continue')
  await until(`document.querySelector('.fr-task')`, 'the first screen, past the Setup card')

  await open('fresh=green', w, h)
  await until(`document.querySelectorAll('.fr-row.found').length === 8`, 'six found rows')
  await shot(`${label}-2-preflight-green`)

  await press('.fr-go', 'Continue')
  await until(`document.querySelector('.fr-task') && document.querySelector('.cr-prompt input')?.placeholder.includes('What should')`, 'the first screen')
  await shot(`${label}-3-first-screen`)

  await press('.fr-folder')
  await until(`document.querySelector('.fr-folder.chosen')`, 'the folder chosen')
  await until(`document.body.textContent.includes('now called my-site')`, 'the workspace named after its folder')
  await press('.fr-example', 'README')
  await until(`document.querySelector('.cr-prompt input')?.value.includes('README')`, 'the example in the box')
  await shot(`${label}-3b-first-screen-ready`)

  await value(`document.querySelector('.cr-prompt').requestSubmit()`)
  await until(`document.querySelector('.fr-hint')`, 'the phone offer')
  await until(`/done|resting/i.test(document.querySelector('.zv-root')?.textContent ?? '')`, 'the card at rest under the offer')
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
  await until(`document.querySelectorAll('.fr-row').length === 8`, 'the tool rows')
  await shot(`${label}-7-preflight-no-agent-tool`)
  // Skip keeps the first screen, and the first screen keeps the way back.
  await press('.fr-quiet', 'Skip')
  await until(`document.querySelector('.fr-task')`, 'the first screen, after Skip')
  await shot(`${label}-7b-first-screen-after-skip`)
  await press('.fr-quiet', 'Check this computer again')
  await until(`document.querySelectorAll('.fr-row').length === 8`, 'the way back to the check')
  await press('.fr-quiet', 'Skip')
  await until(`document.querySelector('.fr-task')`, 'the first screen again')
  await press('.fr-quiet', 'Look around first')
  await until(`document.querySelector('.fr-back') && !document.querySelector('.fr-task')`, 'the app, with a way back')
  await press('.fr-back')
  await until(`document.querySelector('.fr-task')`, 'back to getting started')

  await open('fresh=unknown', w, h)
  await until(`document.querySelectorAll('.fr-row.unknown').length === 8`, 'unknown rows')
  await shot(`${label}-8-preflight-unknown`)

  // The road with no account: the form, a refusal that names the field, then saved.
  await open('fresh=gaps', w, h)
  await until(`document.querySelector('.fr-access-row')`, 'the endpoint row')
  await press('.fr-access-row .fr-fix', 'Set up')
  await until(`document.querySelector('.fr-endpoint')`, 'the endpoint form')
  const type = (index, text) =>
    value(`(() => { const box = document.querySelectorAll('.fr-endpoint input')[${index}]; const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(box, ${JSON.stringify(text)}); box.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
  await type(0, 'http://api.example.com')
  await type(1, 'fake-demo-key')
  await type(2, 'example-model-1')
  await sleep(150)
  if (!(await value(`document.body.textContent.includes('We recommend Pi here') && !!document.querySelector('.fr-check input')`))) throw new Error('no word about Claude Code on a third-party endpoint')
  await value(`document.querySelector('.fr-endpoint').requestSubmit()`)
  await until(`document.querySelector('.fr-endpoint .fr-error')`, 'the refusal of plain http')
  await value(`document.querySelector('.fr-endpoint').scrollIntoView({ block: 'center' })`)
  await shot(`${label}-9-endpoint-form`)
  await type(0, 'https://api.example.com')
  await sleep(150)
  await value(`document.querySelector('.fr-endpoint').requestSubmit()`)
  await until(`document.body.textContent.includes('Your agents use api.example.com')`, 'the endpoint saved')
  if (await value(`document.body.textContent.includes('fake-demo-key')`)) throw new Error('the key is on the screen')
  await shot(`${label}-9b-endpoint-saved`)

  // A first task waiting on the agent, with its real terminal to answer in.
  const send = async (agent) => {
    await open(`fresh=green&stage=task&agent=${agent}`, w, h)
    await until(`document.querySelector('.fr-task') && document.querySelector('.fr-example')`, 'the first screen')
    await press('.fr-folder')
    await until(`document.querySelector('.fr-folder.chosen')`, 'the folder')
    await press('.fr-example', 'README')
    await until(`document.querySelector('.cr-prompt input')?.value.includes('README')`, 'the example in the box')
    await value(`document.querySelector('.cr-prompt').requestSubmit()`)
  }
  for (const [agent, name, words] of [['asks', '10-agent-asks', 'question first'], ['signin', '11-agent-sign-in', 'Sign in to'], ['consent', '12-agent-consent', 'Yes, I accept']]) {
    await send(agent)
    await until(`document.querySelector('.fr-wait') && document.body.textContent.includes(${JSON.stringify(words)})`, name)
    await until(`document.querySelector('.fr-wait .xterm-rows')?.textContent.trim().length > 0 || document.querySelector('.fr-wait .xterm-screen')`, 'the live terminal')
    await shot(`${label}-${name}`)
  }
  // From the sign-in, the road: the agent closes, the words come back, the form is there.
  await send('signin')
  await until(`document.querySelector('.fr-wait') && document.body.textContent.includes('Sign in to')`, 'the sign-in wait')
  await press('.fr-go', 'No account?')
  await until(`document.querySelector('.fr-access-row') && document.querySelectorAll('.fr-row').length === 8`, 'the check, with the road')

  // A refused turn: it says failed and why, and no "finished its first task" follows.
  await send('refused')
  await until(`document.body.textContent.includes('API Error: 400')`, 'the refusal on the card')
  await until(`/failed/i.test(document.body.textContent)`, 'the failed status')
  await sleep(3200)
  if (await value(`!!document.querySelector('.fr-hint')`)) throw new Error('a refused turn was called finished')
  await until(`document.querySelector('.fr-back')`, 'the way back from a refused turn')
  await shot(`${label}-14-turn-refused`)
  // The stage did not move: the way back is the first screen, the words in its box, a new agent next.
  await press('.fr-back')
  await until(`document.querySelector('.fr-task') && document.querySelector('.cr-prompt input')?.value.includes('README')`, 'the first screen, words back')
  await until(`document.querySelector('.cr-prompt input')?.placeholder.includes('What should') || !!document.querySelector('.cr-prompt.to-new')`, 'the box on a new agent')
  await shot(`${label}-14b-refused-back-to-first-screen`)

  await send('dies')
  await until(`document.querySelector('.fr-task .fr-error')`, 'the reason the agent stopped')
  await until(`document.querySelector('.cr-prompt input')?.value.includes('README')`, 'the words back in the box')
  await shot(`${label}-13-agent-died-words-back`)
}
writeFileSync(`${out}/probes.json`, JSON.stringify({ probes, problems }, null, 1))
console.log(JSON.stringify({ probes, problems }, null, 1))
page.close()
process.exit(problems.length ? 1 : 0)
