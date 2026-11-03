// RENAMING BY HAND (owner, 2026-11-04): the owner renames a card from the zoom
// view, the full view's head, or the phone's bar. One main-process path does
// it for the desktop's IPC, the phone's HTTP route and `cookrew rename`
// (agent-rename.ts · renameCardIn), so a clash answers the same way
// everywhere, and a name chosen by hand is PINNED: Sous never names over it.
import { mkdtempSync, readFileSync } from 'node:fs'
import http from 'node:http'
import type net from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { autoNameIn, renameByHand, renameCardIn, type RenameDeps } from '../src/main/agent-rename'
import { handleMobileApi, type MobileApiDeps } from '../src/main/mobile-api'
import { cmdRename, type SocketServerDeps } from '../src/main/socket-server'
import { WorkspaceStore } from '../src/main/store'
import type { CanvasNode, CliRequest, NoteNodeData, TerminalNodeData } from '../src/shared/model'

const terminal = (id: string, name: string, orch = false): TerminalNodeData => ({
  kind: 'terminal', id, name, preset: 'Claude Code', command: 'claude', cwd: '/tmp/home-repo',
  orch, role: null, position: { x: 10, y: 20 }, size: { width: 640, height: 420 }
})
const note = (id: string, name: string): NoteNodeData =>
  ({ kind: 'note', id, name, customName: null, content: 'hello', locked: false, position: { x: 0, y: 0 }, size: { width: 1, height: 1 } }) as NoteNodeData

function setup() {
  const store = new WorkspaceStore(path.join(mkdtempSync(path.join(tmpdir(), 'cookrew-rename-hand-')), 'data'))
  const update = vi.fn((id: string, patch: Partial<CanvasNode>, _by?: string) => store.updateNode(id, patch))
  const deps: RenameDeps = {
    find: (id) => store.nodeAcrossWorkspaces(id),
    siblings: (workspaceId) => store.workspaceState(workspaceId).nodes,
    update,
    pin: (id) => store.updateNodeUnsafe(id, { nameByHand: true } as Partial<CanvasNode>)
  }
  const nodeOf = (id: string) => store.nodeAcrossWorkspaces(id)?.node as (CanvasNode & { nameByHand?: boolean }) | undefined
  return { store, deps, update, nodeOf }
}

describe('renameByHand — the owner names a card', () => {
  it('trims, keeps the name-cleaning rules, and goes through the one update (herdr names follow)', () => {
    const { store, deps, update, nodeOf } = setup()
    store.addNode(terminal('t1', 'Fuck It'))
    expect(renameByHand(deps, 't1', '  Billing \n Webhook  ')).toEqual({ ok: true, name: 'Billing Webhook', changed: true })
    expect(nodeOf('t1')?.name).toBe('Billing Webhook')
    expect(update).toHaveBeenCalledTimes(1)
    expect(update.mock.calls[0][1]).toMatchObject({ name: 'Billing Webhook' })
  })

  it('refuses an empty or whitespace name with a message, and changes nothing', () => {
    const { store, deps, update, nodeOf } = setup()
    store.addNode(terminal('t1', 'Scout'))
    for (const wanted of ['', '   ', '\n\t', undefined, 42, null]) {
      const out = renameByHand(deps, 't1', wanted)
      expect(out.ok).toBe(false)
      if (!out.ok) expect(out.error).toMatch(/needs at least one letter or digit/)
    }
    expect(update).not.toHaveBeenCalled()
    expect(nodeOf('t1')?.name).toBe('Scout')
  })

  it('refuses a card that is not there, or a bad id', () => {
    const { deps } = setup()
    expect(renameByHand(deps, 'nope', 'Scout')).toEqual({ ok: false, error: 'That card is not on any canvas.' })
    expect(renameByHand(deps, 7, 'Scout').ok).toBe(false)
  })

  it('answers a clash exactly as `cookrew rename` does: refused, never suffixed', () => {
    const { store, deps } = setup()
    const me = store.addNode(terminal('t1', 'Finch')) as TerminalNodeData
    store.addNode(terminal('t2', 'Conductor', true))
    const byHand = renameByHand(deps, 't1', 'conductor')
    expect(byHand.ok).toBe(false)
    const cli = { store, renameCard: (id: string, wanted: string, onClash: 'refuse' | 'suffix', by?: string) => renameCardIn(deps, id, wanted, onClash, onClash === 'refuse', by) } as unknown as SocketServerDeps
    const request: CliRequest = { id: 'r', cmd: 'rename', args: ['conductor'], flags: {}, terminalId: me.id }
    let cliError = ''
    try {
      cmdRename(request, cli)
    } catch (error) {
      cliError = (error as Error).message
    }
    expect(cliError).toBe('"conductor" is already a card in this workspace. Pick another name.')
    if (!byHand.ok) expect(byHand.error).toBe(cliError)
    expect(store.node('t1')?.name).toBe('Finch')
  })

  it('the owner may rename the Orch by hand (the CLI keeps agents off it)', () => {
    const { store, deps, nodeOf } = setup()
    store.addNode(terminal('o1', 'Conductor', true))
    expect(renameByHand(deps, 'o1', 'Maestro').ok).toBe(true)
    expect(nodeOf('o1')?.name).toBe('Maestro')
  })

  it('pins a note’s name (customName), as the card menu always did', () => {
    const { store, deps, nodeOf } = setup()
    store.addNode(note('n1', 'hello'))
    expect(renameByHand(deps, 'n1', 'Release notes')).toMatchObject({ ok: true, name: 'Release notes' })
    expect(nodeOf('n1')).toMatchObject({ name: 'Release notes', customName: 'Release notes' })
  })

  it('renames a browser card too', () => {
    const { store, deps, nodeOf } = setup()
    store.addNode({ kind: 'browser', id: 'b1', name: 'Page', url: 'about:blank', position: { x: 0, y: 0 }, size: { width: 1, height: 1 } } as CanvasNode)
    expect(renameByHand(deps, 'b1', 'Docs').ok).toBe(true)
    expect(nodeOf('b1')?.name).toBe('Docs')
  })
})

