import { describe, expect, it, vi } from 'vitest'
import { freshDemoApi, freshFacts, freshMode } from '../src/renderer/src/demo-first-run'
import { mayContinue, preflightRows } from '../src/shared/preflight'
import type { CookrewApi } from '../src/renderer/src/api'
import type { TerminalActivity } from '../src/shared/turn'

/**
 * THE DEMO'S FRESH INSTALL, so QA can see the first run with no Mac behind it:
 * `?fresh=gaps|green|none|unknown`, with `&stage=` to open further along. The
 * plain demo, and every fixture built on it, is untouched.
 */

describe('the switch', () => {
  it('is off without the parameter, and for a word it does not know', () => {
    expect(freshMode('')).toBeNull()
    expect(freshMode('?seed=crew')).toBeNull()
    expect(freshMode('?fresh=door')).toBeNull()
  })

  it('reads the four machines', () => {
    expect(freshMode('?fresh=gaps')).toBe('gaps')
    expect(freshMode('?fresh=green&stage=task')).toBe('green')
    expect(freshMode('?fresh=none')).toBe('none')
    expect(freshMode('?fresh=unknown')).toBe('unknown')
  })
})

describe('the machines', () => {
  const rows = (mode: Parameters<typeof freshFacts>[0]) => preflightRows(freshFacts(mode))

  it('green has everything', () => {
    expect(rows('green').every((r) => r.state === 'found' && r.fix === null)).toBe(true)
  })

  it('gaps has an agent tool and is missing the rest', () => {
    const missing = rows('gaps').filter((r) => r.state === 'missing').map((r) => r.id)
    expect(missing).toEqual(['codex', 'pi', 'opencode', 'multiplexer', 'chrome', 'magpie', 'ollama'])
    expect(mayContinue(rows('gaps'))).toBe(true)
  })

  it('none has no agent tool, so the way on is held', () => {
    expect(mayContinue(rows('none'))).toBe(false)
  })

  it('unknown is a check that failed, and holds nothing', () => {
    expect(rows('unknown').every((r) => r.state === 'unknown')).toBe(true)
    expect(mayContinue(rows('unknown'))).toBe(true)
  })
})

describe('the first task, on an agent the demo plays', () => {
  const base = (): CookrewApi =>
    ({
      createTerminal: vi.fn(async () => ({ id: 't1', name: 'x' })),
      removeNode: vi.fn(async () => undefined),
      ptyInput: vi.fn(),
      ptyAttach: vi.fn(() => () => undefined),
      onTerminalActivity: () => () => undefined
    }) as unknown as CookrewApi
  const send = (api: CookrewApi) => api.createTerminal({ name: 'x', preset: 'Claude Code', prompt: 'do it', patient: true } as never)

  it('takes it, with the stage left to the turn’s outcome, by default', async () => {
    vi.useFakeTimers()
    const api = freshDemoApi(base(), 'green', '?fresh=green&stage=task')
    const views: unknown[] = []
    api.onFirstRun?.((view) => views.push(view))
    await send(api)
    await vi.runAllTimersAsync()
    expect(views.at(-1)).toMatchObject({ stage: 'task', task: { state: 'sent' } })
    expect(await api.firstRunAdvance?.('second')).toBe('second')
    expect(await api.firstRunTask?.()).toBeNull()
    vi.useRealTimers()
  })

  it('asks a question with ?agent=asks, and holds the words', async () => {
    vi.useFakeTimers()
    const api = freshDemoApi(base(), 'green', '?fresh=green&stage=task&agent=asks')
    await send(api)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(await api.firstRunTask?.()).toMatchObject({ state: 'holding', wait: 'choice', words: 'do it' })
    vi.useRealTimers()
  })

  it('plays a refused turn with ?agent=refused: delivered, then a provider’s error', async () => {
    vi.useFakeTimers()
    const api = freshDemoApi(base(), 'green', '?fresh=green&stage=task&agent=refused')
    const heard: TerminalActivity[] = []
    api.onTerminalActivity((a) => heard.push(a))
    await send(api)
    await vi.runAllTimersAsync()
    expect(heard.at(-1)?.reply).toMatch(/^API Error: 400/)
    vi.useRealTimers()
  })

  it('hands the words back with ?agent=dies, with the stage where it was', async () => {
    vi.useFakeTimers()
    const api = freshDemoApi(base(), 'green', '?fresh=green&stage=task&agent=dies')
    await send(api)
    await vi.runAllTimersAsync()
    expect(await api.firstRunTask?.()).toMatchObject({ state: 'returned', words: 'do it' })
    expect(await api.firstRunRead?.()).toBe('task')
    vi.useRealTimers()
  })

  it('checks an endpoint form like main, and never echoes the key', async () => {
    const api = freshDemoApi(base(), 'gaps', '?fresh=gaps')
    expect(await api.accessSave?.({ protocol: 'anthropic', baseUrl: 'http://a.example', key: 'k', model: 'm' })).toMatchObject({ ok: false, field: 'baseUrl' })
    const saved = await api.accessSave?.({ protocol: 'anthropic', baseUrl: 'https://a.example', key: 'fake', model: 'm' })
    expect(saved).toMatchObject({ ok: true, state: { active: { host: 'a.example' } } })
    expect(JSON.stringify(await api.accessState?.())).not.toContain('fake')
  })
})

