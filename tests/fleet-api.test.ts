import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { createGunzip } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { handleFleetRoutes } from '../src/main/fleet/routes'
import type { FleetService } from '../src/main/fleet/service'
import type { FleetEvent, FleetSnapshot } from '../src/shared/fleet'
import { fakeDesktop, GIT } from './fleet-fixture'
import { assertEvent, assertSnapshot } from './fleet-shape'

const TOKEN = 'invented-pairing-token-0123456789'
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const servers: http.Server[] = []
const services: FleetService[] = []

afterEach(async () => {
  services.splice(0).forEach((s) => s.close())
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))))
})

async function serve(service: FleetService | null, heartbeatMs?: number): Promise<string> {
  if (service) services.push(service)
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const paired = (req: http.IncomingMessage, u: URL): boolean =>
      req.headers.authorization === `Bearer ${TOKEN}` || u.searchParams.get('token') === TOKEN
    if (!handleFleetRoutes(request, response, url, { service: () => service, paired, heartbeatMs })) {
      response.writeHead(404)
      response.end()
    }
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

const auth = { authorization: `Bearer ${TOKEN}`, 'accept-encoding': 'identity' }

/** Read `data:` frames off an event stream until `until` says stop. */
async function readStream(
  url: string,
  until: (events: FleetEvent[], comments: number) => boolean,
  act?: (events: FleetEvent[]) => void,
  timeoutMs = 3000
): Promise<{ events: FleetEvent[]; comments: number; elapsed: number[] }> {
  const controller = new AbortController()
  const response = await fetch(url, { headers: auth, signal: controller.signal })
  expect(response.status).toBe(200)
  expect(response.headers.get('content-type')).toBe('text/event-stream')
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  const events: FleetEvent[] = []
  const elapsed: number[] = []
  const started = Date.now()
  let comments = 0
  let buffer = ''
  const deadline = setTimeout(() => controller.abort(), timeoutMs)
  try {
    while (!until(events, comments)) {
      let chunk: ReadableStreamReadResult<Uint8Array>
      try {
        chunk = await reader.read()
      } catch {
        break // the deadline aborted the read: return what arrived
      }
      const { value, done } = chunk
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let cut: number
      while ((cut = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, cut)
        buffer = buffer.slice(cut + 2)
        if (frame.startsWith(':')) comments += 1
        else if (frame.startsWith('data: ')) {
          events.push(JSON.parse(frame.slice(6)) as FleetEvent)
          elapsed.push(Date.now() - started)
          act?.(events)
        }
      }
    }
  } finally {
    clearTimeout(deadline)
    controller.abort()
  }
  return { events, comments, elapsed }
}

describe('GET /api/fleet', () => {
  it('refuses a request without the pairing token', async () => {
    const base = await serve(fakeDesktop().service)
    expect((await fetch(`${base}/api/fleet`)).status).toBe(401)
    expect((await fetch(`${base}/api/fleet?token=wrong`)).status).toBe(401)
    expect((await fetch(`${base}/api/fleet/stream`)).status).toBe(401)
  })

  it('answers 503 when the board is not wired, and 405 for a write', async () => {
    const base = await serve(null)
    expect((await fetch(`${base}/api/fleet`, { headers: auth })).status).toBe(503)
    const desk = await serve(fakeDesktop().service)
    expect((await fetch(`${desk}/api/fleet`, { method: 'POST', headers: auth })).status).toBe(405)
  })

  it('serves every workspace, focused and background, in the contract shape', async () => {
    const base = await serve(fakeDesktop().service)
    const response = await fetch(`${base}/api/fleet`, { headers: auth })
    expect(response.status).toBe(200)
    const snapshot = (await response.json()) as FleetSnapshot
    assertSnapshot(snapshot)
    expect(snapshot.v).toBe(1)
    expect(snapshot.rev).toBe(1)
    expect(snapshot.focusedWorkspaceId).toBe('w1')
    expect(snapshot.machine).toMatchObject({ name: 'Invented studio', appVersion: '0.3.0', profile: { kind: 'desktop' } })
    expect(snapshot.workspaces.map((w) => [w.id, w.state])).toEqual([
      ['w1', 'focused'],
      ['w2', 'background']
    ])
    const [alpha, beta] = snapshot.workspaces
    expect(alpha.agents.map((a) => a.id)).toEqual(['a1', 'a2'])
    expect(alpha.counts).toEqual({ agents: 2, notes: 2, browsers: 1 })
    expect(alpha.loose.map((l) => l.id)).toEqual(['n2'])

    const [ada, basil] = alpha.agents
    expect(ada).toMatchObject({
      harness: 'claude',
      model: 'claude-opus-5-5',
      orch: true,
      phase: 'thinking',
      phaseSource: 'live',
      // The Sous title is absent mid-turn, so the brief wins over the prompt.
      task: 'Own the invented loader',
      reply: 'Looking at the helper now',
      status: 'Simmering…'
    })
    expect(ada.attachments).toEqual([
      { id: 'n1', kind: 'note', title: 'Team plan', shared: true, owner: true },
      { id: 'b1', kind: 'browser', title: 'PR', host: 'github.com/acme/app/pull/1', tabs: 2, shared: false, owner: true }
    ])
    expect(basil).toMatchObject({ harness: 'shell', phase: 'replied', phaseSource: 'ledger', task: 'Tidy the invented dotfiles', turns: 2 })
    expect(basil.attachments).toEqual([{ id: 'n1', kind: 'note', title: 'Team plan', shared: true, owner: false }])

    expect(beta.agents[0]).toMatchObject({ id: 'g1', harness: 'codex', phase: 'thinking', phaseSource: 'probe', phaseSince: null })
  })

  it('sends an ETag and answers 304 for an unchanged fleet, building once', async () => {
    const desk = fakeDesktop()
    const base = await serve(desk.service)
    const first = await fetch(`${base}/api/fleet`, { headers: auth })
    const etag = first.headers.get('etag')!
    expect(etag).toMatch(/^"[\w-]+"$/)
    for (let i = 0; i < 5; i += 1) {
      const again = await fetch(`${base}/api/fleet`, { headers: { ...auth, 'if-none-match': etag } })
      expect(again.status).toBe(304)
    }
    expect(desk.service.stats().builds).toBe(1)

    // A signal that changes nothing rebuilds once and keeps rev and ETag.
    desk.turns.emit('activity', {})
    const same = await fetch(`${base}/api/fleet`, { headers: auth })
    expect(same.headers.get('etag')).toBe(etag)
    expect(desk.service.stats()).toMatchObject({ builds: 2, rev: 1 })

    desk.rename('w2', 'Beta Greenhouse')
    const changed = await fetch(`${base}/api/fleet`, { headers: { ...auth, 'if-none-match': etag } })
    expect(changed.status).toBe(200)
    expect(changed.headers.get('etag')).not.toBe(etag)
    expect(((await changed.json()) as FleetSnapshot).rev).toBe(2)
  })

  it('reads the dials once per refresh window, and takes a bus change at once', async () => {
    const desk = fakeDesktop()
    const base = await serve(desk.service)
    await fetch(`${base}/api/fleet`, { headers: auth })
    for (let i = 0; i < 5; i += 1) {
      desk.turns.emit('activity', {})
      await fetch(`${base}/api/fleet`, { headers: auth })
    }
    expect(desk.fleetReads()).toBe(1)
    desk.tuningBus.emit('tuning', { terminalId: 'a1', tuning: { model: 'openai/gpt-5.6', effort: null, at: 1 } })
    const snapshot = (await (await fetch(`${base}/api/fleet`, { headers: auth })).json()) as FleetSnapshot
    expect(snapshot.workspaces[0].agents[0].model).toBe('gpt-5.6')
    expect(desk.fleetReads()).toBe(1)
    desk.clock.now += 31_000
    desk.turns.emit('activity', {})
    await fetch(`${base}/api/fleet`, { headers: auth })
    expect(desk.fleetReads()).toBe(2)
  })

  it('compresses the snapshot for a client that asks', async () => {
    const base = await serve(fakeDesktop().service)
    const port = new URL(base).port
    const body = await new Promise<string>((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: '/api/fleet', headers: { authorization: `Bearer ${TOKEN}`, 'accept-encoding': 'gzip' } }, (res) => {
        expect(res.headers['content-encoding']).toBe('gzip')
        const chunks: Buffer[] = []
        res.pipe(createGunzip()).on('data', (c: Buffer) => chunks.push(c)).on('end', () => resolve(Buffer.concat(chunks).toString())).on('error', reject)
      })
    })
    assertSnapshot(JSON.parse(body))
  })
})

