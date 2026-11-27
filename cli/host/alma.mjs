// ALMA AS A HOSTED AGENT (cli/cookrew-acp.mjs `alma`): Alma is a stateful
// server on this machine, not a TUI, so the host drives its HTTP API and draws
// the turn itself. Read off Alma 0.4.1024 on 2026-11-27 (a real thread on the
// owner's own :23001):
//
//   POST /api/workspaces {path,name}            → a workspace for the folder
//   POST /api/threads {title,workspaceId,model} → 201 thread {id,model,reasoningEffort}
//   POST /api/threads/:id/send {text,model}     → 202 started, 409 busy
//   GET  /api/threads/:id/run-status?reply=1    → {state:running|done, busy, reply:{text,turnEndReason}}
//   GET  /api/threads/:id/messages              → the turn's parts: reasoning, text, tool-<Name>
//   GET /api/handoff/tool-approvals             → [{requestId,title,message,threadId,…}]
//   POST /api/handoff/tool-approvals {requestId,response:{action:allow_once|deny}}
//   WS /ws/threads {type:"stop_generation",data:{threadId}}   — the only stop there is
//
// The model is `providerId:model` (Alma's own ids; its Magpie provider serves
// the same groups Magpie's other agents get). Approval asks appear only when
// the person's settings say so; the host answers them like any menu.

import { connectWebSocket } from './ws.mjs'

const POLL_MS = 400

export class AlmaApi {
  constructor(baseUrl) {
    this.baseUrl = baseUrl.replace(/\/+$/, '')
  }

  async request(path, { method = 'GET', body, timeoutMs = 20_000 } = {}) {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMs)
    })
    const text = await response.text()
    let value = null
    try {
      value = text ? JSON.parse(text) : null
    } catch {
      value = text
    }
    return { status: response.status, body: value }
  }
}

const rows = (body) => (Array.isArray(body) ? body : body?.data ?? body?.messages ?? [])

function toolSummary(input) {
  if (!input || typeof input !== 'object') return ''
  const text = input.description ?? input.command ?? input.file_path ?? input.path ?? Object.values(input).find((v) => typeof v === 'string') ?? ''
  const one = String(text).split('\n')[0]
  return one.length > 100 ? `${one.slice(0, 99)}…` : one
}

function outputText(output) {
  if (typeof output === 'string') return output
  if (output && typeof output === 'object') {
    const stdout = typeof output.stdout === 'string' ? output.stdout : ''
    const stderr = typeof output.stderr === 'string' ? output.stderr : ''
    return (stdout || stderr || JSON.stringify(output)).trim()
  }
  return ''
}

export class AlmaBackend {
  constructor({ baseUrl, model, effort, cwd, events }) {
    this.api = new AlmaApi(baseUrl)
    this.wantModel = model
    this.wantEffort = effort
    this.cwd = cwd
    this.events = events
    this.threadId = null
    this.ws = null
    this.sawMessage = new Map()
  }

  async workspace() {
    const list = rows((await this.api.request('/api/workspaces')).body)
    const hit = list.find((w) => w.path === this.cwd)
    if (hit) return hit
    const name = this.cwd.split('/').filter(Boolean).at(-1) ?? 'workspace'
    const created = await this.api.request('/api/workspaces', { method: 'POST', body: { path: this.cwd, name } })
    if (created.status === 409 && created.body?.workspace) return created.body.workspace
    if (created.status !== 201) throw new Error(`Alma would not take this folder: ${created.body?.error ?? created.status}`)
    return created.body
  }

  async open({ resume }) {
    let thread
    if (resume) {
      const found = await this.api.request(`/api/threads/${encodeURIComponent(resume)}`)
      if (found.status !== 200 || !found.body?.id) throw new Error(`Alma has no thread ${resume}`)
      thread = found.body
    } else {
      const space = await this.workspace()
      const title = `Cookrew · ${this.cwd.split('/').filter(Boolean).at(-1) ?? 'workspace'}`
      const created = await this.api.request('/api/threads', { method: 'POST', body: { title, workspaceId: space.id, ...(this.wantModel ? { model: this.wantModel } : {}) } })
      if (created.status !== 201) throw new Error(`Alma would not open a thread: ${created.body?.error ?? created.status}`)
      thread = created.body
    }
    this.threadId = thread.id
    // Setting the model is a PATCH of its own: a thread remembers the one it opened on.
    if (this.wantModel && thread.model !== this.wantModel) {
      const put = await this.api.request(`/api/threads/${this.threadId}`, { method: 'PUT', body: { model: this.wantModel } })
      if (put.status === 200) thread = put.body
    }
    if (this.wantEffort) await this.api.request(`/api/threads/${this.threadId}`, { method: 'PUT', body: { reasoningEffort: this.wantEffort } })
    this.events.session?.({ id: this.threadId, resumed: Boolean(resume) })
    this.events.model({ model: thread.model ?? this.wantModel ?? '', effort: thread.reasoningEffort ?? '' })
    try {
      this.ws = await connectWebSocket(`${this.api.baseUrl.replace(/^http/, 'ws')}/ws/threads`)
    } catch (error) {
      // Stopping is the only thing the socket is for: say so once, keep going.
      this.events.notice?.(`stop is unavailable (${error.message})`)
    }
    return { id: this.threadId, resumed: Boolean(resume) }
  }

