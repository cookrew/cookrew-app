// A MISSING SECRET GETS A SLOT TO LAND ON — once per name, beside the card
// that asked, on a real WorkspaceStore.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { WorkspaceStore } from '../src/main/store'
import { ensureSecretSlotNote, SECRETS_NOTE_NAME, type SecretNoteStore } from '../src/main/secret-note'
import { cmdSecret, secretAuditDetails, type SecretAudit } from '../src/main/secret-cli'
import { createSecretsStore } from '../src/main/secrets-store'
import type { CliRequest, NoteNodeData, TerminalNodeData } from '../src/shared/model'

const setup = () => {
  const store = new WorkspaceStore(path.join(mkdtempSync(path.join(tmpdir(), 'cookrew-secret-note-')), 'data'))
  const home = store.focusedId
  const other = store.createWorkspace('Playground', '/tmp').id
  const asker = store.addNode({
    kind: 'terminal', id: 't-tinker', name: 'Tinker', preset: 'claude', command: 'claude', cwd: '/', orch: false, role: null,
    position: { x: 900, y: 300 }, size: { width: 560, height: 360 }
  } as unknown as TerminalNodeData) as TerminalNodeData
  const bridge: SecretNoteStore = {
    nodesOf: (id) => store.workspaceState(id).nodes,
    createNote: (partial, id) => store.createNote(partial, id),
    writeNote: (id, content) => store.writeNote(id, content),
    connect: (from, to) => void store.connectAcross(from, to)
  }
  const notes = (ws = home) => store.workspaceState(ws).nodes.filter((n): n is NoteNodeData => n.kind === 'note')
  return { store, home, other, asker, bridge, notes }
}

describe('ensureSecretSlotNote', () => {
  it('makes a "Secrets" note beside the asking card, connected to it, with the slot line', () => {
    const { store, home, asker, bridge, notes } = setup()
    const made = ensureSecretSlotNote(bridge, { workspaceId: home, asker, name: 'stripe-key' })
    expect(made.made).toBe('note')
    const note = notes().find((n) => n.id === made.noteId)!
    expect(note.customName).toBe(SECRETS_NOTE_NAME)
    expect(note.content).toContain('# Secrets')
    expect(note.content.endsWith('🔒 stripe-key\n')).toBe(true)
    expect(note.position).toEqual({ x: 900 - 280 - 60, y: 300 })
    expect(store.connectedTo(asker.id).some((n) => n.id === note.id)).toBe(true)
  })

  it('is once per name: a second request finds the note and changes nothing', () => {
    const { home, asker, bridge, notes } = setup()
    const first = ensureSecretSlotNote(bridge, { workspaceId: home, asker, name: 'stripe-key' })
    const again = ensureSecretSlotNote(bridge, { workspaceId: home, asker, name: 'stripe-key' })
    expect(again).toEqual({ noteId: first.noteId, made: 'none' })
    expect(notes()).toHaveLength(1)
    expect(notes()[0].content.split('🔒 stripe-key')).toHaveLength(2)
  })

  it('a second NAME is one more line on the same Secrets note', () => {
    const { home, asker, bridge, notes } = setup()
    const first = ensureSecretSlotNote(bridge, { workspaceId: home, asker, name: 'stripe-key' })
    const second = ensureSecretSlotNote(bridge, { workspaceId: home, asker, name: 'openai-key' })
    expect(second).toEqual({ noteId: first.noteId, made: 'line' })
    expect(notes()).toHaveLength(1)
    expect(notes()[0].content.endsWith('🔒 stripe-key\n🔒 openai-key\n')).toBe(true)
  })

  it('a note the owner already keeps the slot in is left alone, whatever it is called', () => {
    const { store, home, asker, bridge, notes } = setup()
    const own = store.createNote({ customName: 'Stripe keys', content: '# Stripe keys\n\n🔒 stripe-key\n', locked: false, position: { x: 0, y: 0 }, size: { width: 280, height: 220 } }, home)
    expect(ensureSecretSlotNote(bridge, { workspaceId: home, asker, name: 'stripe-key' })).toEqual({ noteId: own.id, made: 'none' })
    expect(notes()).toHaveLength(1)
  })

  it('a LOCKED Secrets note is not written; a fresh one is made', () => {
    const { store, home, asker, bridge, notes } = setup()
    store.createNote({ customName: 'Secrets', content: '# Secrets\n', locked: true, position: { x: 0, y: 0 }, size: { width: 280, height: 220 } }, home)
    const made = ensureSecretSlotNote(bridge, { workspaceId: home, asker, name: 'stripe-key' })
    expect(made.made).toBe('note')
    expect(notes()).toHaveLength(2)
  })

  it('lands on the ASKER\'S canvas, not the one on screen', () => {
    const { store, home, other, asker, bridge, notes } = setup()
    store.switchWorkspace(other)
    ensureSecretSlotNote(bridge, { workspaceId: home, asker, name: 'stripe-key' })
    expect(notes(home)).toHaveLength(1)
    expect(notes(other)).toHaveLength(0)
  })

  it('end to end: a refused read makes the note, and the audit row names it', () => {
    const { store, home, asker, bridge } = setup()
    const secrets = createSecretsStore({ baseDir: mkdtempSync(path.join(tmpdir(), 'cookrew-secret-note-store-')) })
    const audits: SecretAudit[] = []
    const audit = (event: SecretAudit): void => {
      if (event.type === 'secret.requested') ensureSecretSlotNote(bridge, { workspaceId: home, asker, name: event.name })
      audits.push(event)
    }
    expect(() =>
      cmdSecret({ id: 'r', cmd: 'secret', args: ['read', 'stripe-key'], flags: {}, terminalId: asker.id } as unknown as CliRequest, { secrets, self: () => asker, audit })
    ).toThrow(/no secret stripe-key/)
    const details = secretAuditDetails(audits[0].name, store.workspaceState(home).nodes.flatMap((n) => (n.kind === 'note' ? [n] : [])))
    const note = store.workspaceState(home).nodes.find((n) => n.kind === 'note')!
    expect(details).toBe(`stripe-key note:${note.id}`)
  })
})
