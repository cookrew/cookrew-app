import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { cmdNote } from '../src/main/socket-server'
import type { SocketServerDeps } from '../src/main/socket-server'
import { WorkspaceStore } from '../src/main/store'
import type { CliRequest, NoteNodeData, TerminalNodeData } from '../src/shared/model'

/**
 * A NOTE WRITE THAT HAS NOTHING TO WRITE WRITES NOTHING.
 *
 * `cookrew note write "Name" --file /tmp/x.txt` reached the app as the name
 * and a `file` flag — no content argument — and the handler wrote `''` over
 * the whole note and answered OK. A note is named from its first line, so the
 * emptied note was renamed "untitled (2)" and vanished from `cookrew list`
 * (2026-08-20: a 107-line note). The client puts `--key [value]` in
 * request.flags and every other token in request.args, so both shapes are
 * pinned: an unknown flag, and a flag-looking token left in the args. An
 * explicit "" still clears a note, and a write that renames says so.
 */

function terminal(id: string, name: string): TerminalNodeData {
  return {
    kind: 'terminal', id, name, preset: 'Claude Code', command: 'claude', cwd: '/tmp',
    orch: false, role: null, position: { x: 10, y: 20 }, size: { width: 640, height: 420 }
  }
}

function request(
  args: string[],
  flags: Record<string, unknown> = {},
  terminalId: string | undefined = 'atlas'
): CliRequest {
  return { id: 'r1', cmd: 'note', args, flags, terminalId } as CliRequest
}

const PLAN = '# plan\n' + Array.from({ length: 106 }, (_, i) => `line ${i + 2}`).join('\n')

function setup(): { store: WorkspaceStore; deps: SocketServerDeps; note: NoteNodeData } {
  const store = new WorkspaceStore(path.join(mkdtempSync(path.join(tmpdir(), 'cookrew-note-write-')), 'data'))
  store.addNode(terminal('atlas', 'Atlas'))
  const note = store.createNote({
    customName: null, content: PLAN, locked: false,
    position: { x: 0, y: 0 }, size: { width: 300, height: 200 }
  })
  store.connect('atlas', note.id)
  const deps = { store, listWorkspaces: () => store.list(), isServed: () => false } as unknown as SocketServerDeps
  return { store, deps, note }
}

function current(store: WorkspaceStore, id: string): NoteNodeData {
  return store.node(id) as NoteNodeData
}

function expectUntouched(store: WorkspaceStore, note: NoteNodeData): void {
  expect(current(store, note.id).content).toBe(PLAN)
  expect(current(store, note.id).name).toBe('plan')
}

