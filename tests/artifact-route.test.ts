// GET /api/artifact/<id> (mobile-api.ts): a device draws an artifact itself.
// The read gate is the same one every other read uses, and what may leave the
// computer is decided in main/artifact-view.ts.
import { EventEmitter } from 'node:events'
import http from 'node:http'
import type net from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { handleMobileApi, type MobileApiDeps } from '../src/main/mobile-api'

const TOKEN = 'artifact-pairing'

function workspace() {
  return {
    name: 'W', dir: '/tmp', dirs: ['/tmp'], connections: [],
    nodes: [
      { kind: 'note', id: 'note1', name: 'note1', customName: null, content: '# Done\n\nall good', locked: false, position: { x: 0, y: 0 }, size: { width: 1, height: 1 } },
      { kind: 'browser', id: 'link1', name: 'link1', url: 'https://example.com/report', tabs: [{ id: 't', url: 'https://example.com/report', title: '' }], activeTabId: 't', position: { x: 0, y: 0 }, size: { width: 1, height: 1 } }
    ]
  }
}

const servers: http.Server[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve())
    server.closeAllConnections()
  })))
})

async function start() {
  const state = workspace()
  const deps = {
    pairingToken: TOKEN,
    store: Object.assign(new EventEmitter(), { focusedState: state, workspaceState: () => state }),
    turns: Object.assign(new EventEmitter(), { list: () => [] }),
    ops: { listWorkspaces: () => ({ workspaces: [], activeId: 'w' }) }
  } as unknown as MobileApiDeps
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host}`)
    void handleMobileApi(request, response, url, deps).then((served) => {
      if (!served) response.writeHead(404).end()
    })
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`
}

const auth = { authorization: `Bearer ${TOKEN}` }

describe('GET /api/artifact/<id>', () => {
  it('sends a note as markdown to a paired device', async () => {
    const origin = await start()
    const response = await fetch(`${origin}/api/artifact/note1`, { headers: auth })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ kind: 'note', name: 'note1', title: 'Done', markdown: '# Done\n\nall good' })
  })

  it('hands a web page over as a link, not as bytes', async () => {
    const origin = await start()
    const response = await fetch(`${origin}/api/artifact/link1`, { headers: auth })
    expect(await response.json()).toEqual({ kind: 'link', name: 'link1', url: 'https://example.com/report' })
  })

  it('refuses an unpaired reader and an unknown card', async () => {
    const origin = await start()
    expect((await fetch(`${origin}/api/artifact/note1`)).status).toBe(401)
    expect((await fetch(`${origin}/api/artifact/nope`, { headers: auth })).status).toBe(404)
  })
})
