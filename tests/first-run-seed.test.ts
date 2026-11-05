import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { seedConductor } from '../src/main/seed-conductor'
import { WorkspaceStore } from '../src/main/store'
import { openWorkspace } from '../src/main/workspace-door'
import type { FirstRunStage } from '../src/shared/first-run'

/**
 * THE CONDUCTOR NOBODY ASKED FOR (round 2, bug 14). Over a real store and the
 * real door, for every workspace and not only the first: a card whose tool is
 * not here reads "resting" and dies on its first key. Nobody asked for this card,
 * so it needs its tool SEEN: a dir this user may not read proves nothing.
 */

describe('seeding a Conductor', () => {
  const cleanup: Array<() => void> = []
  afterEach(() => {
    for (const run of cleanup.splice(0)) run()
  })

  const room = () => {
    const root = mkdtempSync(path.join(tmpdir(), 'cookrew-seed-'))
    cleanup.push(() => rmSync(root, { recursive: true, force: true }))
    const folder = (name: string): string => {
      const dir = path.join(root, name)
      mkdirSync(dir)
      return dir
    }
    const empty = folder('empty-bin')
    const store = new WorkspaceStore(path.join(root, 'data'), { multiInstance: true })
    return { root, folder, empty, store }
  }

  const claudeIn = (dir: string, mode = 0o755): string => {
    writeFileSync(path.join(dir, 'claude'), '#!/bin/sh\n')
    chmodSync(path.join(dir, 'claude'), mode)
    return dir
  }

  type Room = ReturnType<typeof room>
  const seedWith = ({ store }: Room, searchPath: string, stage: FirstRunStage = 'closed') => (workspaceId?: string) =>
    seedConductor({ store, stage: () => stage, searchPath: () => searchPath }, workspaceId ?? store.focusedId)
  const terminals = ({ store }: Room, id: string) => store.workspaceState(id).nodes.filter((node) => node.kind === 'terminal')
  const open = (r: Room, name: string, seed: (id: string) => void) => openWorkspace(r.store, { name, dir: r.folder(name), stay: false, seed })

  it('leaves every new workspace empty while its tool is missing, the second and third too', () => {
    const r = room()
    const seed = seedWith(r, r.empty)
    expect(terminals(r, open(r, 'one', seed).id)).toEqual([])
    expect(terminals(r, open(r, 'two', seed).id)).toEqual([])
    expect(terminals(r, open(r, 'three', seed).id)).toEqual([])
  })

  it('leaves the boot workspace empty too', () => {
    const r = room()
    seedWith(r, r.empty)()
    expect(terminals(r, r.store.focusedId)).toEqual([])
  })

  it('gives each workspace its Conductor when the tool is here, past the first run', () => {
    const r = room()
    const seed = seedWith(r, claudeIn(r.folder('bin')))
    const meta = open(r, 'one', seed)
    expect(terminals(r, meta.id)).toMatchObject([{ name: 'Conductor', orch: true, command: 'claude --permission-mode bypassPermissions', cwd: meta.dir }])
    expect(terminals(r, open(r, 'two', seed).id)).toHaveLength(1)
  })

  it('finds the tool in a later dir of the path', () => {
    const r = room()
    const seed = seedWith(r, `${r.empty}:${claudeIn(r.folder('bin'))}`)
    expect(terminals(r, open(r, 'one', seed).id)).toHaveLength(1)
  })

  it('waits for the first run, tool or no tool', () => {
    const r = room()
    const bin = claudeIn(r.folder('bin'))
    expect(terminals(r, open(r, 'one', seedWith(r, bin, 'preflight')).id)).toEqual([])
    expect(terminals(r, open(r, 'two', seedWith(r, bin, 'task')).id)).toEqual([])
  })

  // The second Linux user's case: another person's home sits on an inherited PATH.
  it('does not take a dir it may not read as proof of the tool', () => {
    const r = room()
    const locked = r.folder('someone-elses-home')
    const bin = path.join(locked, 'bin')
    mkdirSync(bin)
    claudeIn(bin)
    chmodSync(locked, 0o000)
    cleanup.unshift(() => chmodSync(locked, 0o755))
    expect(terminals(r, open(r, 'one', seedWith(r, bin)).id)).toEqual([])
  })

  it('does not take a file it cannot run for the tool', () => {
    const r = room()
    const seed = seedWith(r, claudeIn(r.folder('bin'), 0o644))
    expect(terminals(r, open(r, 'one', seed).id)).toEqual([])
  })

  it('seeds nothing into a folder that has gone', () => {
    const r = room()
    const bin = claudeIn(r.folder('bin'))
    const meta = openWorkspace(r.store, { name: 'gone', dir: r.folder('gone'), stay: false, seed: () => undefined })
    rmSync(meta.dir, { recursive: true })
    seedWith(r, bin)(meta.id)
    expect(terminals(r, meta.id)).toEqual([])
  })

  it('never adds a second one', () => {
    const r = room()
    const seed = seedWith(r, claudeIn(r.folder('bin')))
    const meta = open(r, 'one', seed)
    seed(meta.id)
    expect(terminals(r, meta.id)).toHaveLength(1)
  })
})
