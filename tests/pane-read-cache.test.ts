import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const PTY = readFileSync(join(__dirname, '../src/renderer/../main/pty.ts'), 'utf8')
const TRACKER = readFileSync(join(__dirname, '../src/main/turn-tracker.ts'), 'utf8')

/**
 * Profiled on the live main process: execFileSync was 5,189ms of 5,475ms total
 * main-thread JS in 20s (94.5%), reached through
 *   execFileSync → herdr → readPanes → panes → paneFor → scrollState
 *   → paneScrollState → activityOf → push
 * The activity push forked the herdr CLI once per tracked terminal, blocking
 * the thread. That is the constant-payload latency measured from outside.
 */
describe('the activity push does not fork the CLI per terminal', () => {
  it('activityOf reads the CACHED pane state', () => {
    const body = TRACKER.slice(TRACKER.indexOf('private activityOf'))
    expect(body).toMatch(/paneScrollStateCached\?\.\(\)/)
  })

  it('bounds the staleness it accepts', () => {
    expect(PTY).toMatch(/const PANE_STATE_TTL_MS = 500/)
    const fn = PTY.slice(PTY.indexOf('paneScrollStateCached()'), PTY.indexOf('scrollRow(): number | null'))
    expect(fn).toMatch(/now - this\.paneStateAt < PANE_STATE_TTL_MS/)
  })

  it('falls back to the exact read where the cached one is absent', () => {
    // A PtySession stub without the new method must still produce activity
    // rather than throwing — the tracker is fed fakes in several suites.
    const body = TRACKER.slice(TRACKER.indexOf('private activityOf'))
    expect(body).toMatch(/paneScrollState\?\.\(\) \?\? \{ scrollRow: null, historySize: null \}/)
  })
})

/**
 * The safety argument, asserted rather than trusted. Caching `scrollState`
 * itself would have fixed every caller at once — and made the checkpoint anchor
 * stale-servable, because scrollAnchor() reads the same value and it becomes
 * TurnRecord.scrollLine. A stale anchor is a checkpoint pointing at the wrong
 * place in the transcript: a mark that lies, which is worse than a slow one.
 */
describe('the checkpoint anchor keeps the exact reading', () => {
  it('scrollAnchor does NOT use the cached path', () => {
    const fn = PTY.slice(PTY.indexOf('scrollAnchor(): number | null'))
    const body = fn.slice(0, fn.indexOf('}'))
    expect(body).toMatch(/paneScrollState\(\)/)
    expect(body).not.toMatch(/paneScrollStateCached/)
  })

  it('scrollRow does NOT use the cached path either', () => {
    const fn = PTY.slice(PTY.indexOf('scrollRow(): number | null'))
    const body = fn.slice(0, fn.indexOf('}'))
    expect(body).not.toMatch(/paneScrollStateCached/)
  })

  it('keeps scrollState EXACT (paneFor) so the anchor read cannot be stale-served', () => {
    // The exact method still forks — anchors are read at turn boundaries, not on
    // the activity path, so they pay the fork to stay truthful.
    const mux = readFileSync(join(__dirname, '../src/main/herdr-host-multiplexer.ts'), 'utf8')
    const fn = mux.slice(mux.indexOf('scrollState(name: string): ScrollState'))
    expect(fn.slice(0, 120)).toMatch(/toScrollState\(this\.paneFor\(name\)\)/)
  })

  it('the ACTIVITY path reads the fork-free stale inventory, not the exact fork', () => {
    // scrollStateStale serves from paneFromInventory (the async, no-fork cache);
    // pty.ts routes the activity cache-miss through it so activityOf never forks.
    const mux = readFileSync(join(__dirname, '../src/main/herdr-host-multiplexer.ts'), 'utf8')
    const stale = mux.slice(mux.indexOf('scrollStateStale(name: string): ScrollState'))
    expect(stale.slice(0, 130)).toMatch(/toScrollState\(this\.paneFromInventory\(name\)\)/)

    const pty = readFileSync(join(__dirname, '../src/main/pty.ts'), 'utf8')
    const cached = pty.slice(pty.indexOf('paneScrollStateCached()'), pty.indexOf('scrollRow(): number | null'))
    // The miss path uses the stale reading, NOT the exact paneScrollState.
    expect(cached).toMatch(/this\.paneStateCache = this\.paneScrollStateStale\(\)/)
    expect(cached).not.toMatch(/this\.paneStateCache = this\.paneScrollState\(\)/)
  })

  it('anchors still take the EXACT read (scrollAnchor → paneScrollState, no stale)', () => {
    const pty = readFileSync(join(__dirname, '../src/main/pty.ts'), 'utf8')
    const fn = pty.slice(pty.indexOf('scrollAnchor(): number | null'))
    const body = fn.slice(0, fn.indexOf('}'))
    expect(body).toMatch(/paneScrollState\(\)/)
    expect(body).not.toMatch(/Stale|Cached/)
  })
})
