// A tab on the shoot Chrome (:9334), with the few verbs the shots need.
//
// NIGHT=1: every tab is drawn at night. The system scheme is emulated as dark, and the app's `data-scheme` is held at
// 'auto' (what the console wears in a browser; the desktop app itself stays light), so its night palette is the one
// drawn (src/renderer/src/color-scheme.ts, night.css).
import { writeFileSync } from 'node:fs'

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
export const NIGHT = process.env.NIGHT === '1'
const HOLD_AUTO = "new MutationObserver(() => { const r = document.documentElement; if (r && r.dataset.scheme && r.dataset.scheme !== 'auto') r.dataset.scheme = 'auto' }).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-scheme'] })"

export async function tab(port = 9334) {
  const t = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json()
  const ws = new WebSocket(t.webSocketDebuggerUrl)
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = () => j(new Error('cdp socket')) })
  let next = 0
  const waiting = new Map()
  const listeners = new Map()
  ws.onmessage = (e) => {
    const m = JSON.parse(String(e.data))
    if (m.id && waiting.has(m.id)) { const w = waiting.get(m.id); waiting.delete(m.id); m.error ? w.j(new Error(m.error.message)) : w.r(m.result) }
    else for (const cb of listeners.get(m.method) ?? []) cb(m.params)
  }
  const send = (method, params = {}) => new Promise((r, j) => { const i = ++next; waiting.set(i, { r, j }); ws.send(JSON.stringify({ id: i, method, params })) })
  const on = (method, cb) => listeners.set(method, [...(listeners.get(method) ?? []), cb])
  const errors = []
  on('Runtime.exceptionThrown', (p) => errors.push((p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text ?? '').slice(0, 300)))
  await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable'); await send('Network.setCacheDisabled', { cacheDisabled: true })
  if (NIGHT) await send('Page.addScriptToEvaluateOnNewDocument', { source: HOLD_AUTO })
  const value = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
    return r.result?.value
  }
  const until = async (expression, label, ms = 15000) => {
    const end = Date.now() + ms
    while (Date.now() < end) { if (await value(`!!(${expression})`).catch(() => false)) return; await sleep(150) }
    throw new Error(`never saw: ${label}`)
  }
  const size = async (width, height, { mobile = false, dsf = 2, scheme = NIGHT ? 'dark' : 'light' } = {}) => {
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: dsf, mobile })
    await send('Emulation.setTouchEmulationEnabled', { enabled: mobile })
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }, { name: 'prefers-reduced-motion', value: 'no-preference' }] })
  }
  const go = async (url) => { await send('Page.navigate', { url }); await sleep(800) }
  const shot = async (file, clip) => {
    const { data } = await send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip: { ...clip, scale: 1 } } : {}) })
    writeFileSync(file, Buffer.from(data, 'base64'))
    return file
  }
  /** A real pointer click at the centre of the first element matching css (and text, when given). */
  const click = async (css, text, { touch = false } = {}) => {
    const at = await value(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(css)})].find((e) => e.getClientRects().length && ${text ? `(e.textContent || e.getAttribute('aria-label') || '').includes(${JSON.stringify(text)})` : 'true'}); if (!el) return null; el.scrollIntoView({ block: 'nearest' }); const b = el.getBoundingClientRect(); return [b.left + b.width / 2, b.top + b.height / 2] })()`)
    if (!at) throw new Error(`nothing to click: ${css} ${text ?? ''}`)
    await clickAt(at[0], at[1], { touch })
    return at
  }
  const clickAt = async (x, y, { touch = false } = {}) => {
    if (touch) {
      await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] })
      await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      return
    }
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
  }
  const key = async (k, code = k) => {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: k === 'Escape' ? 27 : k === 'Enter' ? 13 : 0 })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: k === 'Escape' ? 27 : k === 'Enter' ? 13 : 0 })
  }
  const close = async () => { ws.close(); await fetch(`http://127.0.0.1:${port}/json/close/${t.id}`) }
  return { send, on, value, until, size, go, shot, click, clickAt, key, close, errors }
}
