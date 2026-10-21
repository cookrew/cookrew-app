import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { createGunzip } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { handleLevelsRoutes } from '../src/main/levels/routes'
import type { LevelsService } from '../src/main/levels/service'
import type { LevelsAgentDetail, LevelsEvent, LevelsSnapshot } from '../src/shared/strata'
import { fakeDesktop, GIT } from './strata-levels-fixture'
import { assertAgentDetail, assertEvent, assertSnapshot } from './strata-levels-shape'

const TOKEN = 'invented-pairing-token-0123456789'
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const servers: http.Server[] = []
const services: LevelsService[] = []

afterEach(async () => {
  services.splice(0).forEach((s) => s.close())
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))))
})

async function serve(service: LevelsService | null, heartbeatMs?: number): Promise<string> {
  if (service) services.push(service)
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const paired = (req: http.IncomingMessage, u: URL): boolean =>
      req.headers.authorization === `Bearer ${TOKEN}` || u.searchParams.get('token') === TOKEN
    if (!handleLevelsRoutes(request, response, url, { service: () => service, paired, heartbeatMs })) {
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
  until: (events: LevelsEvent[], comments: number) => boolean,
  act?: (events: LevelsEvent[]) => void,
  timeoutMs = 3000
): Promise<{ events: LevelsEvent[]; comments: number; elapsed: number[] }> {
  const controller = new AbortController()
  const response = await fetch(url, { headers: auth, signal: controller.signal })
  expect(response.status).toBe(200)
  expect(response.headers.get('content-type')).toBe('text/event-stream')
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  const events: LevelsEvent[] = []
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
          events.push(JSON.parse(frame.slice(6)) as LevelsEvent)
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

describe('GET /api/levels', () => {
  it('refuses a request without the pairing token', async () => {
    const base = await serve(fakeDesktop().service)
    expect((await fetch(`${base}/api/levels`)).status).toBe(401)
    expect((await fetch(`${base}/api/levels?token=wrong`)).status).toBe(401)
    expect((await fetch(`${base}/api/levels/stream`)).status).toBe(401)
    expect((await fetch(`${base}/api/levels/agents/a1`)).status).toBe(401)
  })

  it('answers 503 when the board is not wired, and 405 for a write', async () => {
    const base = await serve(null)
    expect((await fetch(`${base}/api/levels`, { headers: auth })).status).toBe(503)
    const desk = await serve(fakeDesktop().service)
    expect((await fetch(`${desk}/api/levels`, { method: 'POST', headers: auth })).status).toBe(405)
  })

  it('serves every workspace, focused and background, in the contract shape', async () => {
    const base = await serve(fakeDesktop().service)
    const response = await fetch(`${base}/api/levels`, { headers: auth })
    expect(response.status).toBe(200)
    const snapshot = (await response.json()) as LevelsSnapshot
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
    const first = await fetch(`${base}/api/levels`, { headers: auth })
    const etag = first.headers.get('etag')!
    expect(etag).toMatch(/^"[\w-]+"$/)
    for (let i = 0; i < 5; i += 1) {
      const again = await fetch(`${base}/api/levels`, { headers: { ...auth, 'if-none-match': etag } })
      expect(again.status).toBe(304)
    }
    expect(desk.service.stats().builds).toBe(1)

    // A signal that changes nothing rebuilds once and keeps rev and ETag.
    desk.turns.emit('activity', {})
    const same = await fetch(`${base}/api/levels`, { headers: auth })
    expect(same.headers.get('etag')).toBe(etag)
    expect(desk.service.stats()).toMatchObject({ builds: 2, rev: 1 })

    desk.rename('w2', 'Beta Greenhouse')
    const changed = await fetch(`${base}/api/levels`, { headers: { ...auth, 'if-none-match': etag } })
    expect(changed.status).toBe(200)
    expect(changed.headers.get('etag')).not.toBe(etag)
    expect(((await changed.json()) as LevelsSnapshot).rev).toBe(2)
  })

  it('reads the dials once per refresh window, and takes a bus change at once', async () => {
    const desk = fakeDesktop()
    const base = await serve(desk.service)
    await fetch(`${base}/api/levels`, { headers: auth })
    for (let i = 0; i < 5; i += 1) {
      desk.turns.emit('activity', {})
      await fetch(`${base}/api/levels`, { headers: auth })
    }
    expect(desk.fleetReads()).toBe(1)
    desk.tuningBus.emit('tuning', { terminalId: 'a1', tuning: { model: 'openai/gpt-5.6', effort: null, at: 1 } })
    const snapshot = (await (await fetch(`${base}/api/levels`, { headers: auth })).json()) as LevelsSnapshot
    expect(snapshot.workspaces[0].agents[0].model).toBe('gpt-5.6')
    expect(desk.fleetReads()).toBe(1)
    desk.clock.now += 31_000
    desk.turns.emit('activity', {})
    await fetch(`${base}/api/levels`, { headers: auth })
    expect(desk.fleetReads()).toBe(2)
  })

  it('compresses the snapshot for a client that asks', async () => {
    const base = await serve(fakeDesktop().service)
    const port = new URL(base).port
    const body = await new Promise<string>((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: '/api/levels', headers: { authorization: `Bearer ${TOKEN}`, 'accept-encoding': 'gzip' } }, (res) => {
        expect(res.headers['content-encoding']).toBe('gzip')
        const chunks: Buffer[] = []
        res.pipe(createGunzip()).on('data', (c: Buffer) => chunks.push(c)).on('end', () => resolve(Buffer.concat(chunks).toString())).on('error', reject)
      })
    })
    assertSnapshot(JSON.parse(body))
  })
})

