// THE SHARED FOLDERS OVER HTTP (mobile-api.ts): roots, a listing, a file's
// bytes — to a paired device only, and only inside what this computer shares.
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import type net from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { handleMobileApi, type MobileApiDeps } from '../src/main/mobile-api'

const TOKEN = 'files-pairing'
const made: string[] = []
const servers: http.Server[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve())
    server.closeAllConnections()
  })))
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
})

async function start() {
  const base = mkdtempSync(path.join(tmpdir(), 'files-routes-'))
  made.push(base)
  const workspace = path.join(base, 'work')
  const shared = path.join(base, 'shared')
  const secret = path.join(base, 'secret')
  for (const dir of [workspace, shared, secret]) mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(workspace, 'in-workspace.txt'), 'w')
  writeFileSync(path.join(shared, 'report.html'), '<h1>r</h1>')
  writeFileSync(path.join(secret, 'private.txt'), 'no')
  const state = { name: 'W', dir: workspace, dirs: [workspace], nodes: [], connections: [] }
  const deps = {
    pairingToken: TOKEN,
    sharedFolders: () => [shared, secret],
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
  return { origin: `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`, workspace, shared, secret }
}

const auth = { authorization: `Bearer ${TOKEN}` }

describe('GET /api/files/*', () => {
  it('lists the workspace’s folders and the owner’s shared ones, to a paired device', async () => {
    const { origin, workspace, shared, secret } = await start()
    const response = await fetch(`${origin}/api/files/roots`, { headers: auth })
    expect(response.status).toBe(200)
    const body = (await response.json()) as { roots: { path: string; name: string }[] }
    expect(body.roots.map((r) => r.path)).toEqual([workspace, shared, secret])
    expect(body.roots.map((r) => r.name)).toEqual(['work', 'shared', 'secret'])
  })

  it('lists a folder inside a shared root', async () => {
    const { origin, shared } = await start()
    const response = await fetch(`${origin}/api/files/list?root=${encodeURIComponent(shared)}&path=`, { headers: auth })
    expect(response.status).toBe(200)
    const body = (await response.json()) as { entries: { name: string; kind: string }[] }
    expect(body.entries.find((e) => e.name === 'report.html')?.kind).toBe('file')
  })

  it('sends a file with its type and an ETag', async () => {
    const { origin, shared } = await start()
    const response = await fetch(`${origin}/api/files/raw?root=${encodeURIComponent(shared)}&path=report.html`, { headers: auth })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(response.headers.get('etag')).toMatch(/^"[0-9a-f]{64}"$/)
    expect(await response.text()).toBe('<h1>r</h1>')
  })

  it('refuses an unpaired reader', async () => {
    const { origin, shared } = await start()
    for (const at of ['/api/files/roots', `/api/files/list?root=${encodeURIComponent(shared)}&path=`, `/api/files/raw?root=${encodeURIComponent(shared)}&path=report.html`]) {
      expect((await fetch(`${origin}${at}`)).status).toBe(401)
    }
  })

  it('refuses a root that is not shared (403) and a path outside it', async () => {
    const { origin, workspace } = await start()
    const outside = await fetch(`${origin}/api/files/raw?root=${encodeURIComponent(workspace)}&path=../secret/private.txt`, { headers: auth })
    expect(outside.status).toBe(403)
    const unknown = await fetch(`${origin}/api/files/list?root=${encodeURIComponent('/nope')}&path=`, { headers: auth })
    expect(unknown.status).toBe(403)
  })

  it('says a missing file is missing', async () => {
    const { origin, shared } = await start()
    const response = await fetch(`${origin}/api/files/raw?root=${encodeURIComponent(shared)}&path=gone.txt`, { headers: auth })
    expect(response.status).toBe(404)
    expect(((await response.json()) as { why: string }).why).toContain('no longer')
  })
})