describe('the bridge it adds', () => {
  const base = (): CookrewApi =>
    ({
      createTerminal: vi.fn(async () => ({ id: 't1' })),
      ptyInput: vi.fn(),
      onTerminalActivity: () => () => undefined
    }) as unknown as CookrewApi

  it('opens at the stage asked for, forward only, in memory', async () => {
    const api = freshDemoApi(base(), 'gaps', '?fresh=gaps&stage=task')
    expect(await api.firstRunRead?.()).toBe('task')
    expect(await api.firstRunAdvance?.('phone')).toBe('phone')
    expect(await api.firstRunAdvance?.('task')).toBe('phone')
  })

  it('opens at the tool check by default', async () => {
    expect(await freshDemoApi(base(), 'gaps', '?fresh=gaps').firstRunRead?.()).toBe('preflight')
  })

  it('answers a folder and a Wi-Fi-only pairing, as a Mac with no account does', async () => {
    const api = freshDemoApi(base(), 'green', '?fresh=green')
    expect(await api.pickDir()).toMatch(/^\//)
    expect((await api.accountPairingUrl?.())?.via).toBe('direct')
  })

  it('plays a turn for an agent made with a prompt, and one for a later Enter', async () => {
    vi.useFakeTimers()
    const api = freshDemoApi(base(), 'green', '?fresh=green')
    const heard: TerminalActivity[] = []
    api.onTerminalActivity((a) => heard.push(a))
    await api.createTerminal({ name: 'x', preset: 'Claude Code', prompt: 'do it' } as never)
    await vi.runAllTimersAsync()
    expect(heard.map((a) => [a.phase, a.turnCount])).toEqual([['thinking', 0], ['replied', 1]])
    api.ptyInput('t1', '\r')
    await vi.runAllTimersAsync()
    expect(heard.at(-1)?.turnCount).toBe(2)
    vi.useRealTimers()
  })

  it('plays nothing for the Setup shell', async () => {
    vi.useFakeTimers()
    const api = freshDemoApi(base(), 'green', '?fresh=green')
    const heard: TerminalActivity[] = []
    api.onTerminalActivity((a) => heard.push(a))
    await api.createTerminal({ name: 'Setup', preset: 'Shell' } as never)
    api.ptyInput('t1', 'brew install tmux\r')
    await vi.runAllTimersAsync()
    expect(heard).toEqual([])
    vi.useRealTimers()
  })
})
