// Does the ledger actually derive from the transcripts? This answers it by
// doing it: read the real ~/.cookrew/turns for an agent, regenerate that
// agent's records from its harness session file into a TEMP store, and compare.
//
// Fixtures cannot prove this. A hand-built session file only proves the parser
// is self-consistent; the claim being tested is about ~2 GB of real
// transcripts written by four harnesses over months, including the shapes
// nobody designed for (rewinds, sibling prompts, capped ledgers, pruned
// sessions). So the corpus is the real machine state, and the temp store is
// the only thing written to — the real ledger is opened read-only.
//
// Skips LOUDLY when a machine has no ledger or no transcripts (CI, a fresh
// clone). A silent pass here would be worse than no test: it would report
// "the ledger is derived" on a machine that never checked.

import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  derivedFields,
  diffLedger,
  rebuildLedger,
  rebuildLedgerInto,
  type RebuildTarget
} from '../src/main/ledger-rebuild'
import { TurnStore } from '../src/main/turn-store'
import type { TurnRecord } from '../src/shared/turn'

const TURNS_DIR = path.join(homedir(), '.cookrew', 'turns')
const AGENTS_FILE = path.join(homedir(), '.cookrew', 'agents.json')

interface RegistryAgent {
  id: string
  name: string
  command?: string
  cwd?: string
  sessionRef?: string | null
}

function registryAgents(): RegistryAgent[] {
  if (!existsSync(AGENTS_FILE)) return []
  try {
    const raw: unknown = JSON.parse(readFileSync(AGENTS_FILE, 'utf8'))
    const list = Array.isArray(raw) ? raw : (raw as { agents?: unknown[] }).agents
    return Array.isArray(list) ? (list as RegistryAgent[]) : []
  } catch {
    return []
  }
}

/**
 * A registry entry as a rebuild target. The harness reads its session ref off
 * the node field it owns, and the registry stores that same value flattened as
 * `sessionRef`, so every harness field is set to it — only the harness that
 * matches the command will look.
 */
function target(agent: RegistryAgent): RebuildTarget {
  const ref = agent.sessionRef ?? undefined
  return {
    id: agent.id,
    command: agent.command ?? '',
    cwd: agent.cwd ?? '',
    claudeSessionId: ref,
    codexSessionRef: ref,
    opencodeSessionId: ref,
    piSessionId: ref
  } as RebuildTarget
}

const ledger = existsSync(TURNS_DIR) ? new TurnStore().loadAll() : new Map<string, TurnRecord[]>()
const agents = registryAgents()

/**
 * How long a ledger must sit untouched before this suite will read it.
 *
 * The corpus is the live machine, so an agent that is mid-turn RIGHT NOW is in
 * it — including, on a developer's box, the agent running these very tests.
 * Its newest record is still being written: `endedAt` advances every few
 * seconds until the turn settles. Any assertion that reads the ledger twice
 * and compares then depends on whether output happened to land in between.
 *
 * Observed directly: index 344 read 4s apart gave endedAt 1786073186716 then
 * 1786073194797 — same record, different value, no bug.
 *
 * Excluding live agents keeps the assertions STRICT rather than loosening them
 * to tolerate drift. It costs almost nothing: measured on this machine, 1 of
 * 129 ledgers had been written in the last minute and 118 were over an hour
 * old, against a corpus floor of 5.
 */
const QUIET_MS = 60_000

/** True when nothing has appended to this agent's ledger recently. */
function quiet(agentId: string, now = Date.now()): boolean {
  try {
    const file = path.join(TURNS_DIR, `${agentId}.jsonl`)
    return !existsSync(file) || now - statSync(file).mtimeMs >= QUIET_MS
  } catch {
    // Unreadable mtime is not evidence of writing; the stored/rebuild filters
    // below still decide whether this agent is usable at all.
    return true
  }
}

const live = agents.filter((agent) => !quiet(agent.id))

/**
 * Agents whose ledger we can actually check: settled on disk, rebuild
 * succeeded, AND a ledger exists.
 */
const derivable = agents
  .filter((agent) => quiet(agent.id))
  .map((agent) => ({ agent, stored: ledger.get(agent.id) ?? [], rebuild: rebuildLedger(target(agent)) }))
  .filter((row) => row.rebuild.ok && row.stored.length > 0)

