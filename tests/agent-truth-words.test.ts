import { describe, expect, it } from 'vitest'
import { agentViewOf, lineOf } from '../src/renderer/src/zoom/zoom-model'
import { promptPlaceholder } from '../src/renderer/src/prompt/prompt-words'
import { buildAgentRows, type AgentRow } from '../src/renderer/src/agent-rows'
import type { AgentRegistryEntry } from '../src/renderer/src/agent-registry'
import type { LaunchFailure } from '../src/shared/launch-failure'

const blocked: LaunchFailure = {
  kind: 'command-missing',
  why: 'Command not found: claude.',
  fix: 'Install it, then send again.',
  blocked: true,
  exitCode: 127,
  lastLines: [],
  at: 1
}
const exited: LaunchFailure = { ...blocked, kind: 'exited', why: 'claude stopped right after it started (exit 1).', blocked: false, lastLines: ['boom'] }

const entry = (over: Partial<AgentRegistryEntry> = {}): AgentRegistryEntry => ({
  id: 'a',
  name: 'Lark',
  preset: 'Claude Code',
  role: null,
  cwd: '/w',
  workspaceId: 'ws',
  workspaceName: 'Alpha',
  spawnedAt: 1,
  orch: false,
  active: false,
  ...over
})

const row = (over: Partial<AgentRow> = {}): AgentRow =>
  ({ ...entry(), phase: 'offline', turn: null, turnCount: 0, lastActivityAt: 1, ...over }) as AgentRow

describe('a card that cannot start says why', () => {
  it('the row carries the failure from the registry', () => {
    const rows = buildAgentRows({ roster: [entry({ failure: blocked })], activities: {}, now: 2 })
    expect([...rows.live, ...rows.quiet][0].failure).toEqual(blocked)
  })

  it('a healthy row carries none', () => {
    const rows = buildAgentRows({ roster: [entry({ active: true })], activities: {}, now: 2 })
    expect([...rows.live, ...rows.quiet][0].failure ?? null).toBeNull()
  })

  it('the card line is the reason, over any stale screen line', () => {
    const view = agentViewOf(row({ failure: blocked, turn: { title: null, ask: null, tools: [], latest: null, pendingInput: null, tail: '— process exited —' } }), new Map())
    expect(view.line).toBe('Command not found: claude.')
    expect(view.failure).toEqual(blocked)
  })

  it('the word says it could not start, not a bare offline', () => {
    expect(agentViewOf(row({ failure: blocked }), new Map()).word).toBe('could not start')
    expect(agentViewOf(row({ failure: exited }), new Map()).word).toBe('stopped')
    expect(agentViewOf(row(), new Map()).word).toBe('offline')
  })

  it('the prompt box does not promise a wake that cannot work', () => {
    const words = promptPlaceholder({ agent: { name: 'Lark', status: 'offline', failure: blocked }, stop: 'crew', workspace: null, item: null })
    expect(words).toBe('Lark could not start · Command not found: claude.')
    expect(words).not.toContain('wakes on send')
  })

  it('one that started and died may be tried again, and says so', () => {
    const words = promptPlaceholder({ agent: { name: 'Lark', status: 'offline', failure: exited }, stop: 'crew', workspace: null, item: null })
    expect(words).toBe('Lark stopped · send to start it again')
  })

  it('an agent merely asleep still wakes on send', () => {
    expect(promptPlaceholder({ agent: { name: 'Lark', status: 'offline' }, stop: 'crew', workspace: null, item: null })).toBe('Lark is asleep · wakes on send')
  })
})

describe('lineOf', () => {
  it('a running Shell reads its screen, not "Nothing said yet."', () => {
    const turn = { title: null, ask: null, tools: [], latest: null, pendingInput: null, tail: '513' }
    expect(lineOf(row({ turn }), null)).toBe('513')
  })
})
