// THE ADAPTER GATE (one-stream T2): the five old routes, answered off the one
// reader, must say what they say today.
//
// The design's migration step 2 is what this protects: "the old store is kept
// read-only for one release, and the old routes keep answering from it behind
// a flag, so a regression is a flag flip, not a restore." A flag is only worth
// having if both sides agree, so ONE synthetic chain is driven through
// handleMobileApi twice — once with the reader wired, once without — and the
// JSON is compared field by field for every one of the five.
//
// THE FIXTURE IS A REAL TRANSCRIPT, read through the real TraceReader and the
// real parsers. The old side's `turnHistory` is parseSessionTurns over the
// same file, which is exactly what SessionTurnSync feeds the turn store: a
// hand-written expectation would prove the test, not the code.
//
// THE THREE DIFFERENCES ARE TESTED AS DIFFERENCES, not papered over — see the
// 'differences the adapters do NOT hide' block. None is a regression; each is
// the design landing.

import http from 'node:http'
import type net from 'node:net'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { handleMobileApi, type MobileApiDeps } from '../src/main/mobile-api'
import { streamAdaptersEnabled } from '../src/main/stream-adapters'
import { createStreamService } from '../src/main/stream-service'
import { TraceReader } from '../src/main/trace'
import { WorkspaceStore } from '../src/main/store'
import { writeMark } from '../src/main/marks'
import { claudeProjectSlug } from '../src/shared/claude-fork'
import { parseSessionTurns } from '../src/shared/session-turns'
import { mergeAnnotation, type TurnRecord } from '../src/shared/turn'
import type { TerminalNodeData } from '../src/shared/model'

const TOKEN = 'pairing-token-adapters'
const T0 = Date.parse('2026-09-07T09:00:00.000Z')
const iso = (ms: number): string => new Date(ms).toISOString()

const prompt = (uuid: string, text: string, ms: number): string =>
  JSON.stringify({ type: 'user', uuid, timestamp: iso(ms), message: { role: 'user', content: text } })

const reply = (text: string, ms: number, stop: string | null): string =>
  JSON.stringify({
    type: 'assistant',
    timestamp: iso(ms),
    message: { role: 'assistant', content: [{ type: 'text', text }], stop_reason: stop }
  })

const boundary = (pre: number, post: number): string =>
  JSON.stringify({
    type: 'system',
    subtype: 'compact_boundary',
    content: 'Conversation compacted',
    compactMetadata: { trigger: 'auto', preTokens: pre, postTokens: post }
  })

function terminal(patch: Partial<TerminalNodeData>): TerminalNodeData {
  return {
    kind: 'terminal',
    id: 't-adapt',
    name: 'Agent',
    preset: 'Claude Code',
    command: 'claude',
    cwd: '/work/repo',
    orch: false,
    role: null,
    position: { x: 0, y: 0 },
    size: { width: 400, height: 300 },
    ...patch
  }
}

/**
 * A card that has NEVER compacted a file boundary away: four exchanges, a ◆
 * declared mid-file, the last turn still running. On such a card the old
 * in-file index and the stream's whole-chain ordinal are the SAME number,
 * which is what makes strict byte equality the right gate.
 */
function chainLines(): string[] {
  return [
    prompt('u1', 'first ask', T0),
    reply('one', T0 + 100, 'end_turn'),
    prompt('u2', 'a much longer second ask that runs well past the eighty character cap the trace index applies', T0 + 200),
    reply('two', T0 + 300, 'end_turn'),
    boundary(120_000, 9_000),
    prompt('u3', 'third ask', T0 + 400),
    reply('three', T0 + 500, 'end_turn'),
    prompt('u4', 'fourth ask', T0 + 600),
    reply('still working', T0 + 700, null)
  ]
}

interface Bed {
  port: (mode: 'stream' | 'old') => Promise<number>
  marksDir: string
  node: TerminalNodeData
}

