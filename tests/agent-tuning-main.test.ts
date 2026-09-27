// THE READOUT AND THE CONTROL (main/agent-tuning), against real files and a
// real record shape.
//
// The readout comes off the harness's own session file — the same file the
// checkpoint rail reads — so these tests write records in the exact shape
// Claude writes them, tail-read them back, and then prove the two halves stay
// joined: a line only reaches the pane when the gate allows it, and an ask is
// only remembered when a line actually went.

import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  TuneAsks,
  TuningCache,
  applyTuning,
  readTuning,
  subjectOf,
  tuningStateOf,
  type TuneDeps
} from '../src/main/agent-tuning'
import { claudeProjectDir } from '../src/main/claude-fork'
import { claudeTuning } from '../src/main/claude-tuning'
import { codexTuning } from '../src/main/codex-tuning'
import type { TerminalNodeData } from '../src/shared/model'

const SESSION = '11111111-2222-4333-8444-555555555555'
const CWD = '/tmp/cookrew-tune-fixture'

function node(over: Partial<TerminalNodeData> = {}): TerminalNodeData {
  return {
    kind: 'terminal',
    id: 'term-1',
    name: 'Forge',
    preset: 'Claude Code',
    command: 'claude',
    cwd: CWD,
    orch: false,
    role: null,
    claudeSessionId: SESSION,
    position: { x: 0, y: 0 },
    size: { width: 640, height: 420 },
    ...over
  }
}

/** One assistant record in the shape Claude actually writes it. */
function reply(model: string, effort: string, at: string): string {
  return JSON.stringify({
    type: 'assistant',
    effort,
    timestamp: at,
    sessionId: SESSION,
    message: { type: 'message', role: 'assistant', model, content: [] }
  })
}

function prompt(at: string): string {
  return JSON.stringify({
    type: 'user',
    timestamp: at,
    sessionId: SESSION,
    message: { role: 'user', content: 'go' }
  })
}

/** A projects root holding one session file with the given lines. */
function projectsWith(lines: string[]): string {
  const projectsDir = mkdtempSync(path.join(tmpdir(), 'cookrew-tune-'))
  const dir = claudeProjectDir(CWD, projectsDir)
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, `${SESSION}.jsonl`), lines.join('\n'))
  return projectsDir
}

describe('claude writes its dials onto every reply', () => {
  it('reads the model and effort off an assistant record', () => {
    const record = JSON.parse(reply('claude-opus-5', 'max', '2026-09-27T02:17:55.011Z'))
    expect(claudeTuning.read(record)).toEqual({
      model: 'claude-opus-5',
      effort: 'max',
      at: Date.parse('2026-09-27T02:17:55.011Z')
    })
  })

  it('takes nothing from a user record', () => {
    // A user record carries no model, and lifting `effort` off one would
    // report a dial position with no reply behind it.
    expect(claudeTuning.read(JSON.parse(prompt('2026-09-27T02:00:00.000Z')))).toBeNull()
  })

  it('survives an effort value it does not know', () => {
    const record = JSON.parse(reply('claude-opus-5', 'ultracode', '2026-09-27T02:00:00.000Z'))
    expect(claudeTuning.read(record)?.effort).toBeNull()
    expect(claudeTuning.read(record)?.model).toBe('claude-opus-5')
  })

  it('composes a line only for a value it offers', () => {
    expect(claudeTuning.line('model', 'opus')).toBe('/model opus')
    expect(claudeTuning.line('model', 'claude-opus-4-8')).toBeNull()
  })
})

describe('codex writes its dials at the START of every turn', () => {
  it('reads the model and effort off a turn_context record', () => {
    // Verified against a real ~/.codex/sessions rollout (2026-09-14).
    const record = {
      type: 'turn_context',
      timestamp: '2026-09-14T02:09:04.396Z',
      payload: { turn_id: 'x', model: 'gpt-6-astra', effort: 'high', summary: 'auto' }
    }
    expect(codexTuning.read(record)).toEqual({
      model: 'gpt-6-astra',
      effort: 'high',
      at: Date.parse('2026-09-14T02:09:04.396Z')
    })
  })

  it('takes codex levels VERBATIM — the offer is closed, the readout is not', () => {
    const record = {
      type: 'turn_context',
      timestamp: '2026-09-14T02:09:04.396Z',
      payload: { model: 'gpt-6-astra', effort: 'minimal' }
    }
    expect(codexTuning.read(record)?.effort).toBe('minimal')
  })

  it('takes nothing from the other rollout record types', () => {
    expect(codexTuning.read({ type: 'session_meta', payload: { model: 'x' } })).toBeNull()
    expect(codexTuning.read({ type: 'response_item', payload: {} })).toBeNull()
  })

  it('offers NO button, because codex only changes these in its own picker', () => {
    // Read and write are separate capabilities on purpose: without that split
    // codex would have to choose between a tag it can have and buttons that
    // would do nothing.
    expect(codexTuning.knobs).toEqual([])
    expect(codexTuning.line('model', 'opus')).toBeNull()
  })
})

