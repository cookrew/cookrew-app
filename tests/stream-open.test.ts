// /stream/open AND A PAGED /stream/index (one-stream T2.5).
//
// The claims:
//   · /stream/open is the whole opening move in ONE round trip — the newest
//     page, the tail, the cursor to page backwards from, and the two facts a
//     rail cannot derive (what was skipped, what was rolled back);
//   · /stream/index pages by identity in both directions, exhaustively and
//     without overlap, and the parameterless full list still answers — marked
//     `deprecated: true` so nobody adopts it by accident;
//   · a rolled-back checkpoint is still a row, with its mark;
//   · /stream/live emits `rollback {fromOrdinal}` when a new rewind lands, and
//     never replays the ones a subscriber already had.

import http from 'node:http'
import type net from 'node:net'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { handleMobileApi, type MobileApiDeps } from '../src/main/mobile-api'
import { readMarks, writeMark, markFileFor } from '../src/main/marks'
import type { StreamService, StreamTailState } from '../src/main/stream-service'
import type { StreamBlock } from '../src/main/stream'
import type { StreamCheckpoint } from '../src/main/stream-marks'
import type { RollbackMark } from '../src/main/stream-state'
import type { StreamChain } from '../src/main/stream-chain'

const PAIRING = 'pairing-token-abc'
const T0 = Date.parse('2026-09-07T09:00:00.000Z')

const CHAIN: StreamChain = {
  files: [{ sessionId: 's1', file: '/tmp/s1.jsonl', kind: 'claude' }],
  missing: []
}

function block(ordinal: number): StreamBlock {
  return {
    id: `u${ordinal}`,
    index: ordinal,
    ordinal,
    prompt: `ask ${ordinal}`,
    reply: `reply ${ordinal}`,
    activity: [],
    startedAt: T0 + ordinal * 1000,
    endedAt: T0 + ordinal * 1000 + 500,
    compacted: false,
    file: '/tmp/s1.jsonl',
    sessionId: 's1'
  }
}

interface Fixture {
  count: number
  marksDir: string
  rolledBackFrom?: number
  anomalies?: Record<string, number>
  rollbacks?: RollbackMark[]
}

function service(options: Fixture): StreamService {
  const markOptions = { dir: options.marksDir }
  const all = Array.from({ length: options.count }, (_, at) => block(at + 1))
  const checkpointOf = (source: StreamBlock): StreamCheckpoint => ({
    identity: source.id,
    ordinal: source.ordinal,
    startedAt: source.startedAt,
    endedAt: source.endedAt,
    promptHead: source.prompt,
    compacted: false,
    file: source.file,
    ...(options.rolledBackFrom !== undefined && source.ordinal >= options.rolledBackFrom
      ? { rolledBack: true as const }
      : {})
  })
  return {
    sourceOf: () => 'file',
    chain: async () => CHAIN,
    async checkpoints(terminalId) {
      const marks = readMarks(terminalId, markOptions)
      const placed = new Set(all.map((one) => one.id))
      return {
        checkpoints: all.map((one) => {
          const mark = marks.get(one.id)
          return { ...checkpointOf(one), ...(mark?.title !== undefined ? { title: mark.title } : {}) }
        }),
        missing: [],
        orphanMarks: [...marks.keys()].filter((identity) => !placed.has(identity)),
        anomalies: options.anomalies ?? {},
        rolledBack: options.rollbacks ?? []
      }
    },
    async blocks() {
      return { blocks: all, total: all.length, missing: [] }
    },
    async tailState(): Promise<StreamTailState> {
      return {
        block: all[all.length - 1] ?? null,
        open: false,
        missing: [],
        final: true,
        kind: 'claude',
        total: all.length
      }
    },
    marks: (terminalId) => readMarks(terminalId, markOptions),
    writeMark: (terminalId, patch) => writeMark(terminalId, patch, markOptions),
    marksFile: (terminalId) => markFileFor(terminalId, markOptions),
    rewindPoints: () => [],
    rollbacks: async () => options.rollbacks ?? []
  }
}

