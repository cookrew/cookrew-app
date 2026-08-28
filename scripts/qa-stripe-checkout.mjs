#!/usr/bin/env node
/**
 * Real-input drive for Stripe-hosted Checkout through QA Chrome on CDP :9245.
 *
 * The Checkout URL is a capability. Keep it out of argv and logs by writing it
 * to a 0600 file and passing only that path:
 *
 *   node scripts/qa-stripe-checkout.mjs --url-file /private/tmp/checkout-url
 */

import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const args = process.argv.slice(2)
const option = (name, fallback = null) => {
  const index = args.indexOf(`--${name}`)
  return index === -1 ? fallback : args[index + 1]
}

if (args.includes('--help')) {
  console.log('usage: qa-stripe-checkout.mjs --url-file PATH [--shot PATH] [--timeout MS]')
  process.exit(0)
}

const urlFile = option('url-file')
const screenshotPath = option('shot')
const timeoutMs = Number(option('timeout', '90000'))
const cdpOrigin = 'http://127.0.0.1:9245'

if (!urlFile || !Number.isFinite(timeoutMs) || timeoutMs < 1000) {
  console.error('FAIL: --url-file and a valid --timeout are required')
  process.exit(2)
}
if ((statSync(urlFile).mode & 0o077) !== 0) {
  throw new Error('Checkout URL file must be private (0600)')
}
const checkoutUrl = readFileSync(urlFile, 'utf8').trim()
const checkout = new URL(checkoutUrl)
if (
  checkout.protocol !== 'https:' ||
  !['checkout.stripe.com', 'pay.stripe.com'].includes(checkout.hostname)
) {
  throw new Error('Refusing to navigate anywhere except Stripe-hosted Checkout')
}

class CdpClient {
  constructor(socket) {
    this.socket = socket
    this.nextId = 1
    this.pending = new Map()
    this.sessionsByTarget = new Map()
    this.enabledSessions = new Set()
    socket.addEventListener('message', (event) => this.#onMessage(event.data))
  }

  static async connect(url) {
    const socket = new WebSocket(url)
    await new Promise((resolveOpen, rejectOpen) => {
      socket.addEventListener('open', resolveOpen, { once: true })
      socket.addEventListener(
        'error',
        () => rejectOpen(new Error('QA Chrome CDP connection failed')),
        { once: true }
      )
    })
    return new CdpClient(socket)
  }

  #onMessage(raw) {
    const message = JSON.parse(String(raw))
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      clearTimeout(pending.timer)
      if (message.error) pending.reject(new Error(message.error.message))
      else pending.resolve(message.result)
      return
    }
    if (message.method === 'Target.attachedToTarget') {
      this.sessionsByTarget.set(message.params.targetInfo.targetId, message.params.sessionId)
    }
    if (message.method === 'Target.detachedFromTarget') {
      this.enabledSessions.delete(message.params.sessionId)
      for (const [targetId, sessionId] of this.sessionsByTarget) {
        if (sessionId === message.params.sessionId) this.sessionsByTarget.delete(targetId)
      }
    }
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId++
    this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
    return new Promise((resolveSend, rejectSend) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        rejectSend(new Error(`CDP command timed out: ${method}`))
      }, 30000)
      this.pending.set(id, { resolve: resolveSend, reject: rejectSend, timer })
    })
  }

  close() {
    this.socket.close()
  }
}

const attributesOf = (node) => {
  const attrs = {}
  for (let i = 0; i < (node.attributes?.length ?? 0); i += 2) {
    attrs[node.attributes[i].toLowerCase()] = node.attributes[i + 1] ?? ''
  }
  return attrs
}
const normalize = (value) => value.toLowerCase().replace(/[^a-z0-9]+/g, ' ')