describe('GET /api/fleet/stream', () => {
  it('opens with a snapshot, then deltas with rev = previous + 1, each within a second', async () => {
    const desk = fakeDesktop()
    const base = await serve(desk.service)
    const steps = [
      () => desk.setProbe(new Map([['g1', 'waiting']])),
      () => desk.rename('w2', 'Beta Greenhouse'),
      () => desk.focus('w2'),
      () => desk.removeAgent('w1', 'a2')
    ]
    const latencies: number[] = []
    let ranAt: number | null = null
    let next = 0
    let armed = false
    const { events } = await readStream(
      `${base}/api/fleet/stream`,
      (events) => events.some((e) => e.type === 'workspace' && e.workspace.id === 'w1' && e.workspace.agents.length === 1),
      () => {
        if (ranAt !== null) {
          latencies.push(Date.now() - ranAt)
          ranAt = null
        }
        // The next change once this one's burst is in.
        if (armed || next >= steps.length) return
        armed = true
        setTimeout(() => {
          armed = false
          ranAt = Date.now()
          steps[next]()
          next += 1
        }, 100)
      }
    )
    events.forEach(assertEvent)
    expect(events[0].type).toBe('snapshot')
    const snapshot = (events[0] as Extract<FleetEvent, { type: 'snapshot' }>).snapshot
    let rev = snapshot.rev
    for (const event of events.slice(1)) {
      expect(event.type).not.toBe('snapshot')
      expect((event as { rev: number }).rev).toBe(rev + 1)
      rev += 1
    }
    const types = events.slice(1).map((e) => e.type)
    expect(types).toEqual(['agent', 'workspace', 'workspace', 'workspace', 'focus', 'workspace'])
    const probeDelta = events[1] as Extract<FleetEvent, { type: 'agent' }>
    expect(probeDelta.agent).toMatchObject({ id: 'g1', phase: 'waiting', phaseSource: 'probe' })
    // Every change was on the wire within a second of being made.
    expect(latencies).toHaveLength(steps.length)
    for (const ms of latencies) expect(ms).toBeLessThan(1000)
    expect(desk.service.stats().rev).toBe(rev)
  })

  it('holds the probe open while a stream is, and lets it go after', async () => {
    const desk = fakeDesktop()
    const base = await serve(desk.service)
    await readStream(`${base}/api/fleet/stream`, (events) => {
      if (events.length > 0) expect(desk.probeHolds()).toBe(1)
      return events.length > 0
    })
    await sleep(50)
    expect(desk.probeHolds()).toBe(0)
  })

  it('writes a comment line on the heartbeat', async () => {
    const base = await serve(fakeDesktop().service, 40)
    const { comments } = await readStream(`${base}/api/fleet/stream`, (_events, comments) => comments >= 2)
    expect(comments).toBeGreaterThanOrEqual(2)
  })

  it('sends nothing for a signal that changes nothing', async () => {
    const desk = fakeDesktop()
    const base = await serve(desk.service)
    const { events } = await readStream(
      `${base}/api/fleet/stream`,
      (_events) => false,
      (events) => {
        if (events.length === 1) for (let i = 0; i < 10; i += 1) desk.turns.emit('activity', {})
      },
      400
    )
    expect(events.map((e) => e.type)).toEqual(['snapshot'])
  })
})