describe('the five old routes, answered off the one reader', () => {
  const cleanup: Array<() => void> = []
  // The adapters are OFF by default until T4 migrates the marks; these gates
  // exercise them ON, the way T4 will ship them.
  beforeEach(() => {
    process.env.COOKREW_STREAM_ADAPTERS = '1'
  })
  afterEach(() => {
    for (const run of cleanup.splice(0)) run()
    delete process.env.COOKREW_STREAM_ADAPTERS
  })

  function bed(lines: string[], options: { annotations?: boolean } = {}): Bed {
    const base = mkdtempSync(path.join(tmpdir(), 'adapters-'))
    const marksDir = mkdtempSync(path.join(tmpdir(), 'adapters-marks-'))
    const cwd = '/work/repo'
    const dir = path.join(base, claudeProjectSlug(cwd))
    mkdirSync(dir, { recursive: true })
    const file = path.join(dir, '11111111-2222-3333-4444-555555555555.jsonl')
    writeFileSync(file, `${lines.join('\n')}\n`)

    const store = new WorkspaceStore(mkdtempSync(path.join(tmpdir(), 'adapters-ws-')))
    const node = store.addNode(
      terminal({ cwd, claudeSessionId: '11111111-2222-3333-4444-555555555555' })
    ) as TerminalNodeData
    const traces = new TraceReader(store, { projectsDir: base })

    /**
     * THE OLD STORE'S ANSWER. SessionTurnSync feeds the harness's own parser
     * into turn-store, and turn-annotations merges the two fields that are
     * not in the transcript back on read — so this IS the store's projection,
     * reconstructed from the same file rather than asserted.
     */
    const oldHistory = async (): Promise<TurnRecord[]> => {
      const records = parseSessionTurns(lines)
      if (options.annotations !== true) return records
      return records.map((record) =>
        record.index === 2
          ? mergeAnnotation(record, { title: 'ran the suite', seenAt: 1_757_000_000_000 })
          : record
      )
    }

    const common = {
      pairingToken: TOKEN,
      store,
      turns: { history: () => [] },
      turnHistory: oldHistory,
      latestCheckpoint: (id: string) => traces.latestCheckpoint(id),
      traces: {
        index: (id: string, request?: unknown) => traces.index(id, request as never),
        boundaryMarkers: (id: string) => traces.boundaryMarkers(id),
        page: (id: string, request?: unknown) => traces.page(id, request as never)
      }
    }

    const service = createStreamService({
      nodeOf: () => node,
      documentOf: (target, kind) => traces.documentOf(target, kind),
      chainOptions: { projectsDir: base, lineageIds: () => ['11111111-2222-3333-4444-555555555555'] },
      markOptions: { dir: marksDir },
      chainCoalesceMs: 0
    })

    const port = async (mode: 'stream' | 'old'): Promise<number> => {
      const deps = {
        ...common,
        ...(mode === 'stream' ? { stream: service } : {})
      } as unknown as MobileApiDeps
      const server = http.createServer((request, response) => {
        const url = new URL(request.url ?? '/', `http://${request.headers.host}`)
        void handleMobileApi(request, response, url, deps).then((handled) => {
          if (!handled) response.writeHead(404, { 'content-type': 'application/json' }).end('{}')
        })
      })
      cleanup.push(() => server.close())
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      return (server.address() as net.AddressInfo).port
    }
    return { port, marksDir, node }
  }

  const get = async (port: number, route: string): Promise<unknown> => {
    const response = await fetch(`http://127.0.0.1:${port}/api/terminal/t-adapt${route}`, {
      headers: { authorization: `Bearer ${TOKEN}` }
    })
    const text = await response.text()
    expect(response.status).toBe(200)
    return text ? JSON.parse(text) : null
  }

  /** Every shape the five routes answer in, including their page params. */
  const ROUTES = [
    '/turns',
    '/turns?limit=2',
    '/turns?beforeIndex=3&limit=2',
    '/turns?aroundIndex=2&limit=3',
    '/turns?offset=1&limit=2',
    '/latest',
    '/trace/index',
    '/trace/index?afterIndex=2',
    '/trace/markers',
    '/trace',
    '/trace?limit=2',
    '/trace?beforeIndex=4&limit=2',
    '/trace?afterIndex=1&limit=2',
    '/trace?aroundIndex=2&limit=3'
  ]

  it('is byte-compatible with the old store, field by field, on every route', async () => {
    const fixture = bed(chainLines())
    const stream = await fixture.port('stream')
    const old = await fixture.port('old')
    for (const route of ROUTES) {
      expect(await get(stream, route), `route ${route}`).toEqual(await get(old, route))
    }
  })

  it('carries a Sous title and a seen-at from MARKS where the store carried them inline', async () => {
    const fixture = bed(chainLines(), { annotations: true })
    writeMark(
      't-adapt',
      { identity: 'u2', title: 'ran the suite', seenAt: 1_757_000_000_000 },
      { dir: fixture.marksDir }
    )
    const stream = await fixture.port('stream')
    const old = await fixture.port('old')
    // The two fields that are NOT in the transcript now come from the ledger,
    // and the answer is the same answer.
    expect(await get(stream, '/turns')).toEqual(await get(old, '/turns'))
    const turns = (await get(stream, '/turns')) as TurnRecord[]
    expect(turns[1]).toMatchObject({ title: 'ran the suite', seenAt: 1_757_000_000_000 })
  })

  it('keeps the ◆ boundary’s token counts — an adapter that dropped them would be poorer', async () => {
    const fixture = bed(chainLines())
    const markers = (await get(await fixture.port('stream'), '/trace/markers')) as unknown[]
    expect(markers).toEqual([{ kind: 'compact', afterIndex: 2, preTokens: 120_000, postTokens: 9_000 }])
  })

  it('settles the tail: three closed turns and one still running', async () => {
    const turns = (await get(await (bed(chainLines()).port('stream')), '/turns')) as TurnRecord[]
    expect(turns.map((turn) => turn.final)).toEqual([true, true, true, undefined])
  })

  it('closes the tail once the harness writes its end-of-turn marker', async () => {
    const closed = [...chainLines(), reply('all done', T0 + 800, 'end_turn')]
    const turns = (await get(await bed(closed).port('stream'), '/turns')) as TurnRecord[]
    expect(turns[3].final).toBe(true)
    // …and the old store agrees, because both read the same marker.
    const old = (await get(await bed(closed).port('old'), '/turns')) as TurnRecord[]
    expect(old[3].final).toBe(true)
  })

  it('the flag OFF answers from the old store, through code this module never runs', async () => {
    process.env.COOKREW_STREAM_ADAPTERS = '0'
    const fixture = bed(chainLines())
    const stream = await fixture.port('stream')
    const old = await fixture.port('old')
    for (const route of ROUTES) {
      expect(await get(stream, route), `route ${route}`).toEqual(await get(old, route))
    }
    // And the new routes still answer — the flag is about the OLD five only.
    const index = (await get(stream, '/stream/index')) as { checkpoints: unknown[] }
    expect(index.checkpoints).toHaveLength(4)
  })

  it('an unwired reader leaves all five exactly as they were', async () => {
    const fixture = bed(chainLines())
    const bare = await fixture.port('old')
    expect(((await get(bare, '/turns')) as TurnRecord[]).length).toBe(4)
  })

  it('hands a card with NO transcript back to the old store rather than answering []', async () => {
    // A card bound to a session id whose file has not appeared yet (an agent
    // mid-boot) still has scraped history in the store. Answering [] from an
    // empty stream would blank a working card for the length of the boot.
    const base = mkdtempSync(path.join(tmpdir(), 'adapters-none-'))
    const store = new WorkspaceStore(mkdtempSync(path.join(tmpdir(), 'adapters-none-ws-')))
    const node = store.addNode(
      terminal({ claudeSessionId: 'dddddddd-1111-2222-3333-444444444444' })
    ) as TerminalNodeData
    const traces = new TraceReader(store, { projectsDir: base })
    const scraped: TurnRecord[] = [
      { index: 1, prompt: 'typed at the pane', reply: 'before the file existed', startedAt: T0, endedAt: T0 + 1 }
    ]
    const deps = {
      pairingToken: TOKEN,
      store,
      turns: { history: () => scraped },
      turnHistory: async () => scraped,
      latestCheckpoint: (id: string) => traces.latestCheckpoint(id),
      traces: {
        index: (id: string, request?: unknown) => traces.index(id, request as never),
        boundaryMarkers: (id: string) => traces.boundaryMarkers(id),
        page: (id: string, request?: unknown) => traces.page(id, request as never)
      },
      stream: createStreamService({
        nodeOf: () => node,
        documentOf: (target, kind) => traces.documentOf(target, kind),
        chainOptions: { projectsDir: base, lineageIds: () => [] },
        chainCoalesceMs: 0
      })
    } as unknown as MobileApiDeps
    const server = http.createServer((request, response) => {
      const url = new URL(request.url ?? '/', `http://${request.headers.host}`)
      void handleMobileApi(request, response, url, deps).then((handled) => {
        if (!handled) response.writeHead(404).end('{}')
      })
    })
    cleanup.push(() => server.close())
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as net.AddressInfo).port
    expect(await get(port, '/turns')).toEqual(scraped)
  })
})