describe('a name set by hand is pinned', () => {
  it('a manual name survives a later auto-name', async () => {
    const { store, deps, nodeOf } = setup()
    store.addNode(terminal('t1', 'Fuck It'))
    expect(renameByHand(deps, 't1', 'Scout').ok).toBe(true)
    expect(nodeOf('t1')?.nameByHand).toBe(true)
    // Any later naming from a prompt, even one whose stand-in is the name the card now wears.
    const pick = vi.fn(async () => 'Login Redirect')
    expect(await autoNameIn({ ...deps, pick }, 't1', 'Scout', 'fix the login redirect')).toBeNull()
    expect(nodeOf('t1')?.name).toBe('Scout')
  })

  it('keeping the stand-in by hand (Enter on the same name) pins it too', async () => {
    const { store, deps, nodeOf } = setup()
    store.addNode(terminal('t1', 'Login'))
    expect(renameByHand(deps, 't1', 'Login')).toEqual({ ok: true, name: 'Login', changed: false })
    expect(nodeOf('t1')?.nameByHand).toBe(true)
    expect(await autoNameIn({ ...deps, pick: async () => 'Login Redirect' }, 't1', 'Login', 'fix the login')).toBeNull()
    expect(nodeOf('t1')?.name).toBe('Login')
  })

  it('a hand name that looks like a suffixed stand-in is still a choice', async () => {
    const { store, deps, nodeOf } = setup()
    store.addNode(terminal('t1', 'Login'))
    renameByHand(deps, 't1', 'Login (2)')
    expect(await autoNameIn({ ...deps, pick: async () => 'Login Redirect' }, 't1', 'Login', 'fix the login')).toBeNull()
    expect(nodeOf('t1')?.name).toBe('Login (2)')
  })

  it('without a hand rename Sous still replaces its stand-in, and its name pins nothing', async () => {
    const { store, deps, nodeOf } = setup()
    store.addNode(terminal('t1', 'Login'))
    const named = await autoNameIn({ ...deps, pick: async () => 'Login Redirect' }, 't1', 'Login', 'fix the login redirect')
    expect(named).toEqual({ ok: true, name: 'Login Redirect', changed: true })
    expect(nodeOf('t1')?.name).toBe('Login Redirect')
    expect(nodeOf('t1')?.nameByHand).toBeUndefined()
  })

  it('a model’s clash is suffixed and never pins; `cookrew rename` pins, a name somebody chose', () => {
    const { store, deps, nodeOf } = setup()
    store.addNode(terminal('t1', 'Agent'))
    store.addNode(terminal('t2', 'Scout'))
    expect(renameCardIn(deps, 't1', 'Scout', 'suffix', false, 'Sous')).toEqual({ ok: true, name: 'Scout (2)', changed: true })
    expect(nodeOf('t1')?.nameByHand).toBeUndefined()
    expect(renameCardIn(deps, 't1', 'Finch', 'refuse', true, '"Finch" (agent, cookrew rename)').ok).toBe(true)
    expect(nodeOf('t1')?.nameByHand).toBe(true)
  })

  it('the pin is main’s own write: a renderer or phone patch cannot set or clear it', () => {
    const { store, deps, nodeOf } = setup()
    store.addNode(terminal('t1', 'Scout'))
    store.updateNode('t1', { nameByHand: true } as Partial<CanvasNode>)
    expect(nodeOf('t1')?.nameByHand).toBeUndefined()
    renameByHand(deps, 't1', 'Finch')
    store.updateNode('t1', { nameByHand: false } as Partial<CanvasNode>)
    expect(nodeOf('t1')?.nameByHand).toBe(true)
  })

  it('Sous with nothing better leaves the card alone', async () => {
    const { store, deps, update } = setup()
    store.addNode(terminal('t1', 'Login'))
    expect(await autoNameIn({ ...deps, pick: async () => null }, 't1', 'Login', 'x')).toBeNull()
    expect(update).not.toHaveBeenCalled()
  })
})

