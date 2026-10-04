import http from 'node:http'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import type net from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { handleMobileApi, type MobileApiDeps } from '../src/main/mobile-api'
import type { AgentTuning, AgentTuningState } from '../src/shared/agent-tuning'

/**
 * THE DIALS ON THE PHONE.
 *
 * The first cut of this feature shipped the desktop half only, and the phone
 * showed nothing at all — not a bug in the rail but three missing routes: the
 * remote api had no `listTuning`, so the store never filled, so every card
 * drew no tag and the rail's state stayed null. It looked exactly like the
 * feature had not deployed.
 *
 * So these pin the phone's whole surface: the fleet read the tags come from,
 * the per-card read the rail opens with, and the write that turns a knob —
 * each behind the pairing every write on this API needs, and each reaching the
 * desktop's OWN operations rather than a second implementation.
 */
const TOKEN = 'pairing-token-123'

const RUNNING: AgentTuning = { model: 'claude-opus-5', effort: 'max', at: 1_759_000_000_000 }
const CODEX: AgentTuning = { model: 'gpt-6-astra', effort: 'high', at: 1_759_000_000_000 }

describe('the phone reads and turns the dials', () => {
  const cleanup: Array<() => void> = []
  afterEach(() => {
    for (const run of cleanup.splice(0)) run()
  })

  const startApi = async (tuning?: MobileApiDeps['tuning']): Promise<number> => {
    const deps = {
      pairingToken: TOKEN,
      turns: { list: () => [] },
      ...(tuning ? { tuning } : {})
    } as unknown as MobileApiDeps
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

  const call = async (
    port: number,
    path: string,
    init: { method?: string; body?: unknown; token?: string | null } = {}
  ) => {
    const token = init.token === undefined ? TOKEN : init.token
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        'content-type': 'application/json',
        ...(token === null ? {} : { authorization: `Bearer ${token}` })
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) })
    })
    const text = await response.text()
    return { status: response.status, body: (text ? JSON.parse(text) : {}) as Record<string, unknown> }
  }

  const spy = (): { deps: NonNullable<MobileApiDeps['tuning']>; turns: unknown[][] } => {
    const turns: unknown[][] = []
    return {
      turns,
      deps: {
        fleet: () => ({ 'term-1': RUNNING, 'term-2': CODEX }),
        state: (id): AgentTuningState => ({
          harness: 'claude',
          knobs: ['model', 'effort'],
          records: ['model', 'effort'],
          tuning: id === 'term-1' ? RUNNING : null,
          asks: [],
          caveat: 'this also becomes the default every new agent boots on'
        }),
        turn: (id, knob, value) => {
          turns.push([id, knob, value])
          return value === 'nonsense' ? { ok: false, reason: 'not a model we offer' } : { ok: true }
        }
      }
    }
  }

  it('serves the whole fleet in ONE read, because every card wears a tag', async () => {
    // Per-card reads would be one request per agent on the boot of a canvas
    // with dozens of them — the exact shape of the L7 boot regression.
    const port = await startApi(spy().deps)
    const got = await call(port, '/api/tuning')
    expect(got.status).toBe(200)
    expect(got.body).toEqual({ 'term-1': RUNNING, 'term-2': CODEX })
  })

  it('serves one card the state its rail opens with', async () => {
    const port = await startApi(spy().deps)
    const got = await call(port, '/api/terminal/term-1/tuning')
    expect(got.status).toBe(200)
    expect(got.body.knobs).toEqual(['model', 'effort'])
    expect(got.body.tuning).toEqual(RUNNING)
    expect(got.body.caveat).toContain('default every new agent')
  })

  it('turns a knob through the desktop’s own operation, arguments intact', async () => {
    const seen = spy()
    const port = await startApi(seen.deps)
    const got = await call(port, '/api/terminal/term-1/tune', {
      method: 'POST',
      body: { knob: 'effort', value: 'low' }
    })
    expect(got.status).toBe(200)
    expect(got.body).toEqual({ ok: true })
    expect(seen.turns).toEqual([['term-1', 'effort', 'low']])
  })

  it('passes a refusal back verbatim instead of swallowing it', async () => {
    const port = await startApi(spy().deps)
    const got = await call(port, '/api/terminal/term-1/tune', {
      method: 'POST',
      body: { knob: 'model', value: 'nonsense' }
    })
    // 200 with ok:false, not 400: the route reached the operation and the
    // OPERATION refused, which is a different fact from a malformed request.
    expect(got.status).toBe(200)
    expect(got.body).toEqual({ ok: false, reason: 'not a model we offer' })
  })

  it('refuses a body without both fields before anything is typed', async () => {
    const seen = spy()
    const port = await startApi(seen.deps)
    expect((await call(port, '/api/terminal/term-1/tune', { method: 'POST', body: {} })).status).toBe(400)
    expect(
      (await call(port, '/api/terminal/term-1/tune', { method: 'POST', body: { knob: 'model' } }))
        .status
    ).toBe(400)
    expect(seen.turns).toEqual([])
  })

  it('needs the pairing to turn anything, and a token to read', async () => {
    const seen = spy()
    const port = await startApi(seen.deps)
    const write = await call(port, '/api/terminal/term-1/tune', {
      method: 'POST',
      body: { knob: 'model', value: 'opus' },
      token: null
    })
    expect(write.status).toBe(401)
    expect(seen.turns).toEqual([])
    expect((await call(port, '/api/tuning', { token: null })).status).toBe(401)
    expect((await call(port, '/api/terminal/term-1/tuning', { token: null })).status).toBe(401)
  })

  it('simply does not match when no dials are wired, rather than answering wrongly', async () => {
    // A test server (or a build without the capability) must fall through to
    // the host's 404 — an empty 200 would tell the phone every agent runs on
    // nothing, which is a claim.
    const port = await startApi(undefined)
    expect((await call(port, '/api/tuning')).status).toBe(404)
    expect((await call(port, '/api/terminal/term-1/tuning')).status).toBe(404)
    expect(
      (await call(port, '/api/terminal/term-1/tune', { method: 'POST', body: { knob: 'model', value: 'opus' } }))
        .status
    ).toBe(404)
  })
})

/**
 * THE GAP ITSELF, pinned.
 *
 * A capability the Electron bridge has and the phone bridge does not is
 * invisible: every call site feature-detects, so the phone degrades to drawing
 * nothing and looks like a deployment that did not happen. Nothing in the type
 * system catches it either — the methods are optional on CookrewApi precisely
 * so the demo api can go without.
 *
 * Source-level, for the same reason tests/ipc-channels.test.ts is: the failure
 * lives in agreement between two files and shows up only on a phone.
 */
describe('the phone bridge implements the dials', () => {
  it('carries all four methods, not just the desktop', () => {
    const remote = readFileSync(
      path.join(__dirname, '..', 'src/renderer/src/remote-api.ts'),
      'utf8'
    )
    for (const method of ['listTuning', 'onTerminalTuning', 'terminalTuning', 'tuneTerminal']) {
      expect(remote, `remote-api.ts must implement ${method} or the phone shows no dials`)
        .toContain(`${method}:`)
    }
  })

  it('reaches the same routes this file pins', () => {
    const remote = readFileSync(
      path.join(__dirname, '..', 'src/renderer/src/remote-api.ts'),
      'utf8'
    )
    expect(remote).toContain("'/api/tuning'")
    expect(remote).toContain('/tuning`')
    expect(remote).toContain('/tune`')
    // The push, not a poll: the desktop and the phone consume the same frame.
    expect(remote).toContain("subscribe<{ terminalId: string; tuning: AgentTuning }>('tuning'")
  })
})