  /** One turn: send, then watch the thread until it is no longer busy. */
  async prompt(text) {
    const sent = await this.api.request(`/api/threads/${this.threadId}/send`, { method: 'POST', body: { text, ...(this.wantModel ? { model: this.wantModel } : {}) } })
    if (sent.status === 409) throw new Error('Alma is busy with another turn on this thread')
    if (sent.status !== 202) throw new Error(`Alma would not take the prompt: ${sent.body?.error ?? sent.status}`)
    let stop = 'end_turn'
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, POLL_MS))
      await this.pollTurn()
      const status = await this.api.request(`/api/threads/${this.threadId}/run-status?reply=1`)
      const state = status.body ?? {}
      if (state.state === 'running' || state.busy) continue
      stop = state.reply?.turnEndReason ?? 'end_turn'
      break
    }
    await this.pollTurn()
    return { stop: stop === 'stop' || stop === 'end_turn' ? 'end_turn' : stop }
  }

  /** New parts since the last poll, as the host's events. */
  async pollTurn() {
    const messages = rows((await this.api.request(`/api/threads/${this.threadId}/messages`)).body)
    const last = messages.filter((m) => m?.message?.role === 'assistant').at(-1)
    if (last) this.readAssistant(last.message)
    for (const ask of rows((await this.api.request('/api/handoff/tool-approvals')).body)) {
      if (ask?.threadId && ask.threadId !== this.threadId) continue
      await this.answer(ask)
    }
  }

  readAssistant(message) {
    const seen = this.sawMessage.get(message.id) ?? { reasoning: 0, texts: new Map(), tools: new Map() }
    this.sawMessage.set(message.id, seen)
    for (const part of message.parts ?? []) {
      if (part.type === 'reasoning' && typeof part.text === 'string') {
        const grown = part.text.slice(seen.reasoning)
        if (grown) this.events.thought(message.id, grown)
        seen.reasoning = Math.max(seen.reasoning, part.text.length)
      } else if (part.type === 'text' && typeof part.text === 'string') {
        const at = seen.texts.get(part.type + (part.toolCallId ?? '')) ?? 0
        const grown = part.text.slice(at)
        if (grown) this.events.text(message.id, grown)
        seen.texts.set(part.type + (part.toolCallId ?? ''), part.text.length)
      } else if (typeof part.type === 'string' && part.type.startsWith('tool-')) {
        const id = part.toolCallId ?? part.id ?? `${message.id}:${part.type}`
        const known = seen.tools.get(id)
        if (!known) {
          seen.tools.set(id, { state: part.state })
          this.events.tool(id, part.type.slice(5), toolSummary(part.input))
        } else if (known.state !== part.state) {
          known.state = part.state
        }
        if (part.state === 'output-available' || part.state === 'output-error') {
          const done = seen.tools.get(id).done
          if (!done) {
            seen.tools.get(id).done = true
            this.events.toolDone(id, part.state === 'output-error' ? 'failed' : 'completed', outputText(part.output))
          }
        }
      }
    }
  }

  async answer(ask) {
    // One request is answered once, even if a poll still lists it while the answer lands.
    this.answered = this.answered ?? new Set()
    if (this.answered.has(ask.requestId)) return
    this.answered.add(ask.requestId)
    const about = [ask.title, ask.message].filter((v) => typeof v === 'string' && v.trim()).join(': ')
    const options = [
      { id: 'allow_once', name: 'Allow once' },
      { id: 'allow_always', name: 'Always allow' },
      { id: 'deny', name: 'Deny' }
    ]
    this.events.permissionRecord?.({ about: about || 'Alma needs permission', options: options.map((o) => o.name) })
    let index = await this.events.permission({ about: about || 'Alma needs permission', options })
    if (index === null || index === undefined) index = options.length - 1
    const action = options[index]?.id ?? 'deny'
    await this.api.request('/api/handoff/tool-approvals', { method: 'POST', body: { requestId: ask.requestId, response: { action } } })
    this.events.answered(options[index]?.name ?? 'Denied')
  }

  /** Escape in a turn: Alma's only stop is the socket's. */
  async cancel() {
    if (!this.ws) return false
    this.ws.send({ type: 'stop_generation', data: { threadId: this.threadId } })
    return true
  }

  close() {
    this.ws?.close()
    this.ws = null
  }
}
