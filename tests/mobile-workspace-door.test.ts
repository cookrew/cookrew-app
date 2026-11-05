// The phone's door to workspaces, over the real route and a real store: what a
// phone is told, what it may not do, and above all that nothing it does moves
// the desktop (box user test 2, bugs 5 and 10; ruling 11-04).
import http from 'node:http'
import type net from 'node:net'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { handleMobileApi, type MobileApiDeps } from '../src/main/mobile-api'
import { WorkspaceStore } from '../src/main/store'
import { openWorkspace, workspaceCheck } from '../src/main/workspace-door'
import { SEAT_GONE } from '../src/shared/workspace-door'

const TOKEN = 'pairing-token-invented'

describe('the phone and workspaces', () => {
  const cleanup: Array<() => void> = []
  afterEach(() => {
    for (const run of cleanup.splice(0)) run()
  })

  const start = async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'cookrew-door-route-'))
    cleanup.push(() => rmSync(root, { recursive: true, force: true }))
    const folder = path.join(root, 'proj')
    mkdirSync(folder)
    const file = path.join(root, 'file.txt')
    writeFileSync(file, 'x')
    const store = new WorkspaceStore(path.join(root, 'data'), { multiInstance: true })
    const switched = vi.fn()
    store.on('switch', switched)
    const seed = vi.fn()
    // Wired as main/index.ts wires it.
    const ops = {
      listWorkspaces: () => store.list(),
      checkWorkspace: (name: string, dir: string) => workspaceCheck(store, name, dir),
      createWorkspace: (name: string, dir: string, _team: string | undefined, options: { stay?: boolean }) =>
        openWorkspace(store, { name, dir, stay: options.stay === true, seed }),
      switchWorkspace: (id: string) => store.switchWorkspace(id),
      renameWorkspace: (id: string, name: string) => {
        store.renameWorkspace(id, name)
        return store.list()
      },
      setWorkspaceIcon: (id: string, icon: unknown) => {
        store.setWorkspaceIcon(id, icon)
        return store.list()
      }
    }
    const turns = { list: () => [], on: () => undefined, removeListener: () => undefined }
    const deps = { store, turns, pairingToken: TOKEN, ops } as unknown as MobileApiDeps
    const server = http.createServer((request, response) => {
      const url = new URL(request.url ?? '/', `http://${request.headers.host}`)
      void handleMobileApi(request, response, url, deps).then((handled) => {
        if (!handled) response.writeHead(404).end()
      })
    })
    cleanup.push(() => {
      server.closeAllConnections()
      server.close()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as net.AddressInfo).port
    const call = async (method: string, route: string, body?: unknown) => {
      const response = await fetch(`http://127.0.0.1:${port}${route}`, {
        method,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      })
      const text = await response.text()
      return { status: response.status, body: text ? JSON.parse(text) : {} }
    }
    return { store, call, folder, file, root, port, switched, seed }
  }

  it('refuses a missing folder with a sentence and makes nothing', async () => {
    const { store, call, root } = await start()
    const before = store.list().workspaces.length
    const missing = path.join(root, 'nope')
    const made = await call('POST', '/api/workspaces', { name: 'Ghost', dir: missing })
    expect(made.status).toBe(400)
    expect(made.body.error).toBe(`There is no folder at ${missing}. Choose one that exists.`)
    expect(store.list().workspaces).toHaveLength(before)
  })

  it('refuses a file with a sentence and makes nothing', async () => {
    const { store, call, file } = await start()
    const before = store.list().workspaces.length
    const made = await call('POST', '/api/workspaces', { name: 'FileDir', dir: file })
    expect(made.status).toBe(400)
    expect(made.body.error).toBe(`${file} is a file, not a folder. Choose a folder.`)
    expect(store.list().workspaces).toHaveLength(before)
  })

  it('checks before making, and the check makes nothing', async () => {
    const { store, call, folder } = await start()
    const name = store.focusedMeta()?.name ?? ''
    const before = store.list().workspaces.length
    const checked = await call('POST', '/api/workspaces/check', { name, dir: folder })
    expect(checked.status).toBe(200)
    expect(checked.body.ok).toBe(true)
    expect(checked.body.notes[0]).toContain('is taken')
    expect(store.list().workspaces).toHaveLength(before)
  })

  it('makes a workspace without moving the desktop, and seeds it', async () => {
    const { store, call, folder, switched, seed } = await start()
    const desk = store.focusedId
    const made = await call('POST', '/api/workspaces', { name: 'Beta', dir: folder })
    expect(made.status).toBe(200)
    expect(store.focusedId).toBe(desk)
    expect(switched).not.toHaveBeenCalled()
    expect(seed).toHaveBeenCalledWith(made.body.id)
    // The seat rides on the answer: one trip, so nothing can fail after the create.
    expect(made.body.seat).toBe(made.body.id)
  })

  it('a phone choosing a workspace does not move the desktop', async () => {
    const { store, call, folder, switched } = await start()
    const desk = store.focusedId
    const other = store.createWorkspace('Other', folder).id
    const chose = await call('POST', '/api/workspaces/switch', { id: other })
    expect(chose.status).toBe(200)
    expect(chose.body.activeId).toBe(other)
    expect(chose.body.seat).toBe(other)
    expect(store.focusedId).toBe(desk)
    expect(switched).not.toHaveBeenCalled()
  })

  it('refuses a seat on a workspace that does not exist', async () => {
    const { call } = await start()
    expect((await call('POST', '/api/workspaces/switch', { id: 'nope' })).status).toBe(404)
  })

  it('answers for the phone\'s seat, whatever the desktop shows', async () => {
    const { store, call, folder } = await start()
    const desk = store.focusedId
    const other = store.createWorkspace('Other', folder).id
    const seated = await call('GET', `/api/workspaces?seat=${other}`)
    expect(seated.body.activeId).toBe(other)
    expect((await call('GET', '/api/workspaces')).body.activeId).toBe(desk)
  })

  it('falls back to the desktop\'s workspace for a seat that has gone', async () => {
    const { store, call } = await start()
    const seated = await call('GET', '/api/workspaces?seat=gone')
    expect(seated.body.activeId).toBe(store.focusedId)
  })

  it('refuses a write from a seat that has gone: it must not land on the desktop\'s canvas', async () => {
    const { store, call, folder } = await start()
    const gone = store.createWorkspace('Gone', folder).id
    store.removeWorkspace(gone)
    const refused = await call('POST', `/api/workspaces/rename?seat=${gone}`, { id: store.focusedId, name: 'Oops' })
    expect(refused.status).toBe(409)
    expect(refused.body.error).toBe(SEAT_GONE)
    expect(store.focusedMeta()?.name).not.toBe('Oops')
  })

  it('still lets a phone on a seat that has gone choose another', async () => {
    const { store, call, folder } = await start()
    const gone = store.createWorkspace('Gone', folder).id
    const next = store.createWorkspace('Next', folder).id
    store.removeWorkspace(gone)
    const chose = await call('POST', `/api/workspaces/switch?seat=${gone}`, { id: next })
    expect(chose.status).toBe(200)
    expect(chose.body.seat).toBe(next)
  })

  it('renames and refuses with a sentence', async () => {
    const { store, call } = await start()
    const id = store.focusedId
    const blank = await call('POST', '/api/workspaces/rename', { id, name: '   ' })
    expect(blank.status).toBe(400)
    expect(blank.body.error).toBe('Give the workspace a name.')
    expect((await call('POST', '/api/workspaces/rename', { id, name: 'Named' })).status).toBe(200)
    expect(store.focusedMeta()?.name).toBe('Named')
  })

  it('sets an icon and refuses a word', async () => {
    const { store, call } = await start()
    const id = store.focusedId
    expect((await call('POST', '/api/workspaces/icon', { id, icon: '🚀' })).body.workspaces[0].icon).toBe('🚀')
    expect((await call('POST', '/api/workspaces/icon', { id, icon: 'rocket ship' })).status).toBe(400)
  })

  it('tells a seated stream its own workspace is active, and nobody else\'s', async () => {
    const { store, port, folder } = await start()
    const other = store.createWorkspace('Other', folder).id
    const abort = new AbortController()
    cleanup.push(() => abort.abort())
    const stream = await fetch(`http://127.0.0.1:${port}/api/events?seat=${other}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
      signal: abort.signal
    })
    const reader = stream.body!.getReader()
    const decoder = new TextDecoder()
    let seen = ''
    const until = async (needle: string): Promise<void> => {
      while (!seen.includes(needle)) {
        const { value, done } = await reader.read()
        if (done) throw new Error(`stream ended before ${needle}`)
        seen += decoder.decode(value)
      }
    }
    await until('event: workspaces')
    store.renameWorkspace(store.focusedId, 'Renamed')
    await until('Renamed')
    const frames = seen.split('\n\n').filter((f) => f.startsWith('event: workspaces'))
    for (const frame of frames) expect(JSON.parse(frame.split('data: ')[1]).activeId).toBe(other)
  })
})