const scoreField = (kind, node) => {
  if (node.nodeName !== 'INPUT') return -1
  const attrs = attributesOf(node)
  const haystack = normalize(
    [attrs.name, attrs.id, attrs['aria-label'], attrs.placeholder, attrs.autocomplete].join(' ')
  )
  const autocomplete = {
    email: 'email',
    card: 'cc-number',
    expiry: 'cc-exp',
    cvc: 'cc-csc',
    name: 'cc-name',
    postal: 'postal-code'
  }[kind]
  const words = {
    email: ['email'],
    card: ['card number', 'cardnumber'],
    expiry: ['expiry', 'expiration', 'exp date'],
    cvc: ['cvc', 'cvv', 'security code'],
    name: ['cardholder name', 'name on card', 'billing name'],
    postal: ['postal', 'zip']
  }[kind]
  let score = attrs.autocomplete === autocomplete ? 100 : 0
  for (const word of words) if (haystack.includes(word)) score += 20
  return score
}

async function attachTargets(cdp) {
  const { targetInfos } = await cdp.send('Target.getTargets')
  for (const target of targetInfos) {
    if (!['page', 'iframe'].includes(target.type) || cdp.sessionsByTarget.has(target.targetId)) {
      continue
    }
    try {
      const { sessionId } = await cdp.send('Target.attachToTarget', {
        targetId: target.targetId,
        flatten: true
      })
      cdp.sessionsByTarget.set(target.targetId, sessionId)
    } catch {
      // Checkout swaps secure frames while loading; a vanished target is normal.
    }
  }
  for (const sessionId of cdp.sessionsByTarget.values()) {
    if (cdp.enabledSessions.has(sessionId)) continue
    try {
      await Promise.all([
        cdp.send('Page.enable', {}, sessionId).catch(() => {}),
        cdp.send('DOM.enable', {}, sessionId),
        cdp.send('Runtime.enable', {}, sessionId)
      ])
      cdp.enabledSessions.add(sessionId)
    } catch {
      // The next discovery pass will retry any target that is still alive.
    }
  }
}

async function nodesIn(cdp, sessionId) {
  try {
    const { nodes } = await cdp.send(
      'DOM.getFlattenedDocument',
      { depth: -1, pierce: true },
      sessionId
    )
    return nodes
  } catch {
    return []
  }
}

async function findField(cdp, kind) {
  await attachTargets(cdp)
  let best = null
  for (const sessionId of cdp.sessionsByTarget.values()) {
    for (const node of await nodesIn(cdp, sessionId)) {
      const score = scoreField(kind, node)
      if (score > 0 && (!best || score > best.score)) {
        best = { sessionId, nodeId: node.nodeId, score }
      }
    }
  }
  return best
}

async function clearAndType(cdp, field, text) {
  await cdp.send('DOM.focus', { nodeId: field.nodeId }, field.sessionId)
  await cdp.send(
    'Input.dispatchKeyEvent',
    { type: 'rawKeyDown', key: 'a', code: 'KeyA', modifiers: 4 },
    field.sessionId
  )
  await cdp.send(
    'Input.dispatchKeyEvent',
    { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 4 },
    field.sessionId
  )
  await cdp.send(
    'Input.dispatchKeyEvent',
    { type: 'keyDown', key: 'Backspace', code: 'Backspace' },
    field.sessionId
  )
  await cdp.send(
    'Input.dispatchKeyEvent',
    { type: 'keyUp', key: 'Backspace', code: 'Backspace' },
    field.sessionId
  )
  await cdp.send('Input.insertText', { text }, field.sessionId)
  await cdp.send(
    'Input.dispatchKeyEvent',
    { type: 'keyDown', key: 'Tab', code: 'Tab' },
    field.sessionId
  )
  await cdp.send(
    'Input.dispatchKeyEvent',
    { type: 'keyUp', key: 'Tab', code: 'Tab' },
    field.sessionId
  )
}

async function fill(cdp, kind, value, required) {
  const waitMs = required ? Math.min(timeoutMs, 60000) : 3000
  const deadline = Date.now() + waitMs
  for (;;) {
    const field = await findField(cdp, kind)
    if (field) {
      await clearAndType(cdp, field, value)
      return true
    }
    if (Date.now() >= deadline) {
      if (required) throw new Error(`Stripe Checkout did not expose the ${kind} field`)
      return false
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 300))
  }
}

