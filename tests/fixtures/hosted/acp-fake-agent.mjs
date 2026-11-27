// A tiny ACP agent for tests of the host (cli/cookrew-acp.mjs). It speaks
// the slice of ACP v1 that DeepSeek Harness 0.2.2 answered with on
// 2026-11-28: initialize, session/new, session/resume (refused from another
// folder), session/set_config_option, session/prompt, session/cancel,
// session/close. A prompt containing APPROVE asks for permission first; one
// containing SLOW waits to be cancelled. It remembers sessions in
// $FAKE_ACP_STORE so a second process can resume one.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'

const store = process.env.FAKE_ACP_STORE
const load = () => (store && existsSync(store) ? JSON.parse(readFileSync(store, 'utf8')) : {})
const save = (sessions) => store && writeFileSync(store, JSON.stringify(sessions))
let buf = ''
let next = 1000
const waiting = new Map()
let cancelled = null
const send = (m) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`)
const update = (sessionId, u) => send({ method: 'session/update', params: { sessionId, update: u } })
const options = [{ id: 'model', category: 'model', currentValue: '["fake","fake-1"]' }, { id: 'reasoning_effort', category: 'thought_level', currentValue: 'high' }]
const ask = (method, params) => new Promise((resolve) => { next += 1; waiting.set(next, resolve); send({ id: next, method, params }) })

async function handle(m) {
  if (m.id !== undefined && !m.method) { waiting.get(m.id)?.(m.result); waiting.delete(m.id); return }
  const p = m.params ?? {}
  switch (m.method) {
    case 'initialize': return send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: { mcpCapabilities: { http: true }, sessionCapabilities: { resume: {}, close: {} } } } })
    case 'session/new': {
      const id = randomUUID(); const s = load(); s[id] = { cwd: p.cwd, mcp: p.mcpServers, turns: [] }; save(s)
      return send({ id: m.id, result: { sessionId: id, configOptions: options } })
    }
    case 'session/resume': {
      const s = load()[p.sessionId]
      if (!s) return send({ id: m.id, error: { code: -32602, message: `unknown session: ${p.sessionId}` } })
      if (s.cwd !== p.cwd) return send({ id: m.id, error: { code: -32602, message: `Invalid params: session cwd does not match: ${p.cwd}` } })
      return send({ id: m.id, result: { configOptions: options } })
    }
    case 'session/set_config_option': {
      const at = options.findIndex((o) => o.id === p.configId)
      if (at >= 0) options[at] = { ...options[at], currentValue: p.value }
      return send({ id: m.id, result: { configOptions: options } })
    }
    case 'session/close': return send({ id: m.id, result: {} })
    case 'session/cancel': cancelled?.(); return
    case 'session/prompt': {
      const text = p.prompt?.map((b) => b.text).join('') ?? ''
      const s = load(); const memory = s[p.sessionId]?.turns ?? []
      update(p.sessionId, { sessionUpdate: 'agent_thought_chunk', messageId: 'th', content: { type: 'text', text: 'thinking about it' } })
      update(p.sessionId, { sessionUpdate: 'tool_call', toolCallId: 'call-1', title: 'bash', kind: 'other', status: 'in_progress', rawInput: { command: 'echo hi', description: 'Say hi' } })
      if (text.includes('APPROVE')) {
        const answer = await ask('session/request_permission', { sessionId: p.sessionId, toolCall: { toolCallId: 'call-1' }, options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }, { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' }] })
        if (answer?.outcome?.optionId !== 'allow-once') {
          update(p.sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 'call-1', status: 'failed', content: [{ type: 'content', content: { type: 'text', text: 'rejected' } }] })
          return send({ id: m.id, result: { stopReason: 'end_turn' } })
        }
      }
      if (text.includes('SLOW')) {
        await new Promise((resolve) => { cancelled = resolve })
        return send({ id: m.id, result: { stopReason: 'cancelled' } })
      }
      update(p.sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 'call-1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'hi' } }] })
      const reply = text.includes('REMEMBER') ? `earlier: ${memory.join(' | ')}` : `you said: ${text}`
      for (const part of [reply.slice(0, 5), reply.slice(5)]) update(p.sessionId, { sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text: part } })
      s[p.sessionId].turns = [...memory, text]; save(s)
      return send({ id: m.id, result: { stopReason: 'end_turn' } })
    }
    default:
      if (m.id !== undefined) send({ id: m.id, error: { code: -32601, message: 'no' } })
  }
}

process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buf += chunk
  let at
  while ((at = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, at); buf = buf.slice(at + 1)
    if (line.trim()) void handle(JSON.parse(line))
  }
})