describe('the readout', () => {
  it('reports the LAST reply, not the first', () => {
    const projectsDir = projectsWith([
      reply('claude-sonnet-5', 'low', '2026-09-27T01:00:00.000Z'),
      prompt('2026-09-27T02:00:00.000Z'),
      reply('claude-opus-5', 'max', '2026-09-27T03:00:00.000Z'),
      prompt('2026-09-27T04:00:00.000Z')
    ])
    expect(readTuning(subjectOf(node()), { projectsDir })).toEqual({
      model: 'claude-opus-5',
      effort: 'max',
      at: Date.parse('2026-09-27T03:00:00.000Z')
    })
  })

  it('steps over a torn final line rather than failing on it', () => {
    // The harness appends while we read; a half-written record is ordinary.
    const projectsDir = projectsWith([
      reply('claude-opus-5', 'high', '2026-09-27T03:00:00.000Z'),
      '{"type":"assistant","message":{"mod'
    ])
    expect(readTuning(subjectOf(node()), { projectsDir })?.effort).toBe('high')
  })

  it('knows nothing when nothing is bound, written or recorded', () => {
    const projectsDir = projectsWith([prompt('2026-09-27T02:00:00.000Z')])
    expect(readTuning(subjectOf(node()), { projectsDir })).toBeNull()
    expect(readTuning(subjectOf(node({ claudeSessionId: null })), { projectsDir })).toBeNull()
    expect(readTuning(subjectOf(node({ command: 'bash' })), { projectsDir })).toBeNull()
  })
})

describe('the readout for a whole canvas', () => {
  it('re-reads only when the file actually changed', () => {
    const projectsDir = projectsWith([reply('claude-opus-5', 'max', '2026-09-27T03:00:00.000Z')])
    const cache = new TuningCache()
    const subject = subjectOf(node())
    const first = cache.of(subject, { projectsDir })
    expect(first?.model).toBe('claude-opus-5')

    // THE SAME OBJECT, not an equal one: a re-parse mints a new record, so
    // identity is the proof that the size+mtime stamp actually gated the read.
    // (Asserting on content instead would pass even if every call re-parsed.)
    expect(cache.of(subject, { projectsDir })).toBe(first)
    expect(cache.of(subject, { projectsDir })).toBe(first)

    // A real append moves the stamp, and the readout follows.
    const file = path.join(claudeProjectDir(CWD, projectsDir), `${SESSION}.jsonl`)
    appendFileSync(file, `\n${reply('claude-sonnet-5', 'high', '2026-09-27T04:00:00.000Z')}`)
    const second = cache.of(subject, { projectsDir })
    expect(second).not.toBe(first)
    expect(second?.model).toBe('claude-sonnet-5')
  })

  it('reaches past a turn too long for the first window', () => {
    // The first tail step is small because nearly every card fits in it; the
    // second exists so a turn with a huge tool transcript still reports.
    const filler = JSON.stringify({ type: 'user', pad: 'x'.repeat(60_000) })
    const projectsDir = projectsWith([
      reply('claude-opus-5', 'max', '2026-09-27T03:00:00.000Z'),
      filler
    ])
    expect(readTuning(subjectOf(node()), { projectsDir })?.model).toBe('claude-opus-5')
  })

  it('forgets a card that ended', () => {
    const projectsDir = projectsWith([reply('claude-opus-5', 'max', '2026-09-27T03:00:00.000Z')])
    const cache = new TuningCache()
    expect(cache.of(subjectOf(node()), { projectsDir })).not.toBeNull()
    cache.forget('term-1')
    expect(cache.of(subjectOf(node()), { projectsDir })?.model).toBe('claude-opus-5')
  })
})

interface Pane {
  written: string[]
  verdict: string
}

