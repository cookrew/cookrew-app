// AN ACP v1 AGENT AS A COOKREW HOSTED AGENT (cli/cookrew-acp.mjs): the agent
// runs as a child, JSON-RPC over its stdio. Shaped against DeepSeek Harness
// 0.2.2's ACP profile (initialize, session/new, session/resume,
// session/set_config_option, session/prompt, session/cancel, session/close,
// session/request_permission, session/update) read off a real session,
// 2026-11-28.

import { spawn } from 'node:child_process'

const mcpServers = (urls) => urls.map((url, i) => ({ type: 'http', name: i === 0 ? 'magpie' : `mcp${i + 1}`, url, headers: [] }))

const contentText = (content) =>
  Array.isArray(content) ? content.map((part) => (part?.content?.type === 'text' ? part.content.text : part?.type === 'text' ? part.text : '')).filter(Boolean).join('\n') : ''

function summary(input) {
  if (!input || typeof input !== 'object') return ''
  const text = input.description ?? input.command ?? input.file_path ?? input.path ?? Object.values(input).find((v) => typeof v === 'string') ?? ''
  const one = String(text).split('\n')[0]
  return one.length > 100 ? `${one.slice(0, 99)}…` : one
}

export class AcpBackend {
  constructor({ bin, args, env, cwd, mcp, model, effort, effortOption, events, onChildStderr }) {
    this.bin = bin
    this.args = args
    this.env = env
    this.cwd = cwd
    this.mcp = mcp
    this.wantModel = model
    this.wantEffort = effort
    this.effortOption = effortOption
    this.events = events
    this.onChildStderr = onChildStderr
    this.waiting = new Map()
    this.nextId = 0
    this.sessionId = null
    this.tools = new Map()
    this.inbound = ''
  }

  start() {
    this.child = spawn(this.bin, this.args, { cwd: this.cwd, env: this.env, stdio: ['pipe', 'pipe', 'pipe'] })
    this.child.stderr.on('data', (chunk) => this.onChildStderr?.(chunk))
    this.child.on('error', (error) => this.events.exit?.({ error }))
    this.child.on('exit', (code, signal) => {
      if (!this.closing) this.events.exit?.({ code, signal })
    })
    this.child.stdout.on('data', (chunk) => this.intake(chunk))
  }

  intake(chunk) {
    this.inbound += chunk
    let at
    while ((at = this.inbound.indexOf('\n')) >= 0) {
      const line = this.inbound.slice(0, at)
      this.inbound = this.inbound.slice(at + 1)
      if (line.trim()) this.message(line)
    }
  }

  send(message) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
  }

  call(method, params) {
    return new Promise((resolve, reject) => {
      this.nextId += 1
      this.waiting.set(this.nextId, { resolve, reject })
      this.send({ id: this.nextId, method, params })
    })
  }

  message(line) {
    let value
    try {
      value = JSON.parse(line)
    } catch {
      return
    }
    if (value.id !== undefined && !value.method) {
      const pending = this.waiting.get(value.id)
      this.waiting.delete(value.id)
      if (!pending) return
      if (value.error) pending.reject(new Error(value.error.message ?? 'the agent refused'))
      else pending.resolve(value.result ?? {})
      return
    }
    if (value.method === 'session/update') return this.update(value.params?.update ?? {})
    if (value.method === 'session/request_permission' && value.id !== undefined) return void this.permission(value.id, value.params ?? {})
    // No file system, no terminals: anything else is refused.
    if (value.id !== undefined) this.send({ id: value.id, error: { code: -32601, message: `${value.method} is not offered by this client` } })
  }

  async permission(requestId, params) {
    const options = (Array.isArray(params.options) ? params.options : []).map((o) => ({ id: o.optionId, name: o.name, kind: o.kind }))
    const tool = this.tools.get(params.toolCall?.toolCallId) ?? { title: params.toolCall?.title ?? 'tool', about: '' }
    const about = `${tool.title}${tool.about ? `: ${tool.about}` : ''}`
    this.events.permissionRecord?.({ about, options: options.map((o) => o.name) })
    let index = await this.events.permission({ about: about || 'Allow this?', options })
    if (index === null || index === undefined) index = options.findIndex((o) => String(o.kind).startsWith('reject'))
    const chosen = index >= 0 ? options[index] : null
    this.send({ id: requestId, result: { outcome: chosen ? { outcome: 'selected', optionId: chosen.id } : { outcome: 'cancelled' } } })
    this.events.answered?.(chosen?.name ?? 'Cancelled')
  }

  update(update) {
    switch (update.sessionUpdate) {
      case 'agent_message_chunk': {
        const text = update.content?.type === 'text' ? update.content.text : ''
        if (text) this.events.text(update.messageId ?? null, text)
        return
      }
      case 'agent_thought_chunk': {
        const text = update.content?.type === 'text' ? update.content.text : ''
        if (text) this.events.thought(update.messageId ?? null, text)
        return
      }
      case 'tool_call': {
        const title = update.title ?? 'tool'
        const about = summary(update.rawInput)
        this.tools.set(update.toolCallId, { title, about })
        this.events.tool(update.toolCallId, title, about, update.kind ?? null)
        return
      }
      case 'tool_call_update': {
        if (update.status !== 'completed' && update.status !== 'failed') return
        this.events.toolDone(update.toolCallId, update.status, contentText(update.content))
        return
      }
      default:
        return
    }
  }

  current(options, id) {
    const option = Array.isArray(options) ? options.find((o) => o.id === id || o.category === id) : null
    if (!option) return ''
    try {
      const parsed = JSON.parse(option.currentValue)
      return Array.isArray(parsed) ? String(parsed.at(-1)) : String(option.currentValue)
    } catch {
      return String(option.currentValue ?? '')
    }
  }

  async applyOptions(options) {
    let latest = options
    if (this.wantEffort && this.effortOption) {
      try {
        latest = (await this.call('session/set_config_option', { sessionId: this.sessionId, configId: this.effortOption, value: this.wantEffort })).configOptions ?? latest
      } catch (error) {
        this.events.notice?.(`effort ${this.wantEffort}: ${error.message}`)
      }
    }
    this.events.model({ model: this.wantModel ?? this.current(latest, 'model'), effort: this.current(latest, this.effortOption ?? 'thought_level') })
  }

  async open({ resume }) {
    this.start()
    await this.call('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } })
    const servers = mcpServers(this.mcp)
    if (resume) {
      const resumed = await this.call('session/resume', { sessionId: resume, cwd: this.cwd, mcpServers: servers })
      this.sessionId = resume
      // The transcript opens BEFORE anything of the session is written down.
      this.events.session?.({ id: resume, resumed: true })
      await this.applyOptions(resumed.configOptions)
      return { id: resume, resumed: true }
    }
    const created = await this.call('session/new', { cwd: this.cwd, mcpServers: servers })
    this.sessionId = created.sessionId
    this.events.session?.({ id: this.sessionId, resumed: false })
    await this.applyOptions(created.configOptions)
    return { id: this.sessionId, resumed: false }
  }

  async prompt(text) {
    const result = await this.call('session/prompt', { sessionId: this.sessionId, prompt: [{ type: 'text', text }] })
    return { stop: result.stopReason ?? 'end_turn' }
  }

  async cancel() {
    this.send({ method: 'session/cancel', params: { sessionId: this.sessionId } })
    return true
  }

  close() {
    this.closing = true
    this.child?.kill()
  }
}
