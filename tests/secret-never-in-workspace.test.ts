// THE PIN THE WHOLE LANE EXISTS FOR: a sealed value is in ~/.cookrew/secrets
// and nowhere else — not in workspace.json, not in a note file, not in
// /api/workspace, not in an event.
import http from 'node:http'
import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs'
import type net from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { handleMobileApi, type MobileApiDeps } from '../src/main/mobile-api'
import { createSecretsStore } from '../src/main/secrets-store'
import { cmdSecret, type SecretAudit } from '../src/main/secret-cli'
import { WorkspaceStore } from '../src/main/store'
import { secretSlotLine } from '../src/shared/secret-slot'
import type { CliRequest, TerminalNodeData } from '../src/shared/model'

const VALUE = 'sk_live_51Hx9QxNEVERINWORKSPACE77'

const everyFile = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry)
    return statSync(full).isDirectory() ? everyFile(full) : [full]
  })

describe('a sealed value never reaches workspace state', () => {
  const cleanup: Array<() => void> = []
  afterEach(() => {
    for (const run of cleanup.splice(0)) run()
  })

  it('write one, dump the store, the files, the API and the audit — and grep', async () => {
    const base = mkdtempSync(path.join(tmpdir(), 'cookrew-sealed-'))
    const store = new WorkspaceStore(path.join(base, 'data'))
    const secrets = createSecretsStore({ baseDir: path.join(base, 'home') })
    // The note keeps only the slot line, exactly as the editor leaves it.
    const note = store.createNote(
      { customName: 'Stripe keys', content: `# Stripe keys\n\n${secretSlotLine('stripe-key')}\n`, locked: false, position: { x: 0, y: 0 }, size: { width: 300, height: 200 } },
      store.focusedId
    )
    secrets.put('stripe-key', VALUE)
    const me = store.addNode({ kind: 'terminal', id: 't1', name: 'Tinker', preset: 'claude', command: 'claude', cwd: '/', orch: false, role: null, position: { x: 0, y: 0 }, size: { width: 1, height: 1 } } as unknown as TerminalNodeData) as TerminalNodeData
    const audits: SecretAudit[] = []
    expect(
      cmdSecret({ id: 'r', cmd: 'secret', args: ['read', 'stripe-key'], flags: {}, terminalId: me.id } as unknown as CliRequest, {
        secrets,
        self: () => me,
        audit: (event) => audits.push(event)
      })
    ).toBe(VALUE)

    // 1. The store, in memory and on disk.
    expect(JSON.stringify(store.workspaceState(store.focusedId))).not.toContain(VALUE)
    expect(JSON.stringify(store.list())).not.toContain(VALUE)
    for (const file of everyFile(path.join(base, 'data'))) {
      expect(readFileSync(file, 'utf8'), file).not.toContain(VALUE)
    }
    // 2. The only file that has it is the secret's own, under 0700/0600.
    const holders = everyFile(base).filter((file) => readFileSync(file, 'utf8').includes(VALUE))
    expect(holders).toEqual([path.join(base, 'home', 'secrets', 'stripe-key')])
    // 3. The audit line: name, pane, never the value.
    expect(JSON.stringify(audits)).toContain('stripe-key')
    expect(JSON.stringify(audits)).not.toContain(VALUE)
    // 4. /api/workspace, the document the phone and the relay carry.
    const deps = { pairingToken: 'tok', store, secrets, turns: { list: () => [] }, ops: { gitInfo: async () => null } } as unknown as MobileApiDeps
    const server = http.createServer((request, response) => {
      const url = new URL(request.url ?? '/', `http://${request.headers.host}`)
      void handleMobileApi(request, response, url, deps).then((handled) => {
        if (!handled) response.writeHead(404).end()
      })
    })
    cleanup.push(() => server.close())
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as net.AddressInfo).port
    const body = await (await fetch(`http://127.0.0.1:${port}/api/workspace`, { headers: { authorization: 'Bearer tok' } })).text()
    expect(body).toContain(note.id)
    expect(body).toContain('🔒 stripe-key')
    expect(body).not.toContain(VALUE)
  })
})
