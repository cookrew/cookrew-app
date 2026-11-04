import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { observeOutput, startedLine } from '../src/renderer/src/routing/setup-line-state'
import { createFirstRun } from '../src/renderer/src/first-run/first-run-state'
import { createFirstFolder } from '../src/renderer/src/first-run/first-folder'
import { firstHarness, realAgents, stepTurns, type TurnMemory } from '../src/renderer/src/first-run/first-run-rules'
import { makeAgent } from '../src/renderer/src/zoom/make-card'
import { preflightRows, UNKNOWN_FACTS, type ToolFacts } from '../src/shared/preflight'
import type { FirstRunStage } from '../src/shared/first-run'
import type { CanvasNode } from '../src/shared/model'
import type { TerminalActivity } from '../src/shared/turn'

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('the stage the screens read', () => {
  const bridge = (start: FirstRunStage) => {
    let stage = start
    return {
      firstRunRead: vi.fn(async () => stage),
      firstRunAdvance: vi.fn(async (to: FirstRunStage) => (stage = to))
    }
  }

  it('is null until main answers: nothing flashes at a person who has been here for years', async () => {
    const run = createFirstRun(() => bridge('closed'))
    expect(run.get()).toBeNull()
    run.subscribe(() => undefined)
    await settle()
    expect(run.get()).toBe('closed')
  })

  it('asks main once, however many views subscribe', async () => {
    const api = bridge('preflight')
    const run = createFirstRun(() => api)
    run.subscribe(() => undefined)
    run.subscribe(() => undefined)
    await settle()
    expect(api.firstRunRead).toHaveBeenCalledTimes(1)
  })

  it('reads closed where there is no bridge: the phone and the plain demo see none of this', async () => {
    const run = createFirstRun(() => ({}))
    run.subscribe(() => undefined)
    await settle()
    expect(run.get()).toBe('closed')
  })

  it('reads closed when main fails to answer', async () => {
    const run = createFirstRun(() => ({ firstRunRead: () => Promise.reject(new Error('no')) }))
    run.subscribe(() => undefined)
    await settle()
    expect(run.get()).toBe('closed')
  })

  it('moves at once and tells main, forward only', async () => {
    const api = bridge('preflight')
    const run = createFirstRun(() => api)
    const heard = vi.fn()
    run.subscribe(heard)
    await settle()
    void run.advance('task')
    expect(run.get()).toBe('task')
    await settle()
    expect(api.firstRunAdvance).toHaveBeenCalledWith('task')
    void run.advance('preflight')
    expect(run.get()).toBe('task')
    expect(heard).toHaveBeenCalled()
  })

  it('keeps the move on screen when main refuses it', async () => {
    const run = createFirstRun(() => ({ firstRunRead: async () => 'task' as const, firstRunAdvance: () => Promise.reject(new Error('disk')) }))
    run.subscribe(() => undefined)
    await settle()
    await run.advance('phone')
    expect(run.get()).toBe('phone')
  })
})

describe('the folder the first agent works in', () => {
  const deps = (over: Partial<Parameters<typeof createFirstFolder>[0]> = {}) => ({
    canPick: () => true,
    pick: vi.fn(async () => '/Users/new/site' as string | null),
    use: vi.fn(async (_dir: string) => undefined),
    ...over
  })

  it('makes the picked folder the workspace’s own', async () => {
    const d = deps()
    const folder = createFirstFolder(d)
    expect(await folder.choose()).toBe('ready')
    expect(d.use).toHaveBeenCalledWith('/Users/new/site')
    expect(folder.get()).toBe('/Users/new/site')
  })

  it('sends straight on once a folder is chosen', async () => {
    const d = deps()
    const folder = createFirstFolder(d)
    await folder.choose()
    expect(await folder.ready()).toBe('ready')
    expect(d.pick).toHaveBeenCalledTimes(1)
  })

  it('asks for one at the moment of sending, when none was chosen', async () => {
    const d = deps()
    expect(await createFirstFolder(d).ready()).toBe('ready')
    expect(d.pick).toHaveBeenCalledTimes(1)
  })

  it('stays where it is on a cancelled dialog: the words wait in the box', async () => {
    const d = deps({ pick: vi.fn(async () => null) })
    const folder = createFirstFolder(d)
    expect(await folder.ready()).toBe('cancelled')
    expect(d.use).not.toHaveBeenCalled()
    expect(folder.get()).toBeNull()
  })

  it('says so when the workspace refuses the folder', async () => {
    const folder = createFirstFolder(deps({ use: vi.fn(async () => { throw new Error('no') }) }))
    expect(await folder.ready()).toBe('failed')
    expect(folder.get()).toBeNull()
  })

  it('never stands in the way where nothing can pick a folder', async () => {
    const d = deps({ canPick: () => false })
    expect(await createFirstFolder(d).ready()).toBe('ready')
    expect(d.pick).not.toHaveBeenCalled()
  })
})

