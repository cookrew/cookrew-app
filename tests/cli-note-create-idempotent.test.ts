import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { cmdNote } from '../src/main/socket-server'
import type { SocketServerDeps } from '../src/main/socket-server'
import { WorkspaceStore } from '../src/main/store'
import type { CliRequest, NoteNodeData, TerminalNodeData } from '../src/shared/model'

/**
 * A NOTE WITH THE SAME NAME IS THE SAME NOTE.
 *
 * `browser create` already adopts a card whose name exists on the caller's
 * canvas (cli-idempotent-create.test.ts). `note create` never got the same
 * rule: a second agent writing "# The report" next to the first agent's note
 * of the same name minted "the-report (2)". Owner ruling 2026-10-11: two
 * agents opening the same thing twice is a product defect. Pinned here: a
 * note whose first line names a note already on the caller's workspace canvas
 * wires the caller to that note and leaves its content alone; --new forces a
 * second card; a bare `note create` with no content is unchanged.
 */

function terminal(id: string, name: string): TerminalNodeData {
  return {
    kind: 'terminal', id, name, preset: 'Claude Code', command: 'claude', cwd: '/tmp',
    orch: false, role: null, position: { x: 10, y: 20 }, size: { width: 640, height: 420 }
  }
}

function request(args: string[], terminalId: string, flags: Record<string, unknown> = {}): CliRequest {
  return { id: 'r1', cmd: 'note', args, flags, terminalId } as CliRequest
}

const ORIGINAL = '# The report\nVelvet wrote this.'

interface Fixture {
  store: WorkspaceStore
  deps: SocketServerDeps
  home: string
  other: string
  report: NoteNodeData
}

function setup(): Fixture {
  const store = new WorkspaceStore(path.join(mkdtempSync(path.join(tmpdir(), 'cookrew-note-idem-')), 'data'))
  const home = store.focusedId
  const other = store.createWorkspace('Playground', '/tmp').id
  store.addNode(terminal('atlas', 'Atlas'), home)
  store.addNode(terminal('velvet', 'Velvet'), home)
  const deps = { store, listWorkspaces: () => store.list(), isServed: () => false } as unknown as SocketServerDeps
  cmdNote(request(['create', ORIGINAL], 'velvet'), deps)
  const report = notesIn(store, home)[0]!
  return { store, deps, home, other, report }
}

function notesIn(store: WorkspaceStore, ws: string): NoteNodeData[] {
  return store.workspaceState(ws).nodes.filter((n): n is NoteNodeData => n.kind === 'note')
}

function wired(store: WorkspaceStore, ws: string, a: string, b: string): boolean {
  return store
    .workspaceState(ws)
    .connections.some((c) => (c.a === a && c.b === b) || (c.a === b && c.b === a))
}

describe('cookrew note create — a note whose name exists is the same note', () => {
  it('wires the caller to the existing note instead of minting "(2)"', () => {
    const { store, deps, home, report } = setup()
    expect(report.name).toBe('The report')
    const answer = cmdNote(request(['create', '# The report\nAtlas wrote this.'], 'atlas'), deps)
    expect(notesIn(store, home)).toHaveLength(1)
    expect(notesIn(store, home).some((n) => n.name.endsWith('(2)'))).toBe(false)
    expect(wired(store, home, 'atlas', report.id)).toBe(true)
    expect(answer).toContain('already exists')
    expect(answer).toContain('wired to Velvet')
    expect(answer).toContain('now wired to you too')
  })

  it('leaves the content untouched, says so, and points to note write', () => {
    const { store, deps, home, report } = setup()
    const answer = cmdNote(request(['create', '# The report\nAtlas wrote this.'], 'atlas'), deps)
    expect(notesIn(store, home)[0]!.content).toBe(ORIGINAL)
    expect(answer).toMatch(/content.*(untouched|unchanged)/i)
    expect(answer).toContain(`cookrew note write "${report.name}"`)
    expect(answer).toContain('--new')
  })

  it('matches the name regardless of case and markdown on the first line', () => {
    const { store, deps, home, report } = setup()
    cmdNote(request(['create', '## THE REPORT'], 'atlas'), deps)
    expect(notesIn(store, home)).toHaveLength(1)
    expect(wired(store, home, 'atlas', report.id)).toBe(true)
  })

  it('adopts a note the owner renamed when the first line is its name', () => {
    const { store, deps, home, report } = setup()
    store.updateNode(report.id, { name: 'Release Plan', customName: 'Release Plan' })
    const answer = cmdNote(request(['create', '# Release plan\ndraft'], 'atlas'), deps)
    expect(notesIn(store, home)).toHaveLength(1)
    expect(answer).toContain('"Release Plan" already exists')
  })

  it('says so without re-wiring when the caller is already wired to it', () => {
    const { store, deps, home } = setup()
    const before = store.workspaceState(home).connections.length
    const answer = cmdNote(request(['create', ORIGINAL], 'velvet'), deps)
    expect(answer).toContain('already wired to you')
    expect(answer).not.toContain('now wired to you too')
    expect(store.workspaceState(home).connections).toHaveLength(before)
    expect(notesIn(store, home)).toHaveLength(1)
  })

  it('--new still creates a second card', () => {
    const { store, deps, home } = setup()
    const answer = cmdNote(request(['create', ORIGINAL], 'atlas', { new: true }), deps)
    expect(answer).toBe('Created note "The report (2)"')
    expect(notesIn(store, home)).toHaveLength(2)
  })

  it('a bare note create with no content keeps minting a new card', () => {
    const { store, deps, home } = setup()
    expect(cmdNote(request(['create'], 'atlas'), deps)).toBe('Created note "untitled"')
    expect(cmdNote(request(['create'], 'atlas'), deps)).toBe('Created note "untitled (2)"')
    expect(notesIn(store, home)).toHaveLength(3)
  })

  it('a name nobody holds is created as before', () => {
    const { store, deps, home } = setup()
    expect(cmdNote(request(['create', '# Another thing'], 'atlas'), deps)).toBe('Created note "Another thing"')
    expect(notesIn(store, home)).toHaveLength(2)
  })

  it('looks on the CALLER’S canvas while the owner is looking elsewhere', () => {
    const { store, deps, home, other, report } = setup()
    store.switchWorkspace(other)
    const answer = cmdNote(request(['create', '# The report'], 'atlas'), deps)
    expect(answer).toContain('already exists')
    expect(notesIn(store, home)).toHaveLength(1)
    expect(notesIn(store, other)).toHaveLength(0)
    expect(wired(store, home, 'atlas', report.id)).toBe(true)
  })

  it('a same-named note on another workspace is not adopted', () => {
    const { store, deps, home, other } = setup()
    store.switchWorkspace(other)
    store.addNode(terminal('fresco', 'Fresco'), other)
    const answer = cmdNote(request(['create', '# The report'], 'fresco'), deps)
    expect(answer).toBe('Created note "The report"')
    expect(notesIn(store, other)).toHaveLength(1)
    expect(notesIn(store, home)).toHaveLength(1)
  })
})
