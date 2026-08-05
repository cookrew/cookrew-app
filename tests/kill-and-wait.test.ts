import { describe, expect, it } from 'vitest'
import { waitForTmuxDeath } from '../src/main/pty'

// H5: killAndWait used to resolve normally when the tmux session survived
// the deadline — restore then rebound + respawned onto the surviving
// session (new-session -A reattaches and ignores the boot command), leaving
// the node pointing at a session id no process was running. The wait must
// THROW so callers fail loudly. `exists` is injected — no real tmux needed.

describe('waitForTmuxDeath', () => {
  it('resolves as soon as the session is gone', async () => {
    let checks = 0
    await waitForTmuxDeath('cookrew_t1', 1000, () => {
      checks += 1
      return checks < 2 // dies on the second poll
    })
    expect(checks).toBe(2)
  })

  it('THROWS when the session survives the deadline (fake has-session that never dies)', async () => {
    await expect(waitForTmuxDeath('cookrew_t1', 250, () => true)).rejects.toThrow(
      /survived the 250ms kill deadline/
    )
  })

  it('resolves immediately when the session is already dead', async () => {
    await expect(waitForTmuxDeath('cookrew_t1', 5000, () => false)).resolves.toBeUndefined()
  })
})