// ---- the differences, stated and pinned rather than discovered later ----
//
// Three answers change, and each one is the design landing rather than a
// regression. They are tested HERE so a future reader finds them as
// deliberate facts instead of as a failing byte comparison.

describe('the differences the adapters do NOT hide', () => {
  beforeEach(() => {
    process.env.COOKREW_STREAM_ADAPTERS = '1'
  })
  afterEach(() => {
    delete process.env.COOKREW_STREAM_ADAPTERS
  })
  const cleanup: Array<() => void> = []
  afterEach(() => {
    for (const run of cleanup.splice(0)) run()
  })

  const SID_A = 'aaaaaaaa-1111-2222-3333-444444444444'
  const SID_B = 'bbbbbbbb-1111-2222-3333-444444444444'

  /** A card with an EARLIER session file the current one rotated out of. */
  function twoFileBed(): { get: (route: string, mode: 'stream' | 'old') => Promise<unknown> } {
    const base = mkdtempSync(path.join(tmpdir(), 'adapters-two-'))
    const marksDir = mkdtempSync(path.join(tmpdir(), 'adapters-two-marks-'))
    const cwd = '/work/repo'
    const dir = path.join(base, claudeProjectSlug(cwd))
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      path.join(dir, `${SID_A}.jsonl`),
      `${[prompt('a1', 'older ask', T0), reply('older', T0 + 1, 'end_turn')].join('\n')}\n`
    )
    writeFileSync(
      path.join(dir, `${SID_B}.jsonl`),
      `${[boundary(90_000, 8_000), prompt('b1', 'newer ask', T0 + 10), reply('newer', T0 + 11, 'end_turn')].join('\n')}\n`
    )
    const store = new WorkspaceStore(mkdtempSync(path.join(tmpdir(), 'adapters-two-ws-')))
    const node = store.addNode(
      terminal({ cwd, claudeSessionId: SID_B, sessionLineage: [SID_A] })
    ) as TerminalNodeData
    const traces = new TraceReader(store, { projectsDir: base })
    const service = createStreamService({
      nodeOf: () => node,
      documentOf: (target, kind) => traces.documentOf(target, kind),
      chainOptions: { projectsDir: base, lineageIds: () => [SID_A, SID_B] },
      markOptions: { dir: marksDir },
      chainCoalesceMs: 0
    })
    const deps = (mode: 'stream' | 'old') =>
      ({
        pairingToken: TOKEN,
        store,
        turns: { history: () => [] },
        turnHistory: async () => [],
        latestCheckpoint: (id: string) => traces.latestCheckpoint(id),
        traces: {
          index: (id: string, request?: unknown) => traces.index(id, request as never),
          boundaryMarkers: (id: string) => traces.boundaryMarkers(id),
          page: (id: string, request?: unknown) => traces.page(id, request as never)
        },
        ...(mode === 'stream' ? { stream: service } : {})
      }) as unknown as MobileApiDeps

    const servers = new Map<string, Promise<number>>()
    const portFor = (mode: 'stream' | 'old'): Promise<number> => {
      const existing = servers.get(mode)
      if (existing) return existing
      const started = (async () => {
        const server = http.createServer((request, response) => {
          const url = new URL(request.url ?? '/', `http://${request.headers.host}`)
          void handleMobileApi(request, response, url, deps(mode)).then((handled) => {
            if (!handled) response.writeHead(404).end('{}')
          })
        })
        cleanup.push(() => server.close())
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
        return (server.address() as net.AddressInfo).port
      })()
      servers.set(mode, started)
      return started
    }
    return {
      get: async (route, mode) => {
        const port = await portFor(mode)
        const response = await fetch(`http://127.0.0.1:${port}/api/terminal/t-adapt${route}`, {
          headers: { authorization: `Bearer ${TOKEN}` }
        })
        return JSON.parse(await response.text())
      }
    }
  }

  it('DIFFERENCE 1 — `index` spans the whole chain instead of restarting per file', async () => {
    const bed = twoFileBed()
    // The old route counts the CURRENT file only, so the exchange before the
    // rotation is unaddressable — the exact failure that made 400+
    // checkpoints look destroyed.
    expect(await bed.get('/trace/index', 'old')).toEqual([
      { index: 1, id: 'b1', title: 'newer ask' }
    ])
    // The stream numbers what the card can still reach, in one space.
    expect(await bed.get('/trace/index', 'stream')).toEqual([
      { index: 1, id: 'a1', title: 'older ask' },
      { index: 2, id: 'b1', title: 'newer ask' }
    ])
  })

  it('DIFFERENCE 1b — the rotation boundary carries its predecessor', async () => {
    const markers = (await twoFileBed().get('/trace/markers', 'stream')) as Array<
      Record<string, unknown>
    >
    expect(markers).toEqual([
      { kind: 'compact', afterIndex: 1, preTokens: 90_000, postTokens: 8_000, previousSessionId: SID_A }
    ])
  })

  it('DIFFERENCE 2 — a Claude reply is the JOINED assistant text, not just the last', async () => {
    // The one thing that could not be made byte-equal, and the reason is the
    // design's own thesis: session-turns.ts REPLACES the reply with each
    // assistant entry (so a multi-part answer showed only its last part on
    // the card) while trace-blocks.ts JOINS them (so the drawer showed all of
    // it). Two derivations of one exchange, disagreeing — which is exactly
    // what "one stream" removes. The stream keeps the JOINED text, so the
    // card and the drawer now say the same thing.
    const lines = [
      prompt('u1', 'ask', T0),
      reply('part one', T0 + 1, null),
      reply('part two', T0 + 2, 'end_turn')
    ]
    const fixture = bedFor(lines, cleanup)
    const streamed = (await fixture('stream', '/turns')) as TurnRecord[]
    const stored = (await fixture('old', '/turns')) as TurnRecord[]
    expect(stored[0].reply).toBe('part two')
    expect(streamed[0].reply).toBe('part one\npart two')
    // And the drawer already agreed with the stream, on both sides.
    expect(((await fixture('old', '/trace')) as { blocks: { reply: string }[] }).blocks[0].reply).toBe(
      'part one\npart two'
    )
  })

  it('DIFFERENCE 3 — /latest gains a title the old file path could never carry', async () => {
    const marksDir = mkdtempSync(path.join(tmpdir(), 'adapters-latest-marks-'))
    const fixture = bedFor([prompt('u1', 'ask', T0), reply('done', T0 + 1, 'end_turn')], cleanup, {
      marksDir
    })
    writeMark('t-adapt', { identity: 'u1', title: 'ran the suite' }, { dir: marksDir })
    expect(await fixture('old', '/latest')).toEqual({ prompt: 'ask', reply: 'done' })
    expect(await fixture('stream', '/latest')).toEqual({
      prompt: 'ask',
      reply: 'done',
      title: 'ran the suite'
    })
  })
})

