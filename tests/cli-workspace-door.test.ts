// `cookrew workspace create` and `remove` (box user test 2, bugs 5 and 11): the
// CLI refuses in the same sentence as the sheet, and says what a remove stopped
// and left.
import { describe, expect, it, vi } from 'vitest'
import { cmdWorkspace, type SocketServerDeps } from '../src/main/socket-server'
import type { CliRequest } from '../src/shared/model'
import type { WorkspaceCheck, WorkspaceRemovePlan } from '../src/shared/workspace-door'

const request = (args: string[], flags: Record<string, string | boolean> = {}): CliRequest =>
  ({ id: 'r', cmd: 'workspace', args, flags, terminalId: 'orch' })

const orch = { kind: 'terminal', id: 'orch', name: 'Conductor', orch: true }
const passed: WorkspaceCheck = { ok: true, name: 'Beta', dir: '/p', notes: [], suggestedDir: '/home/me' }
const plan: WorkspaceRemovePlan = {
  id: 'w', name: 'Alpha', stops: ['Shell', 'Conductor'], notes: 1, browsers: 0, keeps: ['/p'],
  forks: [{ worktree: '/wt', branch: 'cookrew/alpha', removable: false, reason: 'The worktree has uncommitted changes, so it stays.' }]
}

const deps = (over: Partial<SocketServerDeps> = {}): SocketServerDeps =>
  ({
    store: { node: () => orch, nodeAcrossWorkspaces: () => ({ node: orch, workspaceId: 'w' }) },
    checkWorkspace: () => passed,
    createWorkspace: vi.fn(() => ({ id: 'w', name: 'Beta', dir: '/p' })),
    workspaceRemovePlan: vi.fn(async () => plan),
    removeWorkspace: vi.fn(async () => ({ workspaces: [], activeId: '' })),
    isServed: () => false,
    ...over
  }) as unknown as SocketServerDeps

describe('cookrew workspace create', () => {
  it('refuses a bad folder in the check\'s sentence and makes nothing', async () => {
    const createWorkspace = vi.fn()
    const refused = deps({
      createWorkspace,
      checkWorkspace: () => ({ ...passed, ok: false, reason: 'There is no folder at /nope. Choose one that exists.' })
    })
    await expect(cmdWorkspace(request(['create', 'Ghost'], { dir: '/nope' }), refused)).rejects.toThrow(
      'There is no folder at /nope. Choose one that exists.'
    )
    expect(createWorkspace).not.toHaveBeenCalled()
  })

  it('says what the sheet would have said first', async () => {
    const noted = deps({ checkWorkspace: () => ({ ...passed, notes: ['"Alpha" already works in this folder, so their agents will share its files.'] }) })
    const said = await cmdWorkspace(request(['create', 'Beta'], { dir: '/p' }), noted)
    expect(said).toContain('Created and switched to workspace "Beta" (/p)')
    expect(said).toContain('"Alpha" already works in this folder')
  })
})

describe('cookrew workspace remove', () => {
  it('says what stopped, what went and what stayed', async () => {
    const said = await cmdWorkspace(request(['remove', 'Alpha']), deps())
    expect(said).toContain('Removed workspace "Alpha".')
    expect(said).toContain('Stopped 2 agents: Shell and Conductor.')
    expect(said).toContain('Deleted 1 note.')
    expect(said).toContain('Left /p on disk.')
    expect(said).toContain('Left worktree /wt and branch cookrew/alpha. The worktree has uncommitted changes, so it stays.')
  })

  it('passes --remove-worktree through', async () => {
    const removeWorkspace = vi.fn(async () => ({ workspaces: [], activeId: '' }))
    const clean = { ...plan, forks: [{ worktree: '/wt', branch: 'cookrew/alpha', removable: true }] }
    const said = await cmdWorkspace(
      request(['remove', 'Alpha'], { 'remove-worktree': true }),
      deps({ removeWorkspace, workspaceRemovePlan: async () => clean } as unknown as Partial<SocketServerDeps>)
    )
    expect(removeWorkspace).toHaveBeenCalledWith('Alpha', { worktree: true })
    expect(said).toContain('Removed worktree /wt and branch cookrew/alpha.')
  })
})