describe('the shared path is wired to every caller', () => {
  const index = readFileSync('src/main/index.ts', 'utf8')
  // Loose on purpose: quote style and parameter names may change; who calls what may not.
  it('IPC node:rename and the phone’s ops both run renameByHand; renameCard and Sous run the shared functions', () => {
    expect(index).toMatch(/ipcMain\.handle\(\s*['"]node:rename['"][^)]*\)\s*=>\s*renameByHand\(renameDeps,/)
    expect(index).toMatch(/renameNode:[^\n]*renameByHand\(renameDeps,/)
    expect(index).toMatch(/return renameCardIn\(renameDeps,/)
    expect(index).toMatch(/autoNameIn\(\{\s*\.\.\.renameDeps,\s*pick: nameAgent\s*\}/)
    expect(index).toMatch(/pin: \(id\) => store\.updateNodeUnsafe\(id, \{ nameByHand: true \}\)/)
  })
  it('the preload, the phone and the demo all offer renameNode', () => {
    expect(readFileSync('src/preload/index.ts', 'utf8')).toMatch(/renameNode:[^\n]*ipcRenderer\.invoke\(\s*['"]node:rename['"]/)
    expect(readFileSync('src/renderer/src/remote-api.ts', 'utf8')).toMatch(/renameNode:[\s\S]{0,120}\/api\/nodes\/[^`]*\/rename`/)
    expect(readFileSync('src/renderer/src/demo-api.ts', 'utf8')).toContain('renameNode:')
    expect(readFileSync('src/renderer/src/api.ts', 'utf8')).toMatch(/renameNode: \(id: string, name: string\) => Promise<RenameOutcome>/)
  })
})

describe('POST /api/nodes/:id/rename (the phone)', () => {
  const PAIRING = 'pairing-token-123'
  const WALL = 'wall-token-456'
  const cleanup: Array<() => void> = []
  afterEach(() => {
    for (const run of cleanup.splice(0)) run()
  })
  const renameNode = vi.fn((id: string, name: unknown) =>
    typeof name === 'string' && name.trim() ? { ok: true as const, name: name.trim(), changed: true } : { ok: false as const, error: 'A name needs at least one letter or digit.' }
  )
  const start = async (): Promise<number> => {
    const deps = { pairingToken: PAIRING, wallToken: WALL, ops: { renameNode } } as unknown as MobileApiDeps
    const server = http.createServer((request, response) => {
      const url = new URL(request.url ?? '/', `http://${request.headers.host}`)
      void handleMobileApi(request, response, url, deps).then((handled) => {
        if (!handled) response.writeHead(404).end()
      })
    })
    cleanup.push(() => server.close())
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    return (server.address() as net.AddressInfo).port
  }
  const post = async (port: number, p: string, token: string, body: unknown) => {
    const response = await fetch(`http://127.0.0.1:${port}${p}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body)
    })
    const text = await response.text()
    return { status: response.status, body: text ? JSON.parse(text) : {} }
  }

  it('renames through the shared op and answers its outcome', async () => {
    const port = await start()
    const done = await post(port, '/api/nodes/t1/rename', PAIRING, { name: ' Scout ' })
    expect(done).toEqual({ status: 200, body: { ok: true, name: 'Scout', changed: true } })
    expect(renameNode).toHaveBeenLastCalledWith('t1', ' Scout ')
  })

  it('a refused name is a 400 carrying the same words', async () => {
    const port = await start()
    const refused = await post(port, '/api/nodes/t1/rename', PAIRING, { name: '   ' })
    expect(refused).toEqual({ status: 400, body: { ok: false, error: 'A name needs at least one letter or digit.' } })
  })

  it('a body that is not an object is refused, not a 500', async () => {
    const port = await start()
    const refused = await post(port, '/api/nodes/t1/rename', PAIRING, null)
    expect(refused.status).toBe(400)
  })

  it('the read-only wall token may not rename', async () => {
    const port = await start()
    expect((await post(port, '/api/nodes/t1/rename', WALL, { name: 'Scout' })).status).toBe(401)
  })
})
