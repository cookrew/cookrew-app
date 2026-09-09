/**
 * Desktop-surface QA for lineage reach (fix/lineage-checkpoint-reach).
 * Drives the REAL Electron renderer over --remote-debugging-port=9333:
 *
 *   node qa-lineage-desktop.mjs eval '<js>'      evaluate in the app window
 *   node qa-lineage-desktop.mjs tap <x> <y>      real Input.dispatchMouseEvent
 *   node qa-lineage-desktop.mjs shot <out.png>   screenshot the window
 */
import { writeFileSync } from 'node:fs'
import { connectCdp } from './qa-cdp-driver.mjs'

const CDP = 'http://127.0.0.1:9333'

async function appPage() {
  const list = await fetch(`${CDP}/json/list`).then((r) => r.json())
  const page = list.find((p) => p.type === 'page' && p.title === 'Cookrew')
  if (!page) throw new Error('no Cookrew page on 9333')
  return page
}

const [, , cmd, ...args] = process.argv
const page = await appPage()
const cdp = await connectCdp(page.webSocketDebuggerUrl)

if (cmd === 'eval') {
  const result = await cdp.send('Runtime.evaluate', {
    expression: args[0],
    returnByValue: true,
    awaitPromise: true
  })
  console.log(JSON.stringify(result.result?.value ?? result, null, 1))
} else if (cmd === 'tap') {
  const [x, y] = [Number(args[0]), Number(args[1])]
  for (const type of ['mousePressed', 'mouseReleased']) {
    await cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 })
  }
  console.log(`tapped ${x},${y}`)
} else if (cmd === 'shot') {
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(args[0], Buffer.from(shot.data, 'base64'))
  console.log(`saved ${args[0]}`)
} else {
  console.log('usage: eval|tap|shot')
}
cdp.close()
// (appended) wheel command handled above via re-run; noop
