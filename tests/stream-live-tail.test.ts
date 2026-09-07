// THE LIVE TAIL OVER SSE (one-stream T2).
//
// The bound the design asks for, tested rather than asserted in a comment:
// ONE tail read per change. A growing fixture file emits exactly one `tail`
// per append and NOTHING while the bytes stand still — because a live rail
// ticks forever over transcripts that run to 119 MB, and a reader that
// re-read on every tick is the O(n²) this whole design exists to remove.
//
// Also here: the heartbeat, the `mark` events when the ledger changes, and
// `final` landing when the harness ends the turn.

import http from 'node:http'
import type net from 'node:net'
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { handleStreamLive } from '../src/main/stream-live'
import { createStreamService } from '../src/main/stream-service'
import { TraceReader } from '../src/main/trace'
import { WorkspaceStore } from '../src/main/store'
import { claudeProjectSlug } from '../src/shared/claude-fork'
import { writeMark } from '../src/main/marks'
import type { TerminalNodeData } from '../src/shared/model'

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

interface Frame {
  event: string
  data: Record<string, unknown>
}

/** Parse whatever whole SSE frames have arrived so far. */
function framesOf(text: string): Frame[] {
  return text
    .split('\n\n')
    .filter((chunk) => chunk.startsWith('event: '))
    .map((chunk) => {
      const [head, ...rest] = chunk.split('\n')
      return {
        event: head.slice('event: '.length),
        data: JSON.parse(rest.join('\n').slice('data: '.length)) as Record<string, unknown>
      }
    })
}

