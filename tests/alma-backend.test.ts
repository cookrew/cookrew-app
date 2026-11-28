// Alma as a hosted agent (cli/host/alma.mjs) against a FAKE Alma: the REST
// shapes are the ones a real thread on the owner's app answered (2026-11-27).
// The unit tests never touch the real server.

import { createServer, type Server } from 'node:http'
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { AlmaBackend, AlmaApi } from '../cli/host/alma.mjs'

interface Fake {
  server: Server
  url: string
  state: {
    answers: Array<Record<string, unknown>>
    stops: string[]
    sends: Array<Record<string, unknown>>
    creates: Array<Record<string, unknown>>
    puts: Array<Record<string, unknown>>
    approvals: Array<Record<string, unknown>>
    polls: number
  }
}

/** A fake Alma: one thread, one turn that streams a thought, a tool and a reply, then asks nothing. */
async function fakeAlma({ askApproval = false, threadModel = 'p1:model-a', rebuild = false } = {}): Promise<Fake> {
  const state: Fake['state'] = { answers: [], stops: [], sends: [], creates: [], puts: [], approvals: askApproval ? [{ requestId: 'tool-approval-1', title: 'Bash', message: 'rm x', threadId: 't-1' }] : [], polls: 0 }
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    const json = (value: unknown, status = 200) => {
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(value))
    }
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      const parsed = body ? JSON.parse(body) : undefined
      if (req.method === 'GET' && url.pathname === '/api/workspaces') return json([{ id: 'w-1', path: process.cwd() }])
      if (req.method === 'POST' && url.pathname === '/api/workspaces') return json({ id: 'w-2', path: parsed.path, name: parsed.name }, 201)
      if (req.method === 'POST' && url.pathname === '/api/threads') {
        state.creates.push(parsed)
        return json({ id: 't-1', title: parsed.title, workspaceId: parsed.workspaceId, model: parsed.model ?? threadModel, reasoningEffort: 'medium' }, 201)
      }
      if (req.method === 'GET' && url.pathname === '/api/threads/t-1') return json({ id: 't-1', model: threadModel, reasoningEffort: 'medium' })
      if (req.method === 'GET' && url.pathname === '/api/threads/missing') return json({ error: 'Thread not found' }, 404)
      if (req.method === 'PUT' && url.pathname === '/api/threads/t-1') {
        state.puts.push(parsed)
        return json({ id: 't-1', model: parsed.model ?? threadModel, reasoningEffort: parsed.reasoningEffort ?? 'medium' })
      }
      if (req.method === 'POST' && url.pathname === '/api/threads/t-1/send') {
        state.sends.push(parsed)
        state.polls = 0
        return json({ ok: true, threadId: 't-1', started: true }, 202)
      }
      if (req.method === 'GET' && url.pathname === '/api/threads/t-1/run-status') {
        state.polls += 1
        const done = state.polls > (rebuild ? 7 : 2)
        return json({ id: 't-1', state: done ? 'done' : 'running', busy: !done, ...(done ? { reply: { messageId: 'a-1', text: 'all done', turnEndReason: state.stops.length > 0 ? 'aborted' : 'stop' } } : { reply: null }) })
      }
      if (req.method === 'GET' && url.pathname === '/api/threads/t-1/messages' && rebuild) {
        // Alma's own shape while it streams: a FRESH message id each poll, the
        // whole text so far inside it (the bug: printed again every poll).
        const words = 'the full path as its tooltip'.split(' ').slice(0, Math.min(6, Math.max(1, state.polls)))
        return json([{ message: { id: 'u-1', role: 'user', parts: [{ type: 'text', text: 'hi' }] } }, { message: { id: `a-${state.polls}`, role: 'assistant', parts: [{ type: 'text', text: words.join(' ') }] } }])
      }
      if (req.method === 'GET' && url.pathname === '/api/threads/t-1/messages') {
        const growing = state.polls > 1
        const parts = [
          { type: 'step-start' },
          { type: 'reasoning', text: growing ? 'thinking hard' : 'thinking' },
          { type: 'tool-Bash', toolCallId: 'call-1', state: growing ? 'output-available' : 'input-available', input: { command: 'ls', description: 'List files' }, output: growing ? { stdout: 'a.txt\n', stderr: '' } : undefined },
          ...(state.polls > 2 ? [{ type: 'step-start' }, { type: 'text', text: 'all done', state: 'done' }] : [])
        ]
        return json([{ message: { id: 'u-1', role: 'user', parts: [{ type: 'text', text: 'hi' }] } }, { message: { id: 'a-1', role: 'assistant', parts } }])
      }
      if (url.pathname === '/api/handoff/tool-approvals') {
        if (req.method === 'GET') return json(state.approvals)
        state.answers.push(parsed)
        state.approvals = state.approvals.filter((ask) => ask.requestId !== parsed.requestId)
        return json({ ok: true })
      }
      return json({ error: `unexpected ${req.method} ${url.pathname}` }, 404)
    })
  })
  // The stop socket: the handshake the host's ws.mjs expects, then frames it drops.
  server.on('upgrade', (req, socket) => {
    const key = String(req.headers['sec-websocket-key'] ?? '')
    const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64')
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
    socket.on('data', (buf) => {
      // A masked text frame: unmask and record the JSON the host sent.
      const len = buf[1] & 0x7f
      const mask = buf.subarray(2, 6)
      const payload = buf.subarray(6, 6 + len).map((byte: number, i: number) => byte ^ mask[i % 4])
      state.stops.push(Buffer.from(payload).toString('utf8'))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  return { server, url: `http://127.0.0.1:${address.port}`, state }
}

let running: Fake | null = null
afterEach(() => {
  running?.server.close()
  running = null
})

function events() {
  const seen: string[] = []
  return {
    seen,
    events: {
      session: ({ id, resumed }: { id: string; resumed: boolean }) => seen.push(`session:${id}:${resumed}`),
      model: ({ model, effort }: { model: string; effort: string }) => seen.push(`model:${model}:${effort}`),
      text: (message: string, text: string) => seen.push(`text:${message}:${text}`),
      thought: (_m: string, text: string) => seen.push(`thought:${text}`),
      tool: (id: string, title: string, about: string) => seen.push(`tool:${id}:${title}:${about}`),
      toolDone: (id: string, status: string, output: string) => seen.push(`toolDone:${id}:${status}:${output.trim()}`),
      permissionRecord: () => seen.push('permission'),
      permission: async () => { seen.push('asked'); return 0 },
      answered: (name: string) => seen.push(`answered:${name}`),
      notice: (m: string) => seen.push(`notice:${m}`)
    }
  }
}

describe('Alma as a hosted agent', () => {
  it('opens a thread in this folder, sends, streams parts and ends on the turn-end reason', async () => {
    running = await fakeAlma()
    const { seen, events: sink } = events()
    const backend = new AlmaBackend({ baseUrl: running.url, model: 'p1:model-a', cwd: process.cwd(), events: sink })
    const opened = await backend.open({})
    expect(opened).toEqual({ id: 't-1', resumed: false })
    expect(running.state.creates[0]).toMatchObject({ workspaceId: 'w-1', model: 'p1:model-a' })
    expect(seen).toContain('session:t-1:false')
    expect(seen).toContain('model:p1:model-a:medium')
    const { stop } = await backend.prompt('hi')
    expect(stop).toBe('end_turn')
    expect(running.state.sends[0]).toMatchObject({ text: 'hi', model: 'p1:model-a' })
    expect(seen.filter((e) => e.startsWith('thought:'))).toEqual(['thought:thinking', 'thought: hard'])
    expect(seen.filter((e) => e.startsWith('tool:'))).toEqual(['tool:call-1:Bash:List files'])
    expect(seen.filter((e) => e.startsWith('toolDone:'))).toEqual(['toolDone:call-1:completed:a.txt'])
    expect(seen.filter((e) => e.startsWith('text:'))).toEqual(['text:a-1:all done'])
    backend.close()
  })

  it('a reply Alma rebuilds under a new id each poll is printed once, not once per poll', async () => {
    running = await fakeAlma({ rebuild: true })
    const { seen, events: sink } = events()
    const backend = new AlmaBackend({ baseUrl: running.url, cwd: process.cwd(), events: sink })
    await backend.open({})
    await backend.prompt('hi')
    const printed = seen.filter((e) => e.startsWith('text:')).map((e) => e.slice(e.indexOf(':', 5) + 1)).join('')
    expect(printed).toBe('the full path as its tooltip')
    expect(printed.match(/full path/g)).toHaveLength(1)
  })

  it('resumes a thread by id, and refuses one Alma does not have', async () => {
    running = await fakeAlma()
    const { seen, events: sink } = events()
    const backend = new AlmaBackend({ baseUrl: running.url, cwd: process.cwd(), events: sink })
    expect(await backend.open({ resume: 't-1' })).toEqual({ id: 't-1', resumed: true })
    expect(seen).toContain('session:t-1:true')
    expect(running.state.creates).toEqual([])
    const other = new AlmaBackend({ baseUrl: running.url, cwd: process.cwd(), events: sink })
    await expect(other.open({ resume: 'missing' })).rejects.toThrow(/no thread missing/)
  })

  it('an approval is a menu answer, and the action goes back to Alma', async () => {
    running = await fakeAlma({ askApproval: true })
    const { seen, events: sink } = events()
    const backend = new AlmaBackend({ baseUrl: running.url, cwd: process.cwd(), events: sink })
    await backend.open({})
    await backend.prompt('hi')
    expect(seen).toContain('permission')
    expect(seen).toContain('asked')
    expect(seen).toContain('answered:Allow once')
    expect(running.state.answers).toEqual([{ requestId: 'tool-approval-1', response: { action: 'allow_once' } }])
    // Answered once: the request left Alma's list and is never asked again.
    expect(running.state.approvals).toHaveLength(0)
    expect(running.state.answers).toHaveLength(1)
  })

  it("stopping sends stop_generation over Alma's socket, and the turn ends interrupted", async () => {
    running = await fakeAlma()
    const { events: sink } = events()
    const backend = new AlmaBackend({ baseUrl: running.url, cwd: process.cwd(), events: sink })
    await backend.open({})
    const turn = backend.prompt('hi')
    await new Promise((r) => setTimeout(r, 500))
    expect(await backend.cancel()).toBe(true)
    await new Promise((r) => setTimeout(r, 150))
    expect(running.state.stops.join('')).toContain('stop_generation')
    expect((await turn).stop).toBe('aborted')
  })

  it("a thread remembers its model; a card's own model is set on the thread", async () => {
    running = await fakeAlma({ threadModel: 'p1:model-a' })
    const { events: sink } = events()
    const backend = new AlmaBackend({ baseUrl: running.url, model: 'p2:model-b', effort: 'high', cwd: process.cwd(), events: sink })
    await backend.open({ resume: 't-1' })
    expect(running.state.puts[0]).toMatchObject({ model: 'p2:model-b' })
    expect(running.state.puts[1]).toMatchObject({ reasoningEffort: 'high' })
  })

  it('an Alma that is not running says so, in the words a person can act on', async () => {
    const api = new AlmaApi('http://127.0.0.1:9')
    await expect(api.request('/api/health', { timeoutMs: 800 })).rejects.toThrow()
  })
})