describe('cookrew note write — refuses instead of clobbering', () => {
  it('refuses `--file /tmp/x.txt` with no content (the flag swallowed the path)', () => {
    const { store, deps, note } = setup()
    expect(() => cmdNote(request(['write', 'plan'], { file: '/tmp/x.txt' }), deps)).toThrow(/--file/)
    expect(() => cmdNote(request(['write', 'plan'], { file: '/tmp/x.txt' }), deps)).toThrow(/nothing was written/i)
    expectUntouched(store, note)
  })

  it('refuses an unknown flag even when content was given', () => {
    const { store, deps, note } = setup()
    expect(() => cmdNote(request(['write', 'plan', '# plan\nnew'], { file: true }), deps)).toThrow(/--file/)
    expect(() => cmdNote(request(['write', 'plan', '# plan\nnew'], { 'file=/tmp/x.txt': true }), deps)).toThrow(/unknown flag/i)
    expectUntouched(store, note)
  })

  it('refuses a missing content argument', () => {
    const { store, deps, note } = setup()
    expect(() => cmdNote(request(['write', 'plan']), deps)).toThrow(/missing content/i)
    expect(() => cmdNote(request(['write', 'plan']), deps)).toThrow(/Usage: cookrew note write/)
    expectUntouched(store, note)
  })

  it('refuses a missing note name', () => {
    const { store, deps, note } = setup()
    expect(() => cmdNote(request(['write']), deps)).toThrow(/Usage: cookrew note write/)
    expectUntouched(store, note)
  })

  it('refuses a flag-looking token that stayed in the args (-f, --file)', () => {
    const { store, deps, note } = setup()
    expect(() => cmdNote(request(['write', 'plan', '-f']), deps)).toThrow(/looks like a flag/i)
    expect(() => cmdNote(request(['write', 'plan', '--file']), deps)).toThrow(/looks like a flag/i)
    expectUntouched(store, note)
  })

  it('refuses more than one content argument (unquoted content, or -f PATH)', () => {
    const { store, deps, note } = setup()
    expect(() => cmdNote(request(['write', 'plan', '-f', '/tmp/x.txt']), deps)).toThrow(/one content argument/i)
    expect(() => cmdNote(request(['write', 'plan', 'hello', 'world']), deps)).toThrow(/quote/i)
    expectUntouched(store, note)
  })

  it('a refused write lays no cable to an unwired note', () => {
    const { store, deps } = setup()
    const loose = store.createNote({
      customName: null, content: '# loose', locked: false,
      position: { x: 0, y: 0 }, size: { width: 300, height: 200 }
    })
    expect(() => cmdNote(request(['write', 'loose'], { file: '/tmp/x.txt' }), deps)).toThrow()
    expect(store.isConnected('atlas', loose.id)).toBe(false)
    expect(current(store, loose.id).content).toBe('# loose')
  })
})

describe('cookrew note write — what still writes, and what the reply says', () => {
  it('an explicit "" still clears the note, and the reply names the rename', () => {
    const { store, deps, note } = setup()
    const reply = cmdNote(request(['write', 'plan', '']), deps)
    expect(current(store, note.id).content).toBe('')
    expect(current(store, note.id).name).toBe('untitled')
    expect(reply).toMatch(/^OK/)
    expect(reply).toContain('"plan" -> "untitled"')
  })

  it('a write that keeps the first line answers a plain OK', () => {
    const { store, deps, note } = setup()
    const reply = cmdNote(request(['write', 'plan', '# plan\nv2']), deps)
    expect(reply).toBe('OK')
    expect(current(store, note.id).content).toBe('# plan\nv2')
  })

  it('a write that changes the first line says the note was renamed', () => {
    const { store, deps, note } = setup()
    const reply = cmdNote(request(['write', 'plan', '# roadmap\nv2']), deps)
    expect(current(store, note.id).name).toBe('roadmap')
    expect(reply).toMatch(/^OK/)
    expect(reply).toContain('renamed "plan" -> "roadmap"')
  })

  it('a custom-named note keeps its name and answers a plain OK', () => {
    const { store, deps, note } = setup()
    store.updateNode(note.id, { customName: 'Pinned', name: 'Pinned' })
    const reply = cmdNote(request(['write', 'Pinned', '# roadmap']), deps)
    expect(reply).toBe('OK')
    expect(current(store, note.id).name).toBe('Pinned')
  })

  it('markdown that starts with dashes is content, not a flag', () => {
    const { store, deps, note } = setup()
    cmdNote(request(['write', 'plan', '- item one\n- item two']), deps)
    expect(current(store, note.id).content).toBe('- item one\n- item two')
    cmdNote(request(['write', 'item-one', '---']), deps)
    expect(current(store, note.id).content).toBe('---')
  })

  it('--as is the caller, not a stray flag', () => {
    const { store, deps, note } = setup()
    const reply = cmdNote(request(['write', 'plan', '# plan\nfrom a shell'], { as: 'Atlas' }, undefined), deps)
    expect(reply).toBe('OK')
    expect(current(store, note.id).content).toBe('# plan\nfrom a shell')
  })

  it('a locked note is still refused', () => {
    const { store, deps, note } = setup()
    store.updateNode(note.id, { locked: true })
    expect(() => cmdNote(request(['write', 'plan', '# plan\nv2']), deps)).toThrow(/is locked/)
    expectUntouched(store, note)
  })
})
