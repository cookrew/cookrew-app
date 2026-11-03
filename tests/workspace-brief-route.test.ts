// POST /api/workspaces/brief: the phone sets a workspace's brief with the same
// store operation the desktop's IPC uses. A write, so the pairing token only;
// the store's refusal is a 400 in its own words and changes nothing.
import http from 'node:http'
import type net from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { handleMobileApi, type MobileApiDeps } from '../src/main/mobile-api'
import { WorkspaceStore } from '../src/main/store'
import { BRIEF_MAX } from '../src/shared/workspace-brief'

const PAIRING = 'pairing-token-invented'
const WALL = 'wall-token-invented'

describe('POST /api/workspaces/brief', () => {
  const cleanup: Array<() => void> = []
  afterEach(() => {
    for (const run of cleanup.splice(0)) run()
  })

  const start = async (): Promise<{ port: number; store: WorkspaceStore }> => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cookrew-brief-route-'))
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
    const store = new WorkspaceStore(dir)
    // Wired as main/index.ts wires it.
    const ops = {
      setWorkspaceBrief: (id: string, brief: unknown) => {
        store.setWorkspaceBrief(id, brief)
        return store.list()
      }
    }
    const deps = { pairingToken: PAIRING, wallToken: WALL, ops } as unknown as MobileApiDeps
    const server = http.createServer((request, response) => {
      const url = new URL(request.url ?? '/', `http://${request.headers.host}`)
      void handleMobileApi(request, response, url, deps).then((handled) => {
        if (!handled) response.writeHead(404).end()
      })
    })
    cleanup.push(() => server.close())
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    return { port: (server.address() as net.AddressInfo).port, store }
  }

  const post = async (port: number, body: unknown, token?: string) => {
    const response = await fetch(`http://127.0.0.1:${port}/api/workspaces/brief`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body)
    })
    const text = await response.text()
    return { status: response.status, body: text ? JSON.parse(text) : {} }
  }

  const briefOf = (store: WorkspaceStore) => store.list().workspaces.find((w) => w.id === store.focusedId)?.brief

  it('sets the brief with the pairing token and answers the list', async () => {
    const { port, store } = await start()
    const set = await post(port, { id: store.focusedId, brief: '  Invented\nhomelab notes ' }, PAIRING)
    expect(set.status).toBe(200)
    expect(set.body.workspaces.find((w: { id: string }) => w.id === store.focusedId).brief).toBe('Invented homelab notes')
    expect(briefOf(store)).toBe('Invented homelab notes')
  })

  it('refuses without a token and to the read-only wall token, changing nothing', async () => {
    const { port, store } = await start()
    expect((await post(port, { id: store.focusedId, brief: 'invented' })).status).toBe(401)
    expect((await post(port, { id: store.focusedId, brief: 'invented' }, WALL)).status).toBe(401)
    expect(briefOf(store)).toBeUndefined()
  })

  it('answers an invalid brief or an unknown workspace as 400 in the store’s words', async () => {
    const { port, store } = await start()
    const long = await post(port, { id: store.focusedId, brief: 'x'.repeat(BRIEF_MAX + 1) }, PAIRING)
    expect(long.status).toBe(400)
    expect(long.body.error).toBe(`A brief is at most ${BRIEF_MAX} characters`)
    const notText = await post(port, { id: store.focusedId, brief: 42 }, PAIRING)
    expect(notText.status).toBe(400)
    const unknown = await post(port, { id: 'invented-missing', brief: 'notes' }, PAIRING)
    expect(unknown.status).toBe(400)
    expect(unknown.body.error).toContain('not found')
    const noId = await post(port, { brief: 'notes' }, PAIRING)
    expect(noId.status).toBe(400)
    expect(briefOf(store)).toBeUndefined()
  })
})
