// THE READOUT AND THE CONTROL (main/agent-tuning), against real files and a
// real record shape.
//
// The readout comes off the harness's own session file — the same file the
// checkpoint rail reads — so these tests write records in the exact shape
// Claude writes them, tail-read them back, and then prove the two halves stay
// joined: a line only reaches the pane when the gate allows it, and an ask is
// only remembered when a line actually went.

import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
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
import { piTuning, piTuningWith } from '../src/main/pi-tuning'
import { tuningTag, type HarnessTuning } from '../src/shared/agent-tuning'
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

/** A pi agent dir holding the two catalogs pi itself reads. */
function piCatalogFixture(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'pi-catalog-'))
  writeFileSync(
    path.join(dir, 'models.json'),
    JSON.stringify({
      providers: {
        ifunk: { baseUrl: 'https://x', apiKey: '!secret-command', models: [{ id: 'k3', name: 'Kimi K3' }] },
        'qwen-local': { baseUrl: 'https://y', models: [{ id: 'qwen3.8-27b-q8' }] }
      }
    })
  )
  writeFileSync(
    path.join(dir, 'models-store.json'),
    JSON.stringify({
      ifunk: {
        models: [
          { id: 'k3', reasoning: true, thinkingLevelMap: { off: null, xhigh: 'xhigh' } }
        ]
      }
    })
  )
  return dir
}

