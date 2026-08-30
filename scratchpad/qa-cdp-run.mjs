/**
 * One CDP step against the QA Chrome on :9245. Stateless per invocation so a
 * QA session is a sequence of small auditable steps:
 *
 *   node qa-cdp-run.mjs open <url-or-COMPANION> [phone]   navigate (device-emulated if phone)
 *   node qa-cdp-run.mjs shot <out.png>                    screenshot current page
 *   node qa-cdp-run.mjs eval '<js>'                       evaluate in page, print result
 *   node qa-cdp-run.mjs tap <x> <y>                       real Input.dispatchMouseEvent tap
 *
 * COMPANION expands to the local companion URL with the token read from disk —
 * the token never appears on the command line or in output.
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { connectCdp } from './qa-cdp-driver.mjs'

const CDP = 'http://127.0.0.1:9245'

/**
 * COMPANION → the desktop's own companion. SLICE → a worktree build served by
 * slice-serve.mjs on :8646, proxying the same desktop. Same token flow for
 * both; the token is read from disk and never printed.
 */
function companionUrl(target = 'COMPANION') {
  const origin = target === 'SLICE' ? 'http://127.0.0.1:8646' : 'https://127.0.0.1:8643'
  const candidates = [join(homedir(), '.cookrew/pairing-token')]
  for (const path of candidates) {
    try {
      const token = readFileSync(path, 'utf8').trim()
      if (token) return `${origin}/?token=${encodeURIComponent(token)}`
    } catch {
      /* try the next location */
    }
  }
  throw new Error('no desktop token found on disk')
}

async function firstPage() {
  const list = await fetch(`${CDP}/json/list`).then((r) => r.json())
  const page = list.find((t) => t.type === 'page')
  if (!page) throw new Error('no page target — is the QA chrome running?')
  return page
}

const [, , command, ...rest] = process.argv
const page = await firstPage()
const cdp = await connectCdp(page.webSocketDebuggerUrl)

try {
  if (command === 'open') {
    const url =
      rest[0] === 'COMPANION' || rest[0] === 'SLICE' ? companionUrl(rest[0]) : rest[0]
    await cdp.send('Page.enable')
    if (rest[1] === 'phone') {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: 390,
        height: 844,
        deviceScaleFactor: 2,
        mobile: true
      })
      await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true })
    }
    await cdp.send('Page.navigate', { url })
    await cdp.waitForEvent('Page.loadEventFired', 25000).catch(() => {})
    console.log('opened', url.split('token=')[0] + (url.includes('token=') ? 'token=REDACTED' : ''))
  } else if (command === 'shot') {
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(rest[0], Buffer.from(data, 'base64'))
    console.log('saved', rest[0])
  } else if (command === 'eval') {
    const { result, exceptionDetails } = await cdp.send('Runtime.evaluate', {
      expression: rest[0],
      returnByValue: true,
      awaitPromise: true
    })
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? 'eval failed')
    console.log(JSON.stringify(result.value, null, 1))
  } else if (command === 'wheel') {
    // Zoom the canvas: real wheel input at (x, y), deltaY per tick, n ticks.
    const [x, y, deltaY, ticks] = rest.map(Number)
    for (let i = 0; i < (ticks || 1); i++) {
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x,
        y,
        deltaX: 0,
        deltaY,
        modifiers: 2 // ctrl — pinch-zoom semantics for ReactFlow
      })
      await new Promise((r) => setTimeout(r, 120))
    }
    console.log('wheeled', ticks || 1, 'ticks of', deltaY)
  } else if (command === 'scrub') {
    // Press at (x, y1), drag to (x, y2) in steps, release — a rail scrub.
    const [x, y1, y2] = rest.map(Number)
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x,
      y: y1,
      button: 'left',
      clickCount: 1
    })
    const steps = 8
    for (let i = 1; i <= steps; i++) {
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x,
        y: y1 + ((y2 - y1) * i) / steps,
        button: 'left'
      })
      await new Promise((r) => setTimeout(r, 60))
    }
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y: y2, button: 'left' })
    console.log('scrubbed', y1, '→', y2)
  } else if (command === 'tap') {
    const [x, y] = [Number(rest[0]), Number(rest[1])]
    for (const type of ['mousePressed', 'mouseReleased']) {
      await cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 })
    }
    console.log('tapped', x, y)
  } else {
    throw new Error(`unknown command: ${command}`)
  }
} finally {
  cdp.close()
}
