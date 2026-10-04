import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DispatchService,
  appendDispatchRecord,
  persistedRecord,
  readDispatchRecords,
  type DispatchDeps
} from '../src/main/dispatch'

/**
 * WHERE A SIGNAL COMES FROM.
 *
 * Two producers mint "A asked B" and "B answered A": the CLI ask, which knows
 * the caller pane, and the dispatch engine for `ask --no-wait`, which is
 * handed the asker as an in-memory `origin`. The moments are exact — the
 * prompt is in the pane (the record first becomes `running`), and the turn
 * closes the record `done` — and the owner's own dispatches, which carry no
 * origin, light nothing.
 */

const PROMPT = 'Run the F2 simulation and report the counts.'
const NOW = 1_700_000_000_000

interface Moment {
  from: string
  to: string
  kind: 'ask' | 'answer'
}

function deps(moments: Moment[], over: Partial<DispatchDeps> = {}): DispatchDeps {
  return {
    resolveAgent: (id) => (id === 'forge' ? { name: 'Forge', workspaceId: 'ws-1' } : null),
    sessionNameFor: (id) => `cookrew_${id}`,
    sessionExists: () => true,
    capture: () => 'idle\n> ',
    promptAgent: async () => 'done',
    noteDispatch: () => true,
    beginWork: () => true,
    endWork: () => undefined,
    persist: () => true,
    newId: () => 'dsp-1',
    now: () => NOW,
    signal: (m) => {
      moments.push(m)
    },
    ...over
  }
}

async function dispatched(
  service: DispatchService,
  input: { text: string; origin?: string }
): Promise<string> {
  const response = await service.dispatch('forge', input)
  expect(response.status).toBe(202)
  const id = String((response.body as { dispatchId: string }).dispatchId)
  await service.settled(id)
  return id
}

describe('the dispatch engine lights the cable', () => {
  it('asks when the prompt is in the pane, and answers when the turn closes it done', async () => {
    const moments: Moment[] = []
    const service = new DispatchService(deps(moments))
    const id = await dispatched(service, { text: PROMPT, origin: 'orch' })
    expect(moments).toEqual([{ from: 'orch', to: 'forge', kind: 'ask' }])
    service.completeTurn(id, { turnIndex: 3, reply: 'counts attached' })
    expect(moments).toEqual([
      { from: 'orch', to: 'forge', kind: 'ask' },
      { from: 'forge', to: 'orch', kind: 'answer' }
    ])
  })

  it('asks ONCE however many delivery branches stamp running', async () => {
    // Native `done` and a landed-after-stall both move the record to running;
    // the signal is the transition, not the branch.
    const moments: Moment[] = []
    const service = new DispatchService(
      deps(moments, { promptAgent: async () => 'submitted', captureDeep: () => `> ${PROMPT}\nworking` })
    )
    await dispatched(service, { text: PROMPT, origin: 'orch' })
    expect(moments.filter((m) => m.kind === 'ask')).toHaveLength(1)
  })

  it('lights nothing on a failed or interrupted ending', async () => {
    const moments: Moment[] = []
    const service = new DispatchService(deps(moments))
    const id = await dispatched(service, { text: PROMPT, origin: 'orch' })
    service.completeTurn(id, { turnIndex: 3, outcome: 'failed' })
    expect(moments.map((m) => m.kind)).toEqual(['ask'])
    const other = new DispatchService(deps(moments, { newId: () => 'dsp-2' }))
    const second = await dispatched(other, { text: PROMPT, origin: 'orch' })
    other.interrupt(second, 'interrupted: the backend died')
    expect(moments.map((m) => m.kind)).toEqual(['ask', 'ask'])
  })

  it('lights nothing for the owner’s own dispatch — there is no cable from the owner', async () => {
    const moments: Moment[] = []
    const service = new DispatchService(deps(moments))
    const id = await dispatched(service, { text: PROMPT })
    service.completeTurn(id, { turnIndex: 1, reply: 'ok' })
    expect(moments).toEqual([])
  })

  it('keeps the asker out of the ledger and off the wire', async () => {
    // The origin is a canvas fact, not a settlement fact: the durable row
    // (appendDispatchRecord → persistedRecord) and the HTTP projection do not
    // carry it, so a consumer and a restart see exactly what they saw.
    const dir = mkdtempSync(path.join(tmpdir(), 'cookrew-cable-signal-'))
    const file = path.join(dir, 'dispatches.jsonl')
    const service = new DispatchService(deps([], { persist: (record) => appendDispatchRecord(file, record) }))
    const id = await dispatched(service, { text: PROMPT, origin: 'orch' })
    const rows = readDispatchRecords(file)
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) expect(row).not.toHaveProperty('origin')
    expect(service.lookup(id).body).not.toHaveProperty('origin')
    expect(persistedRecord({ ...rows[0], origin: 'orch' })).not.toHaveProperty('origin')
    rmSync(dir, { recursive: true, force: true })
  })

  it('survives a throwing bridge — the canvas is downstream of the dispatch, never in its path', async () => {
    const service = new DispatchService(
      deps([], {
        signal: () => {
          throw new Error('renderer gone')
        }
      })
    )
    const id = await dispatched(service, { text: PROMPT, origin: 'orch' })
    expect(() => service.completeTurn(id, { turnIndex: 1, reply: 'ok' })).not.toThrow()
    expect(service.lookup(id).body.state).toBe('done')
  })
})

describe('the CLI ask lights the cable from the caller pane', () => {
  // Structural: cmdAsk is reached only through the unix socket, and the
  // moment is a one-line call either side of the delivery it brackets.
  const source = readFileSync(path.join(__dirname, '..', 'src', 'main', 'socket-server.ts'), 'utf8')
  const cmdAsk = source.slice(source.indexOf('async function cmdAsk('), source.indexOf('\n}\n', source.indexOf('async function cmdAsk(')))

  it('asks as the prompt goes out and answers as the reply comes back', () => {
    const ask = cmdAsk.indexOf("deps.signal?.({ from: me.id, to: target.id, kind: 'ask' })")
    const deliver = cmdAsk.indexOf('await deliverAndConfirm(')
    const answer = cmdAsk.indexOf("deps.signal?.({ from: target.id, to: me.id, kind: 'answer' })")
    expect(ask).toBeGreaterThan(-1)
    expect(deliver).toBeGreaterThan(ask)
    expect(answer).toBeGreaterThan(deliver)
  })

  it('hands the engine the asker for --no-wait, so the same two moments fire there', () => {
    expect(cmdAsk).toContain('{ text: prompt, origin: me.id }')
  })
})