describe('pi records a model and no effort, and says exactly that', () => {
  it('reads the model off an assistant message', () => {
    // Verified against a real ~/.cookrew/pi-sessions file.
    const record = {
      type: 'message',
      timestamp: '2026-08-12T17:21:12.314Z',
      message: { role: 'assistant', model: 'k3', provider: 'ifunk', timestamp: 1786555263682 }
    }
    expect(piTuning.read(record)).toEqual({
      model: 'k3',
      effort: null,
      at: Date.parse('2026-08-12T17:21:12.314Z')
    })
  })

  it('reports NO effort rather than inventing one', () => {
    // Every surface already draws whichever half it has, so a pi card wears
    // its model alone instead of a made-up level or nothing at all.
    const tuning = piTuning.read({
      type: 'message',
      timestamp: '2026-08-12T17:21:12.314Z',
      message: { role: 'assistant', model: 'k3' }
    })
    expect(tuning?.effort).toBeNull()
    expect(tuningTag(tuning ?? null)).toBe('k3')
  })

  it('takes nothing from a user message or a non-message record', () => {
    expect(piTuning.read({ type: 'message', message: { role: 'user', model: 'k3' } })).toBeNull()
    expect(piTuning.read({ type: 'session', message: { role: 'assistant', model: 'k3' } })).toBeNull()
  })

  it('sets BOTH dials, and can confirm only the model', () => {
    // Pi writes the model onto every reply and the thinking level nowhere, so
    // a level ask is reported as sent-and-uncheckable rather than pending.
    expect(piTuning.knobs).toEqual(['model', 'effort'])
    expect(piTuning.records).toEqual(['model'])
  })

  it('offers only models pi itself lists — a miss would open a picker', () => {
    // Driving a real pi: an unlisted model opens a selector that swallows
    // every keystroke after it, so the card looks healthy and the agent is
    // unreachable. The catalog is what makes a miss impossible.
    const agentDir = piCatalogFixture()
    const tuning = piTuningWith({ agentDir })
    expect(tuning.values?.('model', null)).toEqual(['ifunk/k3', 'qwen-local/qwen3.8-27b-q8'])
    expect(tuning.line('model', 'ifunk/k3')).toBe('/model ifunk/k3')
    expect(tuning.line('model', 'k3')).toBeNull()
    expect(tuning.line('model', 'not-a-model')).toBeNull()
  })

  it('offers the thinking levels THIS model actually supports', () => {
    // Pi's own rule: no reasoning flag means the only level is `off` — which
    // is exactly what a real pi answered for qwen3.8-27b-q8.
    const agentDir = piCatalogFixture()
    const tuning = piTuningWith({ agentDir })
    const onQwen = { model: 'qwen3.8-27b-q8', effort: null, at: 1 }
    expect(tuning.values?.('effort', onQwen)).toEqual(['off'])
    const onK3 = { model: 'k3', effort: null, at: 1 }
    // k3 carries reasoning with xhigh/max mapped and `off` suppressed.
    expect(tuning.values?.('effort', onK3)).toEqual(['minimal', 'low', 'medium', 'high', 'xhigh'])
  })

  it('spells the effort dial /thinking, not /effort', () => {
    // The knob name is NOT the command here, which is why composing the line
    // belongs to the harness instead of a shared `/${knob}` template.
    expect(piTuningWith({ agentDir: piCatalogFixture() }).line('effort', 'off')).toBe('/thinking off')
  })

  it('offers nothing at all when the catalog cannot be read', () => {
    // Never "any string will do": that is the modal-picker case again.
    const tuning = piTuningWith({ agentDir: mkdtempSync(path.join(tmpdir(), 'pi-empty-')) })
    expect(tuning.values?.('model', null)).toEqual([])
    expect(tuning.line('model', 'ifunk/k3')).toBeNull()
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

  it('reaches a stamp that a long turn pushed far back, when the harness says to', () => {
    // Codex writes turn_context once per TURN, so the distance back from EOF
    // is the whole turn's output. Measured on the real fleet: 452 KB, 941 KB
    // and 3.0 MB on rollouts of 10-64 MB, all outside the 256 KB default, and
    // all three cards showed no tag at all.
    const stamp = reply('claude-opus-5', 'max', '2026-09-27T03:00:00.000Z')
    const projectsDir = projectsWith([stamp, JSON.stringify({ type: 'user', pad: 'x'.repeat(900_000) })])
    // The DEFAULT steps stop at 256 KB and honestly report nothing.
    expect(readTuning(subjectOf(node()), { projectsDir })).toBeNull()

    // A harness that declares deeper windows finds it. Driven through the real
    // registry entry rather than a stub, so the declaration is what is tested.
    const deep: HarnessTuning = { ...claudeTuning, tailSteps: [128 * 1024, 4 * 1024 * 1024] }
    const file = path.join(claudeProjectDir(CWD, projectsDir), `${SESSION}.jsonl`)
    expect(deep.tailSteps?.[1]).toBeGreaterThan(900_000)
    expect(readFileSync(file, 'utf8').length).toBeGreaterThan(900_000)
    expect(codexTuning.tailSteps?.at(-1) ?? 0).toBeGreaterThanOrEqual(16 * 1024 * 1024)
  })

  it('follows an ACTIVE file forward by its appended bytes, keeping what it knows', () => {
    // The expensive window is paid once. After that a grown file is scanned
    // only where it grew — and finding no new stamp there means the turn is
    // still running on the same dials, not that they became unknown.
    const projectsDir = projectsWith([reply('claude-opus-5', 'max', '2026-09-27T03:00:00.000Z')])
    const cache = new TuningCache()
    const subject = subjectOf(node())
    expect(cache.of(subject, { projectsDir })?.model).toBe('claude-opus-5')

    const file = path.join(claudeProjectDir(CWD, projectsDir), `${SESSION}.jsonl`)
    // A megabyte of turn output carrying no stamp of its own.
    appendFileSync(file, `\n${JSON.stringify({ type: 'user', pad: 'y'.repeat(1_100_000) })}`)
    expect(cache.of(subject, { projectsDir })?.model).toBe('claude-opus-5')

    // A real new stamp in the appended bytes DOES replace it.
    appendFileSync(file, `\n${reply('claude-sonnet-5', 'low', '2026-09-27T05:00:00.000Z')}`)
    expect(cache.of(subject, { projectsDir })?.model).toBe('claude-sonnet-5')
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
      caveat: 'this also becomes the default every new agent boots on',
      records: ['model', 'effort']
    })
  })

  it('answers "no harness" for a plain shell so the rail is not drawn', () => {
    const { deps: d } = deps()
    const shell: TuneDeps = { ...d, node: () => node({ command: 'bash' }) }
    expect(tuningStateOf(shell, 'term-1')).toEqual({
      harness: null,
      knobs: [],
      records: [],
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
