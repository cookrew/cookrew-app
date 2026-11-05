import { describe, expect, it } from 'vitest'
import { endPane, type PaneEndDeps } from '../src/main/pane-end'

// H5: killAndWait used to resolve normally when the tmux session survived
// the deadline. Restore then rebound + respawned onto the surviving session
// (new-session -A reattaches and ignores the boot command), leaving the node
// pointing at a session id no process was running. The wait must report the
// survivor so killAndWait throws and callers fail loudly. No real tmux needed.

const deps = (exists: () => boolean): PaneEndDeps => ({
  pid: () => 7,
  close: () => undefined,
  exists,
  alive: () => false,
  signal: () => undefined
})

describe('endPane as the H5 guard', () => {
  it('resolves as soon as the session is gone', async () => {
    let checks = 0
    const result = await endPane(
      deps(() => {
        checks += 1
        return checks < 2 // dies on the second poll
      }),
      1000
    )
    expect(result.ended).toBe(true)
    expect(checks).toBe(2)
  })

  it('reports the survivor when the session outlives the deadline (fake has-session that never dies)', async () => {
    const result = await endPane(deps(() => true), 250)
    expect(result.ended).toBe(false)
  })

  it('resolves immediately when the session is already dead', async () => {
    await expect(endPane(deps(() => false), 5000)).resolves.toMatchObject({ ended: true })
  })
})
