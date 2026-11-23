// THIS COMPUTER AS A FILE SOURCE (main/file-server.ts): only the folders the
// owner shared, only paths that stay inside them, and a refusal that says which.
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FILE_MAX_BYTES, fileRoots, isRefusal, listFolder, readShared } from '../src/main/file-server'

const made: string[] = []
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function bed() {
  const base = mkdtempSync(path.join(tmpdir(), 'file-server-'))
  made.push(base)
  const sharedRoot = path.join(base, 'shared')
  const other = path.join(base, 'other')
  mkdirSync(path.join(sharedRoot, 'sub'), { recursive: true })
  mkdirSync(other)
  writeFileSync(path.join(sharedRoot, 'note.html'), '<h1>hi</h1>')
  writeFileSync(path.join(sharedRoot, 'sub', 'a.txt'), 'alpha')
  writeFileSync(path.join(other, 'secret.txt'), 'secret')
  symlinkSync(path.join(other, 'secret.txt'), path.join(sharedRoot, 'escape.txt'))
  return { base, sharedRoot, other }
}

describe('the roots a device sees', () => {
  it('are named by their own folder name', () => {
    expect(fileRoots(['/Users/x/Documents', '/Users/x/Media']).map((r) => r.name)).toEqual(['Documents', 'Media'])
  })
})

describe('a listing', () => {
  it('shows a folder’s entries, folders first by name, with types', () => {
    const { sharedRoot } = bed()
    const listing = listFolder([sharedRoot], sharedRoot, '')
    if (isRefusal(listing)) throw new Error(`refused: ${listing.why}`)
    const names = listing.entries.map((e) => e.name)
    expect(names).toContain('note.html')
    expect(names).toContain('sub')
    expect(listing.entries.find((e) => e.name === 'note.html')).toMatchObject({ kind: 'file', mime: 'text/html; charset=utf-8' })
    expect(listing.entries.find((e) => e.name === 'sub')?.kind).toBe('dir')
  })

  it('lists a link without following it', () => {
    const { sharedRoot } = bed()
    const listing = listFolder([sharedRoot], sharedRoot, '')
    if (isRefusal(listing)) throw new Error('refused')
    expect(listing.entries.find((e) => e.name === 'escape.txt')?.kind).toBe('file')
  })

  it('does not list dotfiles, which hold credentials more often than things to look at', () => {
    const { sharedRoot } = bed()
    writeFileSync(path.join(sharedRoot, '.env'), 'SECRET=1')
    const listing = listFolder([sharedRoot], sharedRoot, '')
    if (isRefusal(listing)) throw new Error('refused')
    expect(listing.entries.map((e) => e.name)).not.toContain('.env')
  })

  it('refuses a root the owner did not share', () => {
    const { sharedRoot, other } = bed()
    expect(listFolder([sharedRoot], other, '')).toMatchObject({ error: 'outside' })
  })

  it('refuses a path that leaves the root, before touching the disk', () => {
    const { sharedRoot } = bed()
    expect(listFolder([sharedRoot], sharedRoot, '../')).toMatchObject({ error: 'outside' })
    expect(listFolder([sharedRoot], sharedRoot, 'sub/../../')).toMatchObject({ error: 'outside' })
  })

  it('refuses a file asked for as a folder', () => {
    const { sharedRoot } = bed()
    expect(listFolder([sharedRoot], sharedRoot, 'note.html')).toMatchObject({ error: 'not-dir' })
  })
})

describe('a file', () => {
  it('is its bytes, its type and a hash', () => {
    const { sharedRoot } = bed()
    const read = readShared([sharedRoot], sharedRoot, 'sub/a.txt')
    if (isRefusal(read)) throw new Error(`refused: ${read.why}`)
    expect(read.bytes.toString()).toBe('alpha')
    expect(read.mime).toBe('text/plain; charset=utf-8')
    expect(read.hash).toMatch(/^[0-9a-f]{64}$/)
    expect(read.name).toBe('a.txt')
  })

  it('is refused when a link inside the root points outside it', () => {
    const { sharedRoot } = bed()
    expect(readShared([sharedRoot], sharedRoot, 'escape.txt')).toMatchObject({ error: 'outside' })
  })

  it('is refused when it is too large, without reading it', () => {
    const { sharedRoot } = bed()
    const read = readShared([sharedRoot], sharedRoot, 'note.html', { maxBytes: 4 })
    expect(read).toMatchObject({ error: 'too-large' })
  })

  it('says when it is gone, when it is a folder, and when the root is not shared', () => {
    const { sharedRoot, other } = bed()
    expect(readShared([sharedRoot], sharedRoot, 'nope.txt')).toMatchObject({ error: 'missing' })
    expect(readShared([sharedRoot], sharedRoot, 'sub')).toMatchObject({ error: 'not-file' })
    expect(readShared([sharedRoot], other, 'secret.txt')).toMatchObject({ error: 'outside' })
    expect(FILE_MAX_BYTES).toBeGreaterThan(1024 * 1024)
  })
})