// Say what was skipped. A corpus that silently shrinks reads as "everything
// passed" when it might mean "almost nothing was checked".
if (live.length > 0) {
  console.error(
    `ledger-rebuild: ${live.length} agent(s) writing within ${QUIET_MS / 1000}s — excluded from the corpus`
  )
}

const CORPUS_MIN_AGENTS = 5
const usable = derivable.length >= CORPUS_MIN_AGENTS

if (!usable) {
  describe('ledger derivation (real corpus)', () => {
    it.skip(
      `no local corpus — ${ledger.size} ledgers, ${agents.length} registry agents, ` +
        `${derivable.length} rebuildable (need ${CORPUS_MIN_AGENTS}); derivation NOT verified`,
      () => {}
    )
  })
}

/**
 * The population a rebuild is answerable for.
 *
 * Two kinds of stored record can never be re-derived, and both are facts about
 * the record rather than the parser:
 *
 *  - The agent's NEWEST checkpoint. The ledger is a snapshot taken when the
 *    tracker called the turn finished; an agent that kept talking has a
 *    transcript that moved on. The rebuild is the fresher of the two, and
 *    SessionTurnSync closes the gap on its next poll.
 *  - Records with NO uuid. Those predate session binding — PTY-scraped when
 *    there was no transcript to bind to. Asking a transcript to reproduce a
 *    record that never came from one is not a test, it is a category error.
 *
 * Everything else — every settled record that CLAIMS a session identity — must
 * derive exactly. Measured on this machine: 1204 settled records, of which the
 * 131 that drift are uuid-less legacy rows, 0 exceptions.
 */
function settledBound(stored: TurnRecord[]): TurnRecord[] {
  if (stored.length === 0) return []
  const newest = Math.max(...stored.map((r) => r.index))
  return stored.filter((r) => r.index !== newest && r.uuid !== undefined)
}

