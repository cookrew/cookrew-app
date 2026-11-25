import { beforeEach, describe, expect, it, vi } from 'vitest'
import { remoteDraft, remotePlace, setRemoteDraft } from '../src/renderer/src/zoom/remote-machine-store'

/**
 * Which other machine this window is inside (owner 2026-11-25: drawn as the
 * console draws it, in a guest of its own), what the guest says of where it
 * stands, and the steps the window's title line sends on to it.
 */

const SOLIS = { id: '0f8c7b1e-1234-4abc-9def-0123456789ab', name: 'Solis-Core', os: 'linux' }

describe('remotePlace', () => {
  beforeEach(() => remotePlace.leave())

  it('enters a machine at its workspaces, or where it was asked, and leaves it', () => {
    expect(remotePlace.get().machine).toBeNull()
    remotePlace.enter(SOLIS)
    expect(remotePlace.get()).toMatchObject({ machine: SOLIS, entry: { workspace: null, agent: null, item: null, side: 'agents' }, crumbs: null })
    remotePlace.enter(SOLIS, { workspace: 'w-1', agent: 't-1' })
    expect(remotePlace.get().entry).toEqual({ workspace: 'w-1', agent: 't-1', item: null, side: 'agents' })
    remotePlace.leave()
    expect(remotePlace.get().machine).toBeNull()
  })

  it('an entry holds together: no agent without its workspace, an artifact opens on the artifacts side', () => {
    remotePlace.enter(SOLIS, { agent: 't-1' })
    expect(remotePlace.get().entry).toEqual({ workspace: null, agent: null, item: null, side: 'agents' })
    remotePlace.enter(SOLIS, { workspace: 'w-1', item: 'b-1' })
    expect(remotePlace.get().entry).toEqual({ workspace: 'w-1', agent: null, item: 'b-1', side: 'items' })
    remotePlace.enter(SOLIS, { workspace: '../w', agent: 't-1' })
    expect(remotePlace.get().entry.workspace).toBeNull()
  })

  it('each entry is a visit of its own: the same machine entered again opens afresh', () => {
    remotePlace.enter(SOLIS)
    const first = remotePlace.get().visit
    remotePlace.enter(SOLIS)
    expect(remotePlace.get().visit).toBeGreaterThan(first)
  })

  it('takes the guest’s names for where it stands; a route said again is no change', () => {
    const heard = vi.fn()
    remotePlace.enter(SOLIS)
    const off = remotePlace.subscribe(heard)
    remotePlace.heard({ kind: 'route', workspace: 'Box Lab', agent: 'Solis Codex' })
    expect(remotePlace.get().crumbs).toEqual({ workspace: 'Box Lab', agent: 'Solis Codex' })
    remotePlace.heard({ kind: 'route', workspace: 'Box Lab', agent: 'Solis Codex' })
    expect(heard).toHaveBeenCalledTimes(1)
    off()
  })

  it('outside every machine, a guest’s word changes nothing', () => {
    remotePlace.heard({ kind: 'route', workspace: 'Box Lab', agent: null })
    expect(remotePlace.get().crumbs).toBeNull()
  })

  it('the guest leaving to the devices is a plain way out; any other reason is kept to be said', () => {
    remotePlace.enter(SOLIS)
    remotePlace.heard({ kind: 'leave', why: 'devices' })
    expect(remotePlace.get()).toMatchObject({ machine: null, left: null })
    remotePlace.enter(SOLIS)
    remotePlace.heard({ kind: 'leave', why: 'key-refused' })
    expect(remotePlace.get()).toMatchObject({ machine: null, left: { machine: SOLIS.id, name: 'Solis-Core', why: 'key-refused' } })
    remotePlace.dismiss()
    expect(remotePlace.get().left).toBeNull()
  })

  it('the title line’s steps go on to the guest, and only while inside a machine', () => {
    const sent = vi.fn()
    const off = remotePlace.onCommand(sent)
    remotePlace.command({ kind: 'back' })
    expect(sent).not.toHaveBeenCalled()
    remotePlace.enter(SOLIS)
    remotePlace.command({ kind: 'device' })
    remotePlace.command({ kind: 'workspace' })
    expect(sent.mock.calls).toEqual([[{ kind: 'device' }], [{ kind: 'workspace' }]])
    off()
  })
})

describe('drafts: words typed for another machine stay, whatever happens to it', () => {
  it('per machine and per agent', () => {
    setRemoteDraft(SOLIS.id, 't-1', 'half a thought')
    expect(remoteDraft(SOLIS.id, 't-1')).toBe('half a thought')
    expect(remoteDraft(SOLIS.id, 't-2')).toBe('')
    expect(remoteDraft('other', 't-1')).toBe('')
    setRemoteDraft(SOLIS.id, 't-1', '')
    expect(remoteDraft(SOLIS.id, 't-1')).toBe('')
  })
})
