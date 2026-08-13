import { describe, expect, it } from 'vitest'
import type { TerminalNodeData } from '../src/shared/model'
import { moveTerminalCwd, type TerminalCwdDeps } from '../src/main/terminal-cwd'

const NODE: TerminalNodeData = {
  kind: 'terminal',
  id: 'term-1',
  name: 'Magpie',
  preset: 'claude',
  command: 'claude',
  cwd: '/repo/a',
  orch: false,
  role: null,
  claudeSessionId: 'sess-a',
  position: { x: 0, y: 0 },
  size: { width: 600, height: 400 }
}

interface Harness {
  deps: TerminalCwdDeps
  log: string[]
  dirs: string[]
  node: TerminalNodeData
}

function harness(
  options: {
    dirs?: string[]
    exists?: string[]
    node?: TerminalNodeData
    carried?: boolean
    /** The session refuses to die — killAndWait throws (H5). */
    undead?: boolean
  } = {}
): Harness {
  const log: string[] = []
  const state = {
    dirs: options.dirs ?? ['/repo/a'],
    node: options.node ?? NODE
  }
  const exists = new Set(options.exists ?? ['/repo/a', '/repo/b'])
  const deps: TerminalCwdDeps = {
    store: {
      activeId: 'ws-1',
      node: (id) => (id === state.node.id ? state.node : undefined),
      dirs: () => state.dirs,
      addWorkspaceDir: (workspaceId, dir) => {
        log.push(`addDir(${workspaceId},${dir})`)
        state.dirs = [...state.dirs, dir]
      },
      setTerminalCwd: (nodeId, dir) => {
        log.push(`setCwd(${nodeId},${dir})`)
        state.node = { ...state.node, cwd: dir }
        return state.node
      }
    },
    release: (id) => log.push(`release(${id})`),
    kill: async (id) => {
      log.push(`kill(${id})`)
      if (options.undead) throw new Error(`session '${id}' survived the kill deadline`)
    },
    spawn: (node) => log.push(`spawn(${node.id}@${node.cwd})`),
    carry: (move) => {
      log.push(`carry(${move.fromCwd}->${move.toCwd})`)
      return options.carried === false
        ? { kind: 'unavailable' }
        : { kind: 'carried', sessionRef: 'sess-a' }
    },
    dirExists: (dir) => exists.has(dir)
  }
  return {
    deps,
    log,
    get dirs() {
      return state.dirs
    },
    get node() {
      return state.node
    }
  }
}

describe('moveTerminalCwd — enrolling a browsed directory', () => {
  it('adds a directory the workspace does not have yet, then repoints', async () => {
    // The browse escape hatch used to fail outright: setTerminalCwd rejects
    // any dir that is not already a member of the workspace.
    const h = harness()
    await moveTerminalCwd(h.deps, 'term-1', '/repo/b')

    expect(h.log).toContain('addDir(ws-1,/repo/b)')
    expect(h.log.indexOf('addDir(ws-1,/repo/b)')).toBeLessThan(h.log.indexOf('setCwd(term-1,/repo/b)'))
    expect(h.dirs).toEqual(['/repo/a', '/repo/b'])
  })

  it('does not re-add a directory the workspace already holds', async () => {
    const h = harness({ dirs: ['/repo/a', '/repo/b'] })
    await moveTerminalCwd(h.deps, 'term-1', '/repo/b')
    expect(h.log.some((entry) => entry.startsWith('addDir'))).toBe(false)
  })

  it('refuses a path that is not a directory, before anything is torn down', async () => {
    const h = harness({ exists: ['/repo/a'] })
    await expect(moveTerminalCwd(h.deps, 'term-1', '/repo/gone')).rejects.toThrow(/not a directory/i)
    expect(h.log).toEqual([])
    expect(h.dirs).toEqual(['/repo/a'])
  })

  it('trims the path and refuses an empty one', async () => {
    const h = harness()
    await moveTerminalCwd(h.deps, 'term-1', '  /repo/b  ')
    expect(h.log).toContain('setCwd(term-1,/repo/b)')
    await expect(moveTerminalCwd(h.deps, 'term-1', '   ')).rejects.toThrow(/must not be empty/i)
  })

  it('rejects a node that is not a terminal', async () => {
    const h = harness()
    await expect(moveTerminalCwd(h.deps, 'nope', '/repo/b')).rejects.toThrow(/not a terminal/i)
  })
})

describe('moveTerminalCwd — the respawn keeps the conversation', () => {
  it('kills the old process, carries the session across, THEN spawns', async () => {
    // Order is the whole contract: carrying while the agent still holds its
    // session file races the writer, and spawning before the carry boots the
    // agent into an empty conversation in the new directory.
    const h = harness()
    await moveTerminalCwd(h.deps, 'term-1', '/repo/b')

    expect(h.log).toEqual([
      'addDir(ws-1,/repo/b)',
      'setCwd(term-1,/repo/b)',
      'release(term-1)',
      'kill(term-1)',
      'carry(/repo/a->/repo/b)',
      'spawn(term-1@/repo/b)'
    ])
  })

  it('spawns the node at its NEW directory', async () => {
    const h = harness()
    const moved = await moveTerminalCwd(h.deps, 'term-1', '/repo/b')
    expect(moved.cwd).toBe('/repo/b')
    expect(h.log).toContain('spawn(term-1@/repo/b)')
  })

  it('still respawns when the session could not be carried', async () => {
    // A conversation we cannot find must not strand the card: the agent boots
    // in the new directory, exactly as it did before this existed.
    const h = harness({ carried: false })
    const moved = await moveTerminalCwd(h.deps, 'term-1', '/repo/b')
    expect(moved.cwd).toBe('/repo/b')
    expect(h.log).toContain('spawn(term-1@/repo/b)')
  })

  it('puts the card back when the old session refuses to die', async () => {
    // H5: a survivor would be REATTACHED by the respawn — still in the old
    // directory, still the old conversation — and the move would report
    // success. So no carry, no spawn at the new dir: reattach where the
    // agent actually is and let the failure surface.
    const h = harness({ undead: true })
    await expect(moveTerminalCwd(h.deps, 'term-1', '/repo/b')).rejects.toThrow(/survived/i)

    expect(h.node.cwd).toBe('/repo/a')
    expect(h.log).toContain('spawn(term-1@/repo/a)')
    expect(h.log.some((entry) => entry.startsWith('carry'))).toBe(false)
  })

  it('does nothing at all when the directory is unchanged', async () => {
    // No kill, so no respawn — moving a card onto its own directory must not
    // cost the agent its running turn.
    const h = harness()
    const same = await moveTerminalCwd(h.deps, 'term-1', '/repo/a')
    expect(same).toBe(h.node)
    expect(h.log).toEqual([])
  })
})