describe.runIf(usable)('ledger derivation — regenerate from the transcript and compare', () => {
  it('rebuilds a real agent into a temp store and reproduces its settled checkpoints', () => {
    // The headline claim, executed: regenerate somewhere else and compare. The
    // busiest agent is chosen because a long history is where rewinds and
    // sibling collapses actually occur.
    const richest = [...derivable].sort((a, b) => b.stored.length - a.stored.length)[0]
    const store = new TurnStore(mkdtempSync(path.join(tmpdir(), 'cookrew-rebuild-')))
    const result = rebuildLedgerInto(store, target(richest.agent))

    expect(result.ok, `rebuild blocked for ${richest.agent.name}`).toBe(true)
    const reloaded = store.load(richest.agent.id)
    expect(reloaded.length).toBeGreaterThan(0)

    // Round-trips through the store: what was written is what comes back.
    expect(reloaded.map(derivedFields)).toEqual(
      (result.ok ? result.records : []).map(derivedFields)
    )

    const drift = diffLedger(settledBound(richest.stored), reloaded)
    expect(
      drift,
      `${richest.agent.name} (${richest.stored.length} stored): ${JSON.stringify(drift.slice(0, 3))}`
    ).toEqual([])
  })

  it('derives EVERY session-bound settled checkpoint in the corpus, exactly', () => {
    // The real assertion: exact zero over every agent on this machine, not a
    // sample — the shapes that break derivation are rare, so a sample is how
    // you miss them. A parser regression shows up here immediately.
    const drifted: { name: string; drift: number; first: unknown }[] = []
    let records = 0
    for (const row of derivable) {
      if (!row.rebuild.ok) continue
      const bound = settledBound(row.stored)
      records += bound.length
      const drift = diffLedger(bound, row.rebuild.records)
      if (drift.length > 0) {
        drifted.push({ name: row.agent.name, drift: drift.length, first: drift[0] })
      }
    }
    expect(records, 'corpus too small to mean anything').toBeGreaterThan(200)
    expect(
      drifted,
      `${drifted.length}/${derivable.length} agents drift over ${records} session-bound settled ` +
        `records: ${JSON.stringify(drifted.slice(0, 5), null, 2)}`
    ).toEqual([])
  })

  it('confines the KNOWN drift to stale tails and uuid-less legacy rows', () => {
    // The census that keeps the carve-out honest. Everything excluded above is
    // counted here and attributed, so a NEW kind of drift cannot hide inside
    // the exclusion: it would land in `unexplained` and fail.
    let staleTail = 0
    let legacyScrape = 0
    const unexplained: unknown[] = []
    for (const row of derivable) {
      if (!row.rebuild.ok) continue
      const newest = Math.max(...row.stored.map((r) => r.index))
      const byIndex = new Map(row.stored.map((r) => [r.index, r]))
      for (const d of diffLedger(row.stored, row.rebuild.records)) {
        if (d.index === newest) staleTail += 1
        else if (byIndex.get(d.index)?.uuid === undefined) legacyScrape += 1
        else unexplained.push(d)
      }
    }
    expect(
      unexplained,
      `drift outside the two known classes: ${JSON.stringify(unexplained.slice(0, 5))}`
    ).toEqual([])
    // Recorded, not asserted tightly: these move with the machine's history.
    expect(staleTail + legacyScrape).toBeGreaterThan(0)
  })

  it('checks a corpus worth trusting', () => {
    // Guards the guard: if the corpus quietly shrank to two agents, the tests
    // above would still pass and would be proving almost nothing.
    expect(derivable.length).toBeGreaterThanOrEqual(CORPUS_MIN_AGENTS)
  })

  it('rebuilds identity, not just text — every record carries a checkpoint id', () => {
    // The join key the rail, restore and fork all pair on. A rebuild that
    // reproduced prompts but dropped identity would look fine on text and
    // break every one of those features.
    for (const row of derivable.slice(0, 10)) {
      if (!row.rebuild.ok) continue
      for (const record of row.rebuild.records) {
        expect(typeof record.uuid, `${row.agent.name} checkpoint ${record.index}`).toBe('string')
        expect(record.uuid!.length).toBeGreaterThan(0)
      }
    }
  })

  it('assigns each checkpoint a distinct, 1-based, gapless index', () => {
    for (const row of derivable.slice(0, 10)) {
      if (!row.rebuild.ok) continue
      const indexes = row.rebuild.records.map((r) => r.index)
      expect(indexes, row.agent.name).toEqual(indexes.map((_, i) => i + 1))
    }
  })

  it('is repeatable: the same transcript rebuilds to the same records', () => {
    // Derivation with any nondeterminism in it (a clock, a Map iteration, a
    // random id) is not derivation. The property is about the SAME BYTES —
    // this suite runs against the live corpus, and the most active agent's
    // transcript grows between module load and this test body (measured: the
    // Conductor rebuilding itself while running the suite), which is growth,
    // not nondeterminism. So: rebuild twice back-to-back and only compare
    // when the file provably did not change between the two reads.
    for (const row of derivable.slice(0, 8)) {
      if (!row.rebuild.ok) continue
      const file = row.rebuild.sessionFile
      const before = statSync(file)
      const first = rebuildLedger(target(row.agent))
      const second = rebuildLedger(target(row.agent))
      const after = statSync(file)
      if (before.mtimeMs !== after.mtimeMs || before.size !== after.size) continue
      expect(first.ok).toBe(true)
      expect(second.ok).toBe(true)
      expect((second.ok ? second.records : []).map(derivedFields)).toEqual(
        (first.ok ? first.records : []).map(derivedFields)
      )
      return
    }
    // Every candidate was mid-write — determinism cannot be measured on a
    // moving file; the corpus gates above still verified exactness.
    expect(derivable.length).toBeGreaterThan(0)
  })
})

describe.runIf(usable)('ledger derivation — the temp store never touches the real ledger', () => {
  it('writes only into the directory it was given', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cookrew-rebuild-'))
    const store = new TurnStore(dir)
    const row = derivable[0]
    // Baseline read HERE, not at module load. The module-load snapshot is
    // minutes old by the time this runs, so anything appended in between was
    // being reported as "the rebuild wrote into the real ledger" — a false
    // alarm on a safety property, which is the worst kind to cry wolf on.
    const before = new TurnStore().load(row.agent.id).map(derivedFields)
    rebuildLedgerInto(store, target(row.agent))
    // The record landed in the temp dir…
    expect(store.load(row.agent.id).length).toBeGreaterThan(0)
    // …and the real ledger still reads exactly as before.
    expect(new TurnStore().load(row.agent.id).map(derivedFields)).toEqual(before)
  })
})

