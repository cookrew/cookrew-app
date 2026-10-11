/**
 * THE NOTE A MISSING SECRET LANDS ON.
 *
 * `cookrew secret read <name>` for a name nobody sealed leaves a
 * `secret.requested` row, and the inbox turns that row into "Tinker needs
 * <name>" with a click that opens the slot (Fresco's lane). That click
 * needs a slot to open: a note on the asking card's canvas with the line
 * `🔒 <name>`. When no note carries it yet, this makes one — ONCE per name:
 * a note called "Secrets" beside the asking card, connected to it, or one
 * more slot line appended to the "Secrets" note that already exists there.
 * The audit row then names that note (`<name> note:<id>`,
 * secret-cli.ts · secretAuditDetails), so the row lands on a real field.
 *
 * Pure over the store's five calls, so a real WorkspaceStore in a temp dir
 * can prove it (tests/secret-note.test.ts).
 */

import type { CanvasNode, NoteNodeData, TerminalNodeData } from '../shared/model'
import { DEFAULT_NOTE_SIZE } from '../shared/model'
import { secretSlotLine, secretSlotOf } from '../shared/secret-slot'

export const SECRETS_NOTE_NAME = 'Secrets'

/** What the note says above its first slot: the owner reads this once. */
export const SECRETS_NOTE_HEAD =
  '# Secrets\n\nSlots the crew asked for. Seal each value in the zoom view; the note keeps only the name.\n'

export interface SecretNoteStore {
  nodesOf: (workspaceId: string) => readonly CanvasNode[]
  createNote: (partial: Omit<NoteNodeData, 'kind' | 'id' | 'name'>, workspaceId: string) => NoteNodeData
  writeNote: (id: string, content: string) => NoteNodeData | undefined
  connect: (fromId: string, toId: string) => void
}

export interface SecretNoteOutcome {
  readonly noteId: string
  /** 'note' = a Secrets note was made; 'line' = a line was added to one; 'none' = a note already had the slot. */
  readonly made: 'note' | 'line' | 'none'
}

const carriesSlot = (note: NoteNodeData, name: string): boolean =>
  note.content.split('\n').some((line) => secretSlotOf(line) === name)

const isSecretsNote = (note: NoteNodeData): boolean =>
  (note.customName ?? note.name).trim().toLowerCase() === SECRETS_NOTE_NAME.toLowerCase()

/**
 * Make sure a note on `workspaceId` carries the slot line for `name`, beside
 * the asking terminal. Idempotent: a second request for the same name finds
 * the first note and changes nothing.
 */
export const ensureSecretSlotNote = (
  store: SecretNoteStore,
  input: { workspaceId: string; asker: TerminalNodeData | null; name: string }
): SecretNoteOutcome => {
  const notes = store.nodesOf(input.workspaceId).filter((node): node is NoteNodeData => node.kind === 'note')
  const holder = notes.find((note) => carriesSlot(note, input.name))
  if (holder) return { noteId: holder.id, made: 'none' }
  const line = secretSlotLine(input.name)
  const existing = notes.find((note) => isSecretsNote(note) && !note.locked)
  if (existing) {
    const body = existing.content.endsWith('\n') || existing.content.length === 0 ? existing.content : `${existing.content}\n`
    store.writeNote(existing.id, `${body}${line}\n`)
    return { noteId: existing.id, made: 'line' }
  }
  const beside = input.asker?.position ?? { x: 0, y: 0 }
  const note = store.createNote(
    {
      customName: SECRETS_NOTE_NAME,
      content: `${SECRETS_NOTE_HEAD}\n${line}\n`,
      locked: false,
      position: { x: beside.x - DEFAULT_NOTE_SIZE.width - 60, y: beside.y },
      size: DEFAULT_NOTE_SIZE
    },
    input.workspaceId
  )
  if (input.asker) store.connect(input.asker.id, note.id)
  return { noteId: note.id, made: 'note' }
}
