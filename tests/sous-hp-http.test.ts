// THE HP ROUTES: a needs-ack commit is 428, RETRY and DISMISS act on a sous row
// by its token (owner token only), and a read-only (wall) token sees the
// projection of the inbox — kind, card, waited-for — on the GET and the stream.
import http from 'node:http'
import type net from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { handleMobileApi, type MobileApiDeps } from '../src/main/mobile-api'
import type { InboxRow } from '../src/shared/inbox-rank'

const TOKEN = 'pairing-token-123'
const WALL = 'wall-token-456'

const row: InboxRow = {
  nodeId: 'forge',
  nodeName: 'Forge',
  nodeKind: 'terminal',
  workspaceId: 'ws',
  workspaceName: 'Dev',
  kind: 'sous',
  kinds: ['sous'],
  reasons: ["Sous's brief interrupted — retry"],
  since: 1,
  waitMinutes: 3,
  served: false,
  blockedDownstream: 0,
  score: 1,
  action: 'retry',
  dismissable: true,
  id: 'tok-1',
  text: 'push the branch\n\nBoundaries: push only after the check passes'
}

describe('HP routes', () => {
  const cleanup: Array<() => void> = []
  afterEach(() => {
    for (const run of cleanup.splice(0)) run()
  })

  const startApi = async () => {
    const acted: string[] = []
    const dismissed: string[] = []
    const deps = {
      pairingToken: TOKEN,
      wallToken: WALL,
      turns: { list: () => [] },
      inbox: () => [row],
      inboxAct: async (id: string) => {
        acted.push(id)
        return id === 'tok-1' ? { ok: true, dispatchId: 'd9' } : { ok: false, error: 'no such proposal' }
      },
      inboxDismiss: (id: string) => {
        dismissed.push(id)
        return id === 'tok-1'
      },
      sous: {
        handle: async () => ({ intent: 'none', spoken: '' }),
        commit: async (_t: string, choice: { ack?: string }) => (choice.ack === 'send-anyway' ? { intent: 'ask', spoken: 'Sent to Forge' } : { intent: 'refused', spoken: 'needs ack', error: 'needs-ack' }),
        cancel: () => true
      }
    } as unknown as MobileApiDeps
    const server = http.createServer((request, response) => {
      const url = new URL(request.url ?? '/', `http://${request.headers.host}`)
      void handleMobileApi(request, response, url, deps).then((handled) => {
        if (!handled) response.writeHead(404).end()
      })
    })
    cleanup.push(() => server.close())
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    return { port: (server.address() as net.AddressInfo).port, acted, dismissed }
  }

  const call = async (port: number, path: string, init: { method?: string; body?: unknown; token?: string } = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: init.method ?? 'GET',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${init.token ?? TOKEN}` },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) })
    })
    const text = await response.text()
    return { status: response.status, body: (text ? JSON.parse(text) : {}) as Record<string, unknown> }
  }

  it('a plain commit of an exposure-2 decision is 428; the ack goes through', async () => {
    const api = await startApi()
    expect((await call(api.port, '/api/sous/commit', { method: 'POST', body: { token: 'tok' } })).status).toBe(428)
    expect((await call(api.port, '/api/sous/commit', { method: 'POST', body: { token: 'tok', ack: 'send-anyway' } })).status).toBe(200)
  })

  it('RETRY and DISMISS take the row token; a stranger token is refused; the wall token cannot act', async () => {
    const api = await startApi()
    expect(await call(api.port, '/api/inbox/tok-1/act', { method: 'POST', body: {} })).toMatchObject({ status: 200, body: { ok: true, dispatchId: 'd9' } })
    expect((await call(api.port, '/api/inbox/nope/act', { method: 'POST', body: {} })).status).toBe(409)
    expect((await call(api.port, '/api/inbox/tok-1/dismiss', { method: 'POST', body: {} })).status).toBe(200)
    expect((await call(api.port, '/api/inbox/nope/dismiss', { method: 'POST', body: {} })).status).toBe(404)
    expect((await call(api.port, '/api/inbox/tok-1/act', { method: 'POST', body: {}, token: WALL })).status).toBe(401)
    expect(api.acted).toEqual(['tok-1', 'nope'])
    expect(api.dismissed).toEqual(['tok-1', 'nope'])
  })

  it('the owner reads the whole row; the wall reads kind, card and waited-for only', async () => {
    const api = await startApi()
    const owner = await call(api.port, '/api/inbox')
    expect((owner.body.rows as InboxRow[])[0]).toMatchObject({ text: row.text, id: 'tok-1', action: 'retry' })
    const wall = await call(api.port, '/api/inbox', { token: WALL })
    expect(wall.status).toBe(200)
    expect((wall.body.rows as unknown[])[0]).toEqual({ nodeId: 'forge', nodeName: 'Forge', nodeKind: 'terminal', kind: 'sous', kinds: ['sous'], since: 1, waitMinutes: 3 })
    expect(JSON.stringify(wall.body)).not.toMatch(/Boundaries|retry|tok-1/)
  })
})