async function findSubmit(cdp) {
  await attachTargets(cdp)
  for (const sessionId of cdp.sessionsByTarget.values()) {
    for (const node of await nodesIn(cdp, sessionId)) {
      if (!['BUTTON', 'INPUT'].includes(node.nodeName)) continue
      const attrs = attributesOf(node)
      if (attrs.disabled !== undefined) continue
      const outer = await cdp
        .send('DOM.getOuterHTML', { nodeId: node.nodeId }, sessionId)
        .then((result) => normalize(result.outerHTML))
        .catch(() => '')
      if (attrs.type === 'submit' || /\b(pay|submit|complete)\b/.test(outer)) {
        return { sessionId, nodeId: node.nodeId }
      }
    }
  }
  return null
}

async function submit(cdp) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const button = await findSubmit(cdp)
    if (button) {
      await cdp.send('DOM.focus', { nodeId: button.nodeId }, button.sessionId)
      await cdp.send(
        'Input.dispatchKeyEvent',
        { type: 'keyDown', key: 'Enter', code: 'Enter' },
        button.sessionId
      )
      await cdp.send(
        'Input.dispatchKeyEvent',
        { type: 'keyUp', key: 'Enter', code: 'Enter' },
        button.sessionId
      )
      return
    }
    if (Date.now() >= deadline) throw new Error('Stripe Checkout submit control was not available')
    await new Promise((resolveWait) => setTimeout(resolveWait, 300))
  }
}

async function pageLocation(cdp, sessionId) {
  const { result } = await cdp.send(
    'Runtime.evaluate',
    { expression: 'location.href', returnByValue: true },
    sessionId
  )
  return typeof result.value === 'string' ? result.value : ''
}

async function waitForCheckoutExit(cdp, pageSession) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const current = await pageLocation(cdp, pageSession).catch(() => '')
    if (current) {
      const hostname = new URL(current).hostname
      if (!['checkout.stripe.com', 'pay.stripe.com'].includes(hostname)) return hostname
    }
    if (Date.now() >= deadline) throw new Error('Stripe Checkout did not reach its return page')
    await new Promise((resolveWait) => setTimeout(resolveWait, 500))
  }
}

let cdp
try {
  const version = await fetch(`${cdpOrigin}/json/version`).then((response) => {
    if (!response.ok) throw new Error('QA Chrome is not listening on port 9245')
    return response.json()
  })
  cdp = await CdpClient.connect(version.webSocketDebuggerUrl)
  await cdp.send('Target.setAutoAttach', {
    autoAttach: true,
    waitForDebuggerOnStart: false,
    flatten: true
  })
  await attachTargets(cdp)
  const pageTarget = (await cdp.send('Target.getTargets')).targetInfos.find(
    (target) => target.type === 'page'
  )
  if (!pageTarget) throw new Error('QA Chrome has no page target')
  const pageSession = cdp.sessionsByTarget.get(pageTarget.targetId)
  if (!pageSession) throw new Error('Could not attach to the QA Chrome page')

  await cdp.send('Page.navigate', { url: checkoutUrl }, pageSession)
  await fill(cdp, 'email', 'qa-payment@cookrew.invalid', false)
  await fill(cdp, 'card', '4242424242424242', true)
  await fill(cdp, 'expiry', '1234', true)
  await fill(cdp, 'cvc', '123', true)
  await fill(cdp, 'name', 'Cookrew QA', false)
  await fill(cdp, 'postal', '94107', false)
  await submit(cdp)

  const returnHost = await waitForCheckoutExit(cdp, pageSession)
  if (screenshotPath) {
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }, pageSession)
    writeFileSync(resolve(screenshotPath), Buffer.from(data, 'base64'), { mode: 0o600 })
  }
  console.log(`PASS: hosted Checkout completed and returned to ${returnHost}`)
} finally {
  cdp?.close()
}