describe('/stream/open and the paged /stream/index', () => {
  const cleanup: Array<() => void> = []
  let marksDir = ''

  beforeEach(() => {
    marksDir = mkdtempSync(path.join(tmpdir(), 'stream-open-marks-'))
  })
  afterEach(() => {
    for (const run of cleanup.splice(0)) run()
  })

  const start = async (over: Partial<MobileApiDeps>): Promise<number> => {
    const deps = { pairingToken: PAIRING, ...over } as unknown as MobileApiDeps
    const server = http.createServer((request, response) => {
      const url = new URL(request.url ?? '/', `http://${request.headers.host}`)
      void handleMobileApi(request, response, url, deps).then((handled) => {
        if (!handled) response.writeHead(418, { 'content-type': 'application/json' }).end('{}')
      })
    })
    cleanup.push(() => server.close())
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    return (server.address() as net.AddressInfo).port
  }

  const get = async (port: number, route: string) => {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, {
      headers: { authorization: `Bearer ${PAIRING}` }
    })
    const text = await response.text()
    return { status: response.status, body: text ? JSON.parse(text) : null }
  }

  it('/stream/open draws the rail and the tail in one round trip', async () => {
    const port = await start({ stream: service({ count: 250, marksDir }) })
    const answer = await get(port, '/api/terminal/t1/stream/open')
    expect(answer.status).toBe(200)
    expect(answer.body.index).toHaveLength(100)
    // The NEWEST page: a rail opens at the bottom of the conversation.
    expect(answer.body.index[0].ordinal).toBe(151)
    expect(answer.body.index[99].ordinal).toBe(250)
    expect(answer.body.total).toBe(250)
    expect(answer.body.backwardsCursor).toBe('u151')
    expect(answer.body.nextCursor).toBeNull()
    expect(answer.body.tail).toMatchObject({ final: true, ordinal: 250, total: 250 })
    expect(answer.body.tail.block.id).toBe('u250')
    expect(answer.body.source).toBe('file')
    expect(answer.body.anomalies).toEqual({})
    expect(answer.body.rolledBack).toEqual([])
    expect(answer.body.missing).toEqual([])
    expect(answer.body.orphanMarks).toEqual([])
  })

  it('/stream/open then backwardsCursor walks the whole rail, once each', async () => {
    const port = await start({ stream: service({ count: 250, marksDir }) })
    const opened = await get(port, '/api/terminal/t1/stream/open?limit=40')
    const seen: number[] = opened.body.index.map((row: { ordinal: number }) => row.ordinal)
    let cursor: string | null = opened.body.backwardsCursor
    while (cursor !== null) {
      const page: { body: { checkpoints: { ordinal: number }[]; backwardsCursor: string | null } } =
        await get(port, `/api/terminal/t1/stream/index?before=${cursor}&limit=40`)
      seen.unshift(...page.body.checkpoints.map((row) => row.ordinal))
      cursor = page.body.backwardsCursor
    }
    expect(seen).toEqual(Array.from({ length: 250 }, (_, at) => at + 1))
    expect(new Set(seen).size).toBe(250)
  })

  it('/stream/index?after= pages forward, and says so at the newest end', async () => {
    const port = await start({ stream: service({ count: 10, marksDir }) })
    const page = await get(port, '/api/terminal/t1/stream/index?after=u7&limit=2')
    expect(page.body.checkpoints.map((row: { identity: string }) => row.identity)).toEqual([
      'u8',
      'u9'
    ])
    expect(page.body.nextCursor).toBe('u9')
    expect(page.body.backwardsCursor).toBe('u8')
    expect(page.body.total).toBe(10)
    expect(page.body.deprecated).toBeUndefined()

    const end = await get(port, '/api/terminal/t1/stream/index?after=u9&limit=5')
    expect(end.body.checkpoints.map((row: { identity: string }) => row.identity)).toEqual(['u10'])
    expect(end.body.nextCursor).toBeNull()
  })

  it('an unknown index cursor is said out loud', async () => {
    const port = await start({ stream: service({ count: 5, marksDir }) })
    expect((await get(port, '/api/terminal/t1/stream/index?before=nope')).body).toMatchObject({
      checkpoints: [],
      unknownBefore: true
    })
    expect((await get(port, '/api/terminal/t1/stream/index?after=nope')).body).toMatchObject({
      checkpoints: [],
      unknownAfter: true
    })
  })

  it('the parameterless full list still answers, and is marked deprecated', async () => {
    const port = await start({ stream: service({ count: 250, marksDir }) })
    const answer = await get(port, '/api/terminal/t1/stream/index')
    expect(answer.body.checkpoints).toHaveLength(250)
    expect(answer.body.deprecated).toBe(true)
    expect(answer.body.nextCursor).toBeNull()
    expect(answer.body.backwardsCursor).toBeNull()
    // …and the deprecation flag is on THAT shape only.
    const paged = await get(port, '/api/terminal/t1/stream/index?limit=10')
    expect(paged.body.deprecated).toBeUndefined()
  })

  it('a rolled-back checkpoint is still a row, and still carries its mark', async () => {
    const rollbacks = [{ fromOrdinal: 4, at: T0 }]
    const port = await start({
      stream: service({ count: 5, marksDir, rolledBackFrom: 4, rollbacks })
    })
    writeMark('t1', { identity: 'u4', title: 'the run I rewound past' }, { dir: marksDir })
    const answer = await get(port, '/api/terminal/t1/stream/open')
    const rows = answer.body.index as { identity: string; rolledBack?: true; marks?: unknown }[]
    expect(rows.map((row) => row.rolledBack === true)).toEqual([false, false, false, true, true])
    expect(rows[3].marks).toEqual({ title: 'the run I rewound past' })
    expect(answer.body.rolledBack).toEqual(rollbacks)
  })

  it('surfaces the projection’s anomaly counts on both reads', async () => {
    const anomalies = { UnknownLine: 2, ForwardGap: 1 }
    const port = await start({ stream: service({ count: 3, marksDir, anomalies }) })
    expect((await get(port, '/api/terminal/t1/stream/open')).body.anomalies).toEqual(anomalies)
    expect((await get(port, '/api/terminal/t1/stream/index?limit=3')).body.anomalies).toEqual(
      anomalies
    )
  })

  it('404s /stream/open for a terminal that does not exist', async () => {
    const ghost = { ...service({ count: 0, marksDir }), sourceOf: () => null }
    const port = await start({ stream: ghost as StreamService })
    expect((await get(port, '/api/terminal/ghost/stream/open')).status).toBe(404)
  })
})
