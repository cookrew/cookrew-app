// THE GLOBAL PROMPT (owner, 2026-11-01): one prompt box at the foot of the
// app. In an agent's full view (or with its card open) it carries @agent and
// sends to it, sharing its draft with the card's reply box; with no agent, it
// makes a new agent in this workspace, named from the prompt, on the harness
// last used unless another is picked.

import { beforeEach, describe, expect, it } from 'vitest'
import { nameFromPrompt } from '../src/renderer/src/prompt/agent-name'
import { mentionTarget, promptTargetOf } from '../src/renderer/src/prompt/prompt-target'
import { draftKey, getDraft, setDraft, subscribeDrafts } from '../src/renderer/src/prompt/prompt-draft'
import { lastHarness, rememberHarness } from '../src/renderer/src/prompt/harness-pref'

describe('nameFromPrompt', () => {
  it('names an English task by its subject, not its verb', () => {
    expect(nameFromPrompt('fix the login redirect bug')).toBe('Login Redirect')
    expect(nameFromPrompt('Please add dark mode to the settings page')).toBe('Dark Mode')
    expect(nameFromPrompt('investigate why CI is slow')).toBe('Ci Slow')
  })

  it('names a Chinese task by its first words, without the polite lead-in', () => {
    expect(nameFromPrompt('帮我把登录页的跳转修好')).toBe('把登录页的跳')
    expect(nameFromPrompt('请调研一下herdr的取名功能')).toBe('调研一下')
  })

  it('a bare verb still names something; nothing at all falls back to Agent', () => {
    expect(nameFromPrompt('deploy')).toBe('Deploy')
    expect(nameFromPrompt('   ')).toBe('Agent')
    expect(nameFromPrompt('!!! ???')).toBe('Agent')
  })

  it('stays short', () => {
    expect(nameFromPrompt('refactor supercalifragilisticexpialidocious frobnicator').length).toBeLessThanOrEqual(20)
  })
})

describe('promptTargetOf', () => {
  const zoom = (v: number, agent: string | null, dir: 'agents' | 'items' = 'agents') => ({ dir, v, agent })
  it("a full view's agent is the target", () => {
    expect(promptTargetOf({ zoom: zoom(1, null), fullAgentId: 'a1' })).toBe('a1')
  })
  it("an open card's agent is the target", () => {
    expect(promptTargetOf({ zoom: zoom(2, 'a2'), fullAgentId: null })).toBe('a2')
  })
  it('the crew with no card, the device and the item side have none', () => {
    expect(promptTargetOf({ zoom: zoom(1, 'a2'), fullAgentId: null })).toBeNull()
    expect(promptTargetOf({ zoom: zoom(-1, 'a2'), fullAgentId: null })).toBeNull()
    expect(promptTargetOf({ zoom: zoom(1, 'a2', 'items'), fullAgentId: null })).toBeNull()
  })
})

describe('mentionTarget', () => {
  const agents = [{ id: 'f', name: 'Fresco' }, { id: 'p', name: 'Probe3 (2)' }, { id: 'q', name: 'Probe3' }]
  it('a leading @name picks that agent, case-insensitively, the longest name first', () => {
    expect(mentionTarget('@fresco look at the logo', agents)).toEqual({ id: 'f', text: 'look at the logo' })
    expect(mentionTarget('@Probe3 (2) hi', agents)).toEqual({ id: 'p', text: 'hi' })
    expect(mentionTarget('@Probe3 hi', agents)).toEqual({ id: 'q', text: 'hi' })
  })
  it('no mention, or an unknown one, picks nobody', () => {
    expect(mentionTarget('look at the logo', agents)).toBeNull()
    expect(mentionTarget('@nobody hi', agents)).toBeNull()
    expect(mentionTarget('@Frescoes hi', agents)).toBeNull()
  })
})

describe('the shared draft', () => {
  it("one agent's draft is the same text wherever it is read, and others hear it change", () => {
    const heard: string[] = []
    const off = subscribeDrafts(() => heard.push(getDraft(draftKey('a1'))))
    setDraft(draftKey('a1'), 'half a thought')
    expect(getDraft(draftKey('a1'))).toBe('half a thought')
    expect(getDraft(draftKey('a2'))).toBe('')
    expect(getDraft(draftKey(null))).toBe('')
    off()
    setDraft(draftKey('a1'), '')
    expect(heard).toEqual(['half a thought'])
  })
})

describe('the harness a new agent takes', () => {
  beforeEach(() => {
    const store = new Map<string, string>()
    ;(globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v)
    }
  })
  it('the last one used, if it is still offered; else Claude Code; else the first', () => {
    const offered = ['Shell', 'Claude Code', 'Codex']
    expect(lastHarness(offered)).toBe('Claude Code')
    rememberHarness('Codex')
    expect(lastHarness(offered)).toBe('Codex')
    expect(lastHarness(['Shell', 'Pi'])).toBe('Shell')
  })
})

describe('the box, drawn', () => {
  it('with an agent in full view: @agent, its prompt, the voice keys, one send', async () => {
    const store = new Map<string, string>()
    const g = globalThis as Record<string, unknown>
    g.localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) }
    g.window = g.window ?? globalThis
    const { renderToStaticMarkup } = await import('react-dom/server')
    const { createElement } = await import('react')
    const { GlobalPrompt } = await import('../src/renderer/src/prompt/GlobalPrompt')
    const agents = [{ id: 'l', name: 'Lark', remote: false }]
    const full = renderToStaticMarkup(createElement(GlobalPrompt, { fullAgentId: 'l', agents, harnesses: ['Claude Code', 'Codex'], nodes: [] }))
    expect(full).toContain('@Lark')
    expect(full).toContain('placeholder="Prompt Lark…"')
    expect(full).toContain('voice-bar')
    expect(full.match(/aria-label="Send"/g)?.length).toBe(1)
    const none = renderToStaticMarkup(createElement(GlobalPrompt, { fullAgentId: null, agents, harnesses: ['Claude Code', 'Codex'], nodes: [] }))
    expect(none).toContain('＋ Claude Code ▾')
    expect(none).toContain('A new agent takes this task')
    expect(none).not.toContain('voice-bar')
  })
})

// Review, 2026-11-01: App seeds its preset list with ['Shell'] before the real
// one arrives, and a prompt typed into zsh runs as a command.
describe('a prompt never goes to a bare shell', () => {
  it('the dock offers the box no Shell, so it falls back to Claude Code', async () => {
    const store = new Map<string, string>()
    const g = globalThis as Record<string, unknown>
    g.localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) }
    g.window = g.window ?? globalThis
    const { renderToStaticMarkup } = await import('react-dom/server')
    const { createElement } = await import('react')
    const { Dock } = await import('../src/renderer/src/Dock')
    const noop = (): void => undefined
    const html = renderToStaticMarkup(createElement(Dock, {
      tool: 'move', onSelect: noop, clipping: false, onToggleClipping: noop, presets: ['Shell'], preset: '', onPreset: noop,
      roles: [], role: null, onRole: noop, orch: false, onOrch: noop, connectHint: null, onMake: noop,
      voiceFor: null, agents: [], nodes: [], browserFor: null, boardFor: null
    }))
    expect(html).toContain('＋ Claude Code ▾')
    expect(html).not.toContain('＋ Shell')
  })

  it('main injects a first prompt only into a terminal that runs a command', async () => {
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const main = readFileSync(join(__dirname, '..', 'src/main/index.ts'), 'utf8')
    expect(main).toContain("const first = typeof opts.prompt === 'string' && terminal.command.trim() ? opts.prompt.trim() : ''")
  })
})
