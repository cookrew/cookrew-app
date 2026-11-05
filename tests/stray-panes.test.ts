import { describe, expect, it, vi } from 'vitest'
import { planOrphanReap, reapOrphansOn, strayPanes, type SpawnRecord } from '../src/main/orphan-reap'
import { sessionNameFor } from '../src/main/pty'

// A pane that lost its card can be reached by nothing on screen. The boot sweep
// may close one only with proof it belongs to this store, and the rest are
// shown rather than left to run unseen (box test 2, bug 1).

const ID = (n: number): string => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`
const name = (n: number): string => sessionNameFor(ID(n))
const record = (n: number, over: Partial<SpawnRecord> = {}): SpawnRecord => ({
  id: ID(n),
  name: `Agent ${n}`,
  cwd: `/work/${n}`,
  workspaceName: 'Alpha',
  ...over
})

describe('strayPanes', () => {
  it('lists a live pane with no card, and names it from the spawn record', () => {
    expect(strayPanes([name(1), name(2)], [ID(1)], [record(2)])).toEqual([
      { session: name(2), terminalId: ID(2), name: 'Agent 2', cwd: '/work/2', workspaceName: 'Alpha', proved: true }
    ])
  })

  it('a pane no record names is still listed, and is not proved', () => {
    expect(strayPanes([name(1), name(9)], [ID(1)], [])).toEqual([
      { session: name(9), terminalId: null, name: null, cwd: null, workspaceName: null, proved: false }
    ])
  })

  it('a card keeps its pane off the list, record or not', () => {
    expect(strayPanes([name(1)], [ID(1)], [record(1)])).toEqual([])
  })

  it('never lists a session that is not named as ours', () => {
    expect(strayPanes(['my-editor', 'cookrewX-not-ours'], [ID(1)], [record(1)])).toEqual([])
  })
})

describe('planOrphanReap needs proof', () => {
  const proved = (ids: number[]) => new Set(ids.map(name))

  it('closes a proved orphan', () => {
    const plan = planOrphanReap([name(1), name(2)], [ID(1)], proved([2]))
    expect(plan.close).toEqual([name(2)])
    expect(plan.reason).toBeNull()
  })

  it('never closes an orphan it cannot prove, however familiar the store', () => {
    const plan = planOrphanReap([name(1), name(2)], [ID(1)], proved([]))
    expect(plan.close).toEqual([])
    expect(plan.held).toBe(1)
    expect(plan.reason).toMatch(/could not be proved/)
  })

  it('a mix closes only the proved ones and says what it left', () => {
    const plan = planOrphanReap([name(1), name(2), name(3)], [ID(1)], proved([3]))
    expect(plan.close).toEqual([name(3)])
    expect(plan.held).toBe(1)
    expect(plan.reason).toMatch(/could not be proved/)
  })

  it('proof does not lift the familiar-store guard: an empty store closes nothing', () => {
    const plan = planOrphanReap([name(1), name(2)], [], proved([1, 2]))
    expect(plan.close).toEqual([])
    expect(plan.reason).toMatch(/none of the 2/)
  })

  it('proof does not lift the per-boot cap', () => {
    const many = [2, 3, 4, 5, 6, 7]
    const plan = planOrphanReap([name(1), ...many.map(name)], [ID(1)], proved(many))
    expect(plan.close).toEqual([])
    expect(plan.reason).toMatch(/cap/)
  })
})

describe('reapOrphansOn', () => {
  it('closes only what is proved', () => {
    const killSession = vi.fn()
    const closed = reapOrphansOn({ listSessions: () => [name(1), name(2), name(3)], killSession }, [ID(1)], {
      claimHeld: true,
      proved: new Set([name(2)]),
      log: () => undefined
    })
    expect(closed).toEqual([name(2)])
    expect(killSession.mock.calls).toEqual([[name(2)]])
  })
})