describe('the first agent', () => {
  it('asks main to hold its prompt for a composer: the only thing it adds to the ordinary path', async () => {
    const createTerminal = vi.fn(async () => ({ id: 'a1' }))
    await makeAgent({ createTerminal } as never, { name: 'Readme', preset: 'Claude Code', orch: false, prompt: 'do it', patient: true })
    expect(createTerminal.mock.calls[0]).toEqual([expect.objectContaining({ prompt: 'do it', patient: true })])
  })

  it('leaves every other agent as it was', async () => {
    const createTerminal = vi.fn(async () => ({ id: 'a2' }))
    await makeAgent({ createTerminal } as never, { name: 'Readme', preset: 'Claude Code', orch: false, prompt: 'do it' })
    expect(createTerminal.mock.calls[0]).toEqual([expect.not.objectContaining({ patient: expect.anything() })])
  })
})

describe('a line long enough to wrap', () => {
  const HOMEBREW = '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"'

  it('is still seen as echoed, and its prompt coming back ends the watch', () => {
    const cut = 60
    let watch = startedLine(HOMEBREW)
    watch = observeOutput(watch, `% ${HOMEBREW.slice(0, cut)} \r${HOMEBREW.slice(cut)}\r\n`)
    expect(watch.echoed).toBe(true)
    expect(watch.done).toBe(false)
    watch = observeOutput(watch, '==> Installation successful!\r\n% ')
    expect(watch.done).toBe(true)
  })
})

describe('the first agent leads', () => {
  it('is made the orchestrator, as the Conductor it stands in for was', () => {
    const source = readFileSync(path.join(__dirname, '../src/renderer/src/prompt/GlobalPrompt.tsx'), 'utf8')
    expect(source).toMatch(/orch: orch \|\| firstTask/)
  })
})

describe('reading the board', () => {
  const node = (over: Partial<CanvasNode>): CanvasNode =>
    ({ kind: 'terminal', id: 'x', name: 'x', preset: 'Claude Code', command: 'claude', cwd: '~', orch: false, role: null, position: { x: 0, y: 0 }, size: { width: 1, height: 1 }, ...over }) as CanvasNode

  it('does not count the Setup card as the first agent', () => {
    expect(realAgents([node({ name: 'Setup', preset: 'Shell' })])).toBe(0)
    expect(realAgents([node({ name: 'Setup', preset: 'Shell' }), node({ name: 'Readme' })])).toBe(1)
  })

  it('does not count a note', () => {
    expect(realAgents([{ kind: 'note', id: 'n', name: 'n', customName: null, content: '', locked: false, position: { x: 0, y: 0 }, size: { width: 1, height: 1 } }])).toBe(0)
  })

  it('takes the tool that was found for the first agent, Claude Code first', () => {
    const facts = (over: Partial<ToolFacts>): ToolFacts => ({ ...UNKNOWN_FACTS, ...over })
    expect(firstHarness(preflightRows(facts({ claude: 'found', codex: 'found' })))).toBe('Claude Code')
    expect(firstHarness(preflightRows(facts({ claude: 'missing', codex: 'found' })))).toBe('Codex')
    expect(firstHarness(preflightRows(facts({ claude: 'missing', codex: 'missing' })))).toBeNull()
    expect(firstHarness(preflightRows(facts({})))).toBeNull()
  })
})

describe('a finished turn', () => {
  const activity = (terminalId: string, phase: TerminalActivity['phase'], turnCount = 0, agent = true): TerminalActivity =>
    ({ terminalId, agent, phase, turnCount }) as TerminalActivity
  const walk = (frames: readonly (readonly TerminalActivity[])[]): boolean[] => {
    let memory: TurnMemory = new Map()
    return frames.map((frame) => {
      const step = stepTurns(memory, frame)
      memory = step.memory
      return step.ended
    })
  }

  it('is a working agent reaching its reply', () => {
    expect(walk([[activity('a', 'thinking')], [activity('a', 'replied', 1)]])).toEqual([false, true])
  })

  it('counts through a question it stopped on', () => {
    expect(walk([[activity('a', 'thinking')], [activity('a', 'waiting')], [activity('a', 'replied', 1)]])).toEqual([false, false, true])
  })

  it('is a new completed turn, for a phase that never showed the work', () => {
    expect(walk([[activity('a', 'idle', 0)], [activity('a', 'idle', 1)]])).toEqual([false, true])
  })

  it('is nothing at first sight: an old reply on the screen is not news', () => {
    expect(walk([[activity('a', 'replied', 4)], [activity('a', 'replied', 4)]])).toEqual([false, false])
  })

  it('is nothing for a shell, the Setup card included', () => {
    expect(walk([[activity('s', 'thinking', 0, false)], [activity('s', 'replied', 1, false)]])).toEqual([false, false])
  })

  it('fires once per turn', () => {
    expect(walk([[activity('a', 'thinking')], [activity('a', 'replied', 1)], [activity('a', 'replied', 1)], [activity('a', 'idle', 1)]])).toEqual([false, true, false, false])
  })
})