function deps(over: { projectsDir?: string; pane?: Pane; asks?: TuneAsks; now?: number } = {}): {
  deps: TuneDeps
  pane: Pane
} {
  const pane: Pane = over.pane ?? { written: [], verdict: 'allow' }
  return {
    pane,
    deps: {
      node: (id) => (id === 'term-1' ? node() : null),
      write: (_id, data) => {
        if (pane.verdict === 'allow') pane.written.push(data)
        return pane.verdict
      },
      asks: over.asks ?? new TuneAsks(),
      watch: { projectsDir: over.projectsDir },
      now: over.now === undefined ? undefined : () => over.now as number
    }
  }
}

describe('turning a dial', () => {
  it('types the line and submits it, and remembers the ask', () => {
    const asks = new TuneAsks()
    const { deps: d, pane } = deps({ asks, now: 1_759_000_000_000 })
    const result = applyTuning(d, 'term-1', 'model', 'sonnet')
    expect(result.ok).toBe(true)
    expect(pane.written).toEqual(['/model sonnet', '\r'])
    expect(asks.of('term-1')).toEqual([
      { knob: 'model', value: 'sonnet', at: 1_759_000_000_000 }
    ])
  })

  it('never submits when the gate held the line back', () => {
    // A bare carriage return on a refused line would submit whatever IS in
    // the box — on a contaminated box, someone else's half-typed prompt.
    const asks = new TuneAsks()
    const { deps: d, pane } = deps({ asks, pane: { written: [], verdict: 'refused' } })
    const result = applyTuning(d, 'term-1', 'effort', 'low')
    expect(result).toEqual({ ok: false, reason: 'the input box is not free' })
    expect(pane.written).toEqual([])
    expect(asks.of('term-1')).toEqual([])
  })

  it('refuses a value and a knob it does not offer, before anything is typed', () => {
    const { deps: d, pane } = deps()
    expect(applyTuning(d, 'term-1', 'model', 'claude-opus-4-8').ok).toBe(false)
    expect(applyTuning(d, 'term-1', 'effort', 'ludicrous').ok).toBe(false)
    expect(applyTuning(d, 'term-1', 'permissions' as 'model', 'opus').ok).toBe(false)
    expect(pane.written).toEqual([])
  })

  it('refuses a card with no dials', () => {
    const { deps: d } = deps()
    const shell: TuneDeps = { ...d, node: () => node({ command: 'bash' }) }
    expect(applyTuning(shell, 'term-1', 'model', 'opus')).toEqual({
      ok: false,
      reason: 'this agent has no dials'
    })
    expect(applyTuning(d, 'nobody', 'model', 'opus').ok).toBe(false)
  })

  it('keeps only the recent asks, and forgets them all when the pane ends', () => {
    const asks = new TuneAsks()
    const { deps: d } = deps({ asks })
    for (const value of ['fable', 'opus', 'sonnet', 'haiku', 'opus'] as const) {
      applyTuning(d, 'term-1', 'model', value)
    }
    expect(asks.of('term-1')).toHaveLength(4)
    asks.forget('term-1')
    expect(asks.of('term-1')).toEqual([])
  })
})

describe('the state the rail is handed', () => {
  it('joins the readout to the unsettled asks', () => {
    const projectsDir = projectsWith([reply('claude-opus-5', 'max', '2026-09-27T03:00:00.000Z')])
    const asks = new TuneAsks()
    const { deps: d } = deps({ asks, projectsDir, now: Date.parse('2026-09-27T04:00:00.000Z') })
    applyTuning(d, 'term-1', 'effort', 'low')
    expect(tuningStateOf(d, 'term-1')).toEqual({
      harness: 'claude',
      knobs: ['model', 'effort'],
      tuning: {
        model: 'claude-opus-5',
        effort: 'max',
        at: Date.parse('2026-09-27T03:00:00.000Z')
      },
      asks: [{ knob: 'effort', value: 'low', at: Date.parse('2026-09-27T04:00:00.000Z') }],
      caveat: 'this also becomes the default every new agent boots on'
    })
  })

  it('answers "no harness" for a plain shell so the rail is not drawn', () => {
    const { deps: d } = deps()
    const shell: TuneDeps = { ...d, node: () => node({ command: 'bash' }) }
    expect(tuningStateOf(shell, 'term-1')).toEqual({
      harness: null,
      knobs: [],
      tuning: null,
      asks: [],
      caveat: null
    })
  })

  it('answers "no dials" for a harness that has none', () => {
    const { deps: d } = deps()
    const codex: TuneDeps = { ...d, node: () => node({ command: 'codex' }) }
    const state = tuningStateOf(codex, 'term-1')
    expect(state.harness).toBe('codex')
    expect(state.knobs).toEqual([])
    // The caveat belongs to the harness that declared it, not to the rail.
    expect(state.caveat).toBeNull()
  })
})