describe('GET /api/levels/agents/:id', () => {
  it('bootstraps a dive with note bodies, full addresses and tabs', async () => {
    const base = await serve(fakeDesktop().service)
    const ada = (await (await fetch(`${base}/api/levels/agents/a1`, { headers: auth })).json()) as LevelsAgentDetail
    assertAgentDetail(ada)
    expect(ada.workspaceId).toBe('w1')
    expect(ada.notes).toEqual([{ id: 'n1', title: 'Team plan', content: '# Team plan\n\nsteps', shared: true }])
    expect(ada.browsers).toEqual([
      {
        id: 'b1',
        title: 'PR',
        url: 'https://github.com/acme/app/pull/1?secret=1#frag',
        tabs: [
          { id: 'b1-t0', url: 'https://github.com/acme/app/pull/1?secret=1#frag' },
          { id: 'b1-t1', url: 'https://docs.example.dev/q' }
        ],
        live: true,
        shared: false
      }
    ])
  })

  it('carries the card’s own node, with git only when it is already cached', async () => {
    const desk = fakeDesktop()
    const base = await serve(desk.service)
    const ada = (await (await fetch(`${base}/api/levels/agents/a1`, { headers: auth })).json()) as LevelsAgentDetail
    expect(ada.node).toMatchObject({ kind: 'terminal', id: 'a1', preset: 'claude --session-id x', orch: true, brief: 'Own the invented loader', git: GIT })
    const cleo = (await (await fetch(`${base}/api/levels/agents/g1`, { headers: auth })).json()) as LevelsAgentDetail
    assertAgentDetail(cleo)
    // An imported card opens as itself: servedSession rides along.
    expect(cleo.node).toMatchObject({ id: 'g1', servedSession: { slug: 'invented-team' } })
    expect(cleo.node).not.toHaveProperty('git')
    expect(desk.gitPeeks).toEqual(['/work/invented', '/work/beta'])
  })

  it('marks a background workspace’s browsers as not live', async () => {
    const base = await serve(fakeDesktop().service)
    const cleo = (await (await fetch(`${base}/api/levels/agents/g1`, { headers: auth })).json()) as LevelsAgentDetail
    expect(cleo.browsers.map((b) => [b.id, b.live])).toEqual([['b2', false]])
  })

  it('is never cached and 404s an unknown agent', async () => {
    const base = await serve(fakeDesktop().service)
    const ok = await fetch(`${base}/api/levels/agents/a1`, { headers: auth })
    expect(ok.headers.get('cache-control')).toBe('no-store')
    expect((await fetch(`${base}/api/levels/agents/nope`, { headers: auth })).status).toBe(404)
  })
})

describe('GET /api/levels/stream', () => {
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
      `${base}/api/levels/stream`,
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
    const snapshot = (events[0] as Extract<LevelsEvent, { type: 'snapshot' }>).snapshot
    let rev = snapshot.rev
    for (const event of events.slice(1)) {
      expect(event.type).not.toBe('snapshot')
      expect((event as { rev: number }).rev).toBe(rev + 1)
      rev += 1
    }
    const types = events.slice(1).map((e) => e.type)
    expect(types).toEqual(['agent', 'workspace', 'workspace', 'workspace', 'focus', 'workspace'])
    const probeDelta = events[1] as Extract<LevelsEvent, { type: 'agent' }>
    expect(probeDelta.agent).toMatchObject({ id: 'g1', phase: 'waiting', phaseSource: 'probe' })
    // Every change was on the wire within a second of being made.
    expect(latencies).toHaveLength(steps.length)
    for (const ms of latencies) expect(ms).toBeLessThan(1000)
    expect(desk.service.stats().rev).toBe(rev)
  })

  it('holds the probe open while a stream is, and lets it go after', async () => {
    const desk = fakeDesktop()
    const base = await serve(desk.service)
    await readStream(`${base}/api/levels/stream`, (events) => {
      if (events.length > 0) expect(desk.probeHolds()).toBe(1)
      return events.length > 0
    })
    await sleep(50)
    expect(desk.probeHolds()).toBe(0)
  })

  it('writes a comment line on the heartbeat', async () => {
    const base = await serve(fakeDesktop().service, 40)
    const { comments } = await readStream(`${base}/api/levels/stream`, (_events, comments) => comments >= 2)
    expect(comments).toBeGreaterThanOrEqual(2)
  })

  it('sends nothing for a signal that changes nothing', async () => {
    const desk = fakeDesktop()
    const base = await serve(desk.service)
    const { events } = await readStream(
      `${base}/api/levels/stream`,
      (_events) => false,
      (events) => {
        if (events.length === 1) for (let i = 0; i < 10; i += 1) desk.turns.emit('activity', {})
      },
      400
    )
    expect(events.map((e) => e.type)).toEqual(['snapshot'])
  })
})