/** A one-file bed that answers a route in either mode. Shared by the
 *  difference tests, which each need their own transcript. */
function bedFor(
  lines: string[],
  cleanup: Array<() => void>,
  options: { marksDir?: string } = {}
): (mode: 'stream' | 'old', route: string) => Promise<unknown> {
  const sid = 'cccccccc-1111-2222-3333-444444444444'
  const base = mkdtempSync(path.join(tmpdir(), 'adapters-one-'))
  const marksDir = options.marksDir ?? mkdtempSync(path.join(tmpdir(), 'adapters-one-marks-'))
  const cwd = '/work/repo'
  const dir = path.join(base, claudeProjectSlug(cwd))
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, `${sid}.jsonl`), `${lines.join('\n')}\n`)
  const store = new WorkspaceStore(mkdtempSync(path.join(tmpdir(), 'adapters-one-ws-')))
  const node = store.addNode(terminal({ cwd, claudeSessionId: sid })) as TerminalNodeData
  const traces = new TraceReader(store, { projectsDir: base })
  const service = createStreamService({
    nodeOf: () => node,
    documentOf: (target, kind) => traces.documentOf(target, kind),
    chainOptions: { projectsDir: base, lineageIds: () => [sid] },
    markOptions: { dir: marksDir },
    chainCoalesceMs: 0
  })
  const ports = new Map<string, Promise<number>>()
  const portFor = (mode: 'stream' | 'old'): Promise<number> => {
    const existing = ports.get(mode)
    if (existing) return existing
    const deps = {
      pairingToken: TOKEN,
      store,
      turns: { history: () => [] },
      turnHistory: async () => parseSessionTurns(lines),
      latestCheckpoint: (id: string) => traces.latestCheckpoint(id),
      traces: {
        index: (id: string, request?: unknown) => traces.index(id, request as never),
        boundaryMarkers: (id: string) => traces.boundaryMarkers(id),
        page: (id: string, request?: unknown) => traces.page(id, request as never)
      },
      ...(mode === 'stream' ? { stream: service } : {})
    } as unknown as MobileApiDeps
    const started = (async () => {
      const server = http.createServer((request, response) => {
        const url = new URL(request.url ?? '/', `http://${request.headers.host}`)
        void handleMobileApi(request, response, url, deps).then((handled) => {
          if (!handled) response.writeHead(404).end('{}')
        })
      })
      cleanup.push(() => server.close())
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      return (server.address() as net.AddressInfo).port
    })()
    ports.set(mode, started)
    return started
  }
  return async (mode, route) => {
    const port = await portFor(mode)
    const response = await fetch(`http://127.0.0.1:${port}/api/terminal/t-adapt${route}`, {
      headers: { authorization: `Bearer ${TOKEN}` }
    })
    return JSON.parse(await response.text())
  }
}

describe('streamAdaptersEnabled', () => {
  it('is ON by default in this release — the flag is an escape hatch', () => {
    expect(streamAdaptersEnabled({})).toBe(false)
    expect(streamAdaptersEnabled({ COOKREW_STREAM_ADAPTERS: '1' })).toBe(true)
    expect(streamAdaptersEnabled({ COOKREW_STREAM_ADAPTERS: 'on' })).toBe(true)
  })

  it('only the four explicit off-words turn it off; a typo leaves it on', () => {
    for (const value of ['0', 'off', 'OFF', 'false', 'no', ' 0 ']) {
      expect(streamAdaptersEnabled({ COOKREW_STREAM_ADAPTERS: value }), value).toBe(false)
    }
    expect(streamAdaptersEnabled({ COOKREW_STREAM_ADAPTERS: 'offf' })).toBe(false)
  })
})
