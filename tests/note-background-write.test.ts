// F13 (Menu QA, 2026-11-04): a note of a workspace the owner is not looking at
// dropped every write and said OK. Any agent writing a note while the owner is
// elsewhere lost its words.
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceStore } from '../src/main/store'

describe('a note in a background workspace', () => {
  const cleanup: Array<() => void> = []
  afterEach(() => {
    for (const run of cleanup.splice(0)) run()
  })
  const start = (): { store: WorkspaceStore; noteId: string; dir: string; home: string; other: string } => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cookrew-note-bg-'))
    const store = new WorkspaceStore(dir)
    // The store writes behind the test: flushed first, or a late file makes the delete ENOTEMPTY.
    cleanup.push(() => {
      store.flush()
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    })
    const home = store.list().activeId
    const note = store.createNote({ content: 'first words', x: 0, y: 0, width: 200, height: 200 } as never, home)
    const other = store.createWorkspace('Elsewhere', dir)
    store.switchWorkspace(other.id)
    expect(store.list().activeId).toBe(other.id)
    return { store, noteId: note.id, dir, home, other: other.id }
  }
  it('takes the write, and says what it now holds', () => {
    const { store, noteId } = start()
    const written = store.writeNote(noteId, 'second words')
    expect(written?.content).toBe('second words')
    const read = store.nodeAcrossWorkspaces(noteId)?.node
    expect(read?.kind === 'note' && read.content).toBe('second words')
  })
  it('its .md mirror lands in its own workspace, not the one on screen', async () => {
    const { store, noteId, dir, home, other } = start()
    store.writeNote(noteId, 'second words')
    const notes = (id: string): string => path.join(dir, 'workspaces', id, 'notes')
    await vi.waitFor(() => {
      const own = readdirSync(notes(home)).map((f) => readFileSync(path.join(notes(home), f), 'utf8'))
      expect(own.join('')).toContain('second words')
    })
    expect(existsSync(notes(other)) ? readdirSync(notes(other)) : []).toEqual([])
  })
  it('an id that is no note anywhere is still refused', () => {
    const { store } = start()
    expect(store.writeNote('no-such-note', 'x')).toBeUndefined()
  })
})