function terminal(patch: Partial<TerminalNodeData>): TerminalNodeData {
  return {
    kind: 'terminal',
    id: 't-live',
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

describe('GET /stream/live', () => {
  const cleanup: Array<() => void> = []
  afterEach(() => {
    for (const run of cleanup.splice(0)) run()
  })

  /** A real transcript, a real reader, and a counted document read. */
  function bed(lines: string[]) {
    const base = mkdtempSync(path.join(tmpdir(), 'stream-live-'))
    const marksDir = mkdtempSync(path.join(tmpdir(), 'stream-live-marks-'))
    const stateDir = mkdtempSync(path.join(tmpdir(), 'stream-live-state-'))
    const cwd = '/work/repo'
    const dir = path.join(base, claudeProjectSlug(cwd))
    const file = path.join(dir, '22222222-3333-4444-5555-666666666666.jsonl')
    mkdirSync(dir, { recursive: true })
    writeFileSync(file, `${lines.join('\n')}\n`)

    const store = new WorkspaceStore(mkdtempSync(path.join(tmpdir(), 'stream-live-ws-')))
    const node = store.addNode(
      terminal({ cwd, claudeSessionId: '22222222-3333-4444-5555-666666666666' })
    ) as TerminalNodeData
    const traces = new TraceReader(store, { projectsDir: base })
    let reads = 0
    const service = createStreamService({
      nodeOf: () => node,
      documentOf: (target, kind) => {
        reads += 1
        return traces.documentOf(target, kind)
      },
      chainOptions: { projectsDir: base, lineageIds: () => ['22222222-3333-4444-5555-666666666666'] },
      markOptions: { dir: marksDir },
      stateOptions: { dir: stateDir },
      chainCoalesceMs: 0
    })
    return { file, service, marksDir, node, reads: () => reads }
  }

  /** Open the live route and collect frames until `until` is satisfied. */
  async function open(
    service: ReturnType<typeof bed>['service'],
    options: { pollMs: number; heartbeatMs: number }
  ) {
    const server = http.createServer((request, response) => {
      handleStreamLive(request, response, 't-live', 'file', {
        stream: service,
        pollMs: options.pollMs,
        heartbeatMs: options.heartbeatMs
      })
    })
    cleanup.push(() => server.close())
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as net.AddressInfo).port
    const controller = new AbortController()
    cleanup.push(() => controller.abort())
    const response = await fetch(`http://127.0.0.1:${port}/api/terminal/t-live/stream/live`, {
      headers: { 'accept-encoding': 'identity' },
      signal: controller.signal
    })
    const reader = (response.body as ReadableStream<Uint8Array>).getReader()
    let text = ''
    const decoder = new TextDecoder()
    const pump = (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          text += decoder.decode(value, { stream: true })
        }
      } catch {
        // aborted at teardown
      }
    })()
    void pump
    return {
      frames: () => framesOf(text),
      until: async (predicate: (frames: Frame[]) => boolean, ms = 3000) => {
        const deadline = Date.now() + ms
        while (Date.now() < deadline) {
          if (predicate(framesOf(text))) return framesOf(text)
          await new Promise((resolve) => setTimeout(resolve, 10))
        }
        throw new Error(`timed out; saw ${JSON.stringify(framesOf(text).map((f) => f.event))}`)
      },
      close: () => controller.abort()
    }
  }

  it('says hello, then the open tail — a subscriber is never left with nothing', async () => {
    const { service } = bed([prompt('u1', 'first ask', T0), reply('working', T0 + 1, null)])
    const live = await open(service, { pollMs: 25, heartbeatMs: 10_000 })
    const frames = await live.until((f) => f.some((frame) => frame.event === 'tail'))
    expect(frames[0].event).toBe('hello')
    expect(frames[0].data).toMatchObject({ terminalId: 't-live', source: 'file' })
    const tail = frames.find((frame) => frame.event === 'tail') as Frame
    expect(tail.data.final).toBe(false)
    expect(tail.data.ordinal).toBe(1)
    expect((tail.data.block as { id: string }).id).toBe('u1')
  })

  it('emits EXACTLY one tail per append, and nothing while the bytes stand still', async () => {
    const { file, service } = bed([prompt('u1', 'first ask', T0), reply('working', T0 + 1, null)])
    const live = await open(service, { pollMs: 20, heartbeatMs: 10_000 })
    await live.until((f) => f.filter((frame) => frame.event === 'tail').length === 1)

    // Twenty poll ticks with an unchanged file: the change detector stats and
    // stops. No second tail, and — the real bound — no second read.
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(live.frames().filter((frame) => frame.event === 'tail')).toHaveLength(1)

    appendFileSync(file, `${reply('more of the answer', T0 + 2, null)}\n`)
    const grown = await live.until((f) => f.filter((frame) => frame.event === 'tail').length === 2)
    const tails = grown.filter((frame) => frame.event === 'tail')
    expect(tails).toHaveLength(2)
    expect((tails[1].data.block as { reply: string }).reply).toContain('more of the answer')

    appendFileSync(file, `${prompt('u2', 'second ask', T0 + 3)}\n`)
    const next = await live.until((f) => f.filter((frame) => frame.event === 'tail').length === 3)
    const third = next.filter((frame) => frame.event === 'tail')[2]
    expect(third.data.ordinal).toBe(2)
    expect(third.data.total).toBe(2)
  })

  it('reports final when the harness ends the turn — the rule T1 left open', async () => {
    const { file, service } = bed([prompt('u1', 'ask', T0), reply('working', T0 + 1, null)])
    const live = await open(service, { pollMs: 20, heartbeatMs: 10_000 })
    const first = await live.until((f) => f.some((frame) => frame.event === 'tail'))
    expect((first.find((frame) => frame.event === 'tail') as Frame).data.final).toBe(false)

    appendFileSync(file, `${reply('all done', T0 + 2, 'end_turn')}\n`)
    const closed = await live.until((f) =>
      f.some((frame) => frame.event === 'tail' && frame.data.final === true)
    )
    const last = closed.filter((frame) => frame.event === 'tail').pop() as Frame
    // The finished exchange TRAVELS with its verdict: a subscriber that just
    // watched a turn end must not need a second round trip to render it.
    expect(last.data.final).toBe(true)
    expect((last.data.block as { id: string }).id).toBe('u1')
    expect((last.data.block as { reply: string }).reply).toContain('all done')
  })

  it('heartbeats on its own clock so a phone’s EventSource stays convinced', async () => {
    const { service } = bed([prompt('u1', 'ask', T0)])
    const live = await open(service, { pollMs: 5_000, heartbeatMs: 30 })
    const frames = await live.until(
      (f) => f.filter((frame) => frame.event === 'heartbeat').length >= 2
    )
    expect(frames.filter((frame) => frame.event === 'heartbeat').length).toBeGreaterThanOrEqual(2)
    expect(typeof frames.find((frame) => frame.event === 'heartbeat')?.data.at).toBe('number')
  })

  it('pushes a mark event when the ledger changes, and one when it is cleared', async () => {
    const { service, marksDir } = bed([prompt('u1', 'ask', T0)])
    const live = await open(service, { pollMs: 20, heartbeatMs: 10_000 })
    await live.until((f) => f.some((frame) => frame.event === 'tail'))

    writeMark('t-live', { identity: 'u1', title: 'ran the suite' }, { dir: marksDir })
    const titled = await live.until((f) => f.some((frame) => frame.event === 'mark'))
    expect(titled.find((frame) => frame.event === 'mark')?.data).toEqual({
      identity: 'u1',
      mark: { title: 'ran the suite' }
    })

    writeMark('t-live', { identity: 'u1', title: null }, { dir: marksDir })
    const cleared = await live.until(
      (f) => f.filter((frame) => frame.event === 'mark').length >= 2
    )
    // A cleared mark is a CHANGE, not an absence: a client that never hears
    // about it keeps showing a title Sous withdrew.
    expect(cleared.filter((frame) => frame.event === 'mark').pop()?.data).toEqual({
      identity: 'u1',
      mark: null
    })
  })

  it('emits rollback {fromOrdinal} on a /rewind, once, and never replays it', async () => {
    // The one change a live subscriber cannot infer from the tail: the
    // transcript gets SHORTER, so later frames simply stop mentioning the
    // exchanges the rewind took beyond it (T2.5, panel C ②).
    const kept = [prompt('u1', 'first ask', T0), reply('one', T0 + 1, 'end_turn')]
    const { file, service } = bed([
      ...kept,
      prompt('u2', 'second ask', T0 + 2),
      reply('two', T0 + 3, 'end_turn'),
      prompt('u3', 'third ask', T0 + 4),
      reply('three', T0 + 5, 'end_turn')
    ])
    const live = await open(service, { pollMs: 20, heartbeatMs: 10_000 })
    await live.until((f) => f.some((frame) => frame.event === 'tail'))
    expect(live.frames().filter((frame) => frame.event === 'rollback')).toHaveLength(0)

    writeFileSync(file, `${kept.join('\n')}\n`)
    const rolled = await live.until((f) => f.some((frame) => frame.event === 'rollback'))
    expect(rolled.find((frame) => frame.event === 'rollback')?.data).toEqual({ fromOrdinal: 2 })

    // Appended, not re-derived: a subscriber hears about each rewind once.
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(live.frames().filter((frame) => frame.event === 'rollback')).toHaveLength(1)
  })

  it('stops polling when the subscriber goes away', async () => {
    const { service, reads } = bed([prompt('u1', 'ask', T0)])
    const live = await open(service, { pollMs: 15, heartbeatMs: 10_000 })
    await live.until((f) => f.some((frame) => frame.event === 'tail'))
    live.close()
    await new Promise((resolve) => setTimeout(resolve, 100))
    const settled = reads()
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(reads()).toBe(settled)
  })
})