describe('rebuildLedger — what is NOT derivable says so', () => {
  it('refuses a scrape-only harness by name rather than returning an empty history', () => {
    // opencode declares turns: 'scrape'. Its ledger IS the only record, so a
    // caller must be able to tell "nothing to derive" from "derived to
    // nothing" before it deletes anything.
    const result = rebuildLedger({ id: 't', command: 'opencode', cwd: '/tmp' } as RebuildTarget)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('scrape-only')
    expect(result.harness).toBe('opencode')
    expect(result.detail).toMatch(/scrape/i)
  })

  it('refuses a command that matches no harness', () => {
    const result = rebuildLedger({ id: 't', command: 'zsh', cwd: '/tmp' } as RebuildTarget)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('no-harness')
      expect(result.harness).toBeNull()
    }
  })

  it('reports an unbound file-harness as unbound, not as an empty rebuild', () => {
    const result = rebuildLedger({ id: 't', command: 'claude', cwd: '/tmp' } as RebuildTarget)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(['unbound', 'session-missing']).toContain(result.reason)
  })

  it('reports a session file that is not on disk', () => {
    const result = rebuildLedger({
      id: 't',
      command: 'claude',
      cwd: '/tmp',
      claudeSessionId: '00000000-0000-4000-8000-000000000000'
    } as RebuildTarget)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(['session-missing', 'unbound']).toContain(result.reason)
  })

  it('writes NOTHING into the store when the rebuild is blocked', () => {
    // The dangerous case: a blocked rebuild that still saved would replace a
    // scrape-only agent's real history with an empty file.
    const store = new TurnStore(mkdtempSync(path.join(tmpdir(), 'cookrew-rebuild-')))
    const result = rebuildLedgerInto(store, {
      id: 'scrape-agent',
      command: 'opencode',
      cwd: '/tmp'
    } as RebuildTarget)
    expect(result.ok).toBe(false)
    expect(store.load('scrape-agent')).toEqual([])
  })
})

describe('diffLedger — pairs by checkpoint identity, not array position', () => {
  const rec = (over: Partial<TurnRecord> & { index: number }): TurnRecord => ({
    prompt: 'p',
    reply: 'r',
    startedAt: 1,
    endedAt: 2,
    ...over
  })

  it('is empty when the transcript-owned fields agree', () => {
    expect(diffLedger([rec({ index: 1 })], [rec({ index: 1 })])).toEqual([])
  })

  it('ignores annotations, which the transcript cannot own', () => {
    // A ledger carrying a Sous title and a read marker still counts as fully
    // derived — those live in the sidecar, and demanding them would fail a
    // correct rebuild.
    const stored = [rec({ index: 1, title: 'Recap', seenAt: 99, scrollLine: 1234 })]
    expect(diffLedger(stored, [rec({ index: 1 })])).toEqual([])
  })

  it('does not report a CAPPED ledger as drift', () => {
    // The ledger may hold fewer checkpoints than the transcript. That is a
    // shorter index over the same conversation, not a disagreement.
    const stored = [rec({ index: 4 }), rec({ index: 5 })]
    const rebuilt = [rec({ index: 3 }), rec({ index: 4 }), rec({ index: 5 })]
    expect(diffLedger(stored, rebuilt)).toEqual([])
  })

  it('pairs on index even when positions differ', () => {
    // Positional pairing would call every row wrong here.
    const stored = [rec({ index: 9, prompt: 'nine' })]
    const rebuilt = [rec({ index: 8, prompt: 'eight' }), rec({ index: 9, prompt: 'nine' })]
    expect(diffLedger(stored, rebuilt)).toEqual([])
  })

  it('reports a changed prompt, naming the checkpoint and both sides', () => {
    const drift = diffLedger([rec({ index: 2, prompt: 'was' })], [rec({ index: 2, prompt: 'now' })])
    expect(drift).toEqual([{ index: 2, field: 'prompt', stored: 'was', rebuilt: 'now' }])
  })

  it('reports a stored checkpoint the transcript no longer has', () => {
    const drift = diffLedger([rec({ index: 7, prompt: 'gone' })], [])
    expect(drift).toEqual([{ index: 7, field: 'missing', stored: 'gone', rebuilt: null }])
  })

  it('reports a changed identity — the join key features pair on', () => {
    const drift = diffLedger(
      [rec({ index: 1, uuid: 'a' })],
      [rec({ index: 1, uuid: 'b' })]
    )
    expect(drift).toEqual([{ index: 1, field: 'uuid', stored: 'a', rebuilt: 'b' }])
  })
})
