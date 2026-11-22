import { once } from 'node:events'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { build } from 'esbuild'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DESKTOP, launchBrowser, type Browser } from './support/chrome-driver'

// The real useRouteState hook in a real Chrome: the first read fails (a relay
// hiccup at boot), then the host's push arrives. Routing must come back.
const ENTRY = `
import React from 'react'
import { createRoot } from 'react-dom/client'
import { useRouteState } from './src/renderer/src/routing/use-route-state'
import { routeFixture } from './src/shared/route-fixture'
let push = null
window.cookrew = {
  routeState: () => Promise.reject(new Error('relay hiccup')),
  onRoute: (cb) => { push = cb; return () => {} }
}
window.pushRoute = () => push && push(routeFixture())
function Probe() {
  const { available, state } = useRouteState()
  return <p id="probe">{available ? 'available' : 'unavailable'}|{state ? state.status : 'none'}</p>
}
createRoot(document.getElementById('root')).render(<Probe />)
`

const suite = process.env.COOKREW_ROUTE_RECOVERY_E2E === '1' ? describe : describe.skip

suite('routing recovers after a failed first read', () => {
  let server: Server
  let url = ''
  let browser: Browser
  beforeAll(async () => {
    const bundle = await build({ stdin: { contents: ENTRY, loader: 'tsx', resolveDir: process.cwd() }, bundle: true, write: false, platform: 'browser', jsx: 'automatic' })
    const js = bundle.outputFiles[0].contents
    server = createServer((request, response) => {
      if (request.url === '/probe.js') response.writeHead(200, { 'content-type': 'text/javascript' }).end(js)
      else response.writeHead(200, { 'content-type': 'text/html' }).end('<main id="root"></main><script src="/probe.js"></script>')
    })
    await once(server.listen(0, '127.0.0.1'), 'listening')
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`
    browser = await launchBrowser()
  }, 30_000)
  afterAll(async () => {
    try { await browser?.close() } finally { server?.close() }
  })

  it('shows routing again when the next state arrives', async () => {
    const tab = await browser.open(DESKTOP)
    await tab.goto(url)
    await tab.until("document.getElementById('probe')?.textContent === 'unavailable|none'", 'the failed first read')
    await tab.evaluate('window.pushRoute()')
    await tab.until("document.getElementById('probe')?.textContent.startsWith('available|')", 'routing available again')
  }, 30_000)
})
