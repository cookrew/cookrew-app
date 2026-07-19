import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { TurnStore } from '../src/main/turn-store'
import type { TurnRecord } from '../src/shared/turn'

function freshStore(): { store: TurnStore; dir: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'cookrew-turns-'))
  return { store: new TurnStore(dir), dir }
}

const RECORDS: TurnRecord[] = [
  { index: 1, prompt: 'build it', reply: 'built', startedAt: 100, endedAt: 200 },
  { index: 2, prompt: 'test it', reply: 'tested', title: 'Running tests', startedAt: 300, endedAt: 400 }
]

describe('TurnStore', () => {
  it('round-trips records through save + load', () => {
    const { store } = freshStore()
    store.scheduleSave('term-a', RECORDS)
    store.flushAll()
    expect(store.load('term-a')).toEqual(RECORDS)
  })

  it('returns [] for terminals never saved', () => {
    const { store } = freshStore()
    expect(store.load('nope')).toEqual([])
  })

  it('drops malformed entries from hand-edited files', () => {
    const { store, dir } = freshStore()
    writeFileSync(
      path.join(dir, 'term-b.json'),
      JSON.stringify([RECORDS[0], { junk: true }, 'nope', RECORDS[1]]),
      'utf8'
    )
    expect(store.load('term-b')).toEqual(RECORDS)
  })

  it('survives a corrupt file', () => {
    const { store, dir } = freshStore()
    writeFileSync(path.join(dir, 'term-c.json'), '{not json', 'utf8')
    expect(store.load('term-c')).toEqual([])
  })

  it('remove deletes the file and cancels pending saves', () => {
    const { store, dir } = freshStore()
    store.scheduleSave('term-d', RECORDS)
    store.flushAll()
    expect(existsSync(path.join(dir, 'term-d.json'))).toBe(true)
    store.scheduleSave('term-d', [...RECORDS, RECORDS[0]])
    store.remove('term-d')
    store.flushAll()
    expect(existsSync(path.join(dir, 'term-d.json'))).toBe(false)
  })

  it('sanitizes terminal ids used as filenames', () => {
    const { store, dir } = freshStore()
    store.scheduleSave('../evil/../../id', RECORDS)
    store.flushAll()
    expect(readFileSync(path.join(dir, 'evilid.json'), 'utf8')).toContain('build it')
  })
})
