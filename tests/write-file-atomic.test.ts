// Sol r7 P1 — writeFileAtomic must not publish success it did not earn.
//
// Two ways the helper could lie: a short writeSync (Node does not guarantee
// the whole buffer lands in one call) fsync'd and renamed over the only copy,
// and a parent-directory fsync failure logged-but-swallowed while the rename
// is admittedly not yet durable. Both are injected here through a passthrough
// fs wrapper; the assertions are that the file is complete, the old bytes
// survive a failure, and the failure PROPAGATES so callers keep their dirty
// state and retry.

import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { AnnotationStore, writeFileAtomic } from '../src/main/turn-annotations'
import type { TurnRecord } from '../src/shared/turn'

const inject = vi.hoisted(() => ({
  /** >0: each writeSync consumes at most this many bytes (short writes). */
  writeCap: 0,
  /** true: writeSync reports 0 bytes written (a short write that never progresses). */
  writeZero: false,
  /** Set: fsync of a DIRECTORY fd throws this error. */
  dirFsyncError: null as NodeJS.ErrnoException | null,
  /** How many writeSync calls the current test drove. */
  writeCalls: 0,
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const dirFds = new Set<number>()
  return {
    ...actual,
    openSync: ((...args: unknown[]) => {
      const fd = (actual.openSync as (...a: unknown[]) => number)(...args)
      try {
        if (actual.fstatSync(fd).isDirectory()) dirFds.add(fd)
      } catch {
        // fstat failure: treat as a plain file fd
      }
      return fd
    }) as unknown as typeof actual.openSync,
    closeSync: ((fd: number) => {
      dirFds.delete(fd)
      return actual.closeSync(fd)
    }) as unknown as typeof actual.closeSync,
    writeSync: ((fd: number, buffer: Uint8Array, offset: number, length: number) => {
      inject.writeCalls += 1
      if (inject.writeZero) return 0
      const cap = inject.writeCap > 0 ? Math.min(length, inject.writeCap) : length
      return actual.writeSync(fd, buffer, offset, cap)
    }) as unknown as typeof actual.writeSync,
    fsyncSync: ((fd: number) => {
      if (inject.dirFsyncError !== null && dirFds.has(fd)) throw inject.dirFsyncError
      return actual.fsyncSync(fd)
    }) as unknown as typeof actual.fsyncSync,
  }
})

let dir: string

beforeEach(() => {
  inject.writeCap = 0
  inject.writeZero = false
  inject.dirFsyncError = null
  inject.writeCalls = 0
  dir = mkdtempSync(path.join(tmpdir(), 'cookrew-atomic-'))
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

const target = (): string => path.join(dir, 'target.json')

const eio = (): NodeJS.ErrnoException => {
  const error: NodeJS.ErrnoException = new Error('EIO: i/o error, fsync')
  error.code = 'EIO'
  return error
}

describe('writeFileAtomic — short writes', () => {
  it('loops writeSync until every byte lands', () => {
    inject.writeCap = 7
    const body = 'x'.repeat(1000)
    writeFileAtomic(target(), body)
    expect(readFileSync(target(), 'utf8')).toBe(body)
    // The cap forced the loop to actually iterate — this is not one lucky call.
    expect(inject.writeCalls).toBeGreaterThan(100)
  })

  it('a write that cannot progress THROWS, and the old file survives byte-identical', () => {
    writeFileSync(target(), 'the only durable copy', 'utf8')
    inject.writeZero = true
    expect(() => writeFileAtomic(target(), 'replacement')).toThrow(/short write/)
    expect(readFileSync(target(), 'utf8')).toBe('the only durable copy')
  })
})

describe('writeFileAtomic — mode preservation', () => {
  it('keeps a tightened mode on the replacement file', () => {
    writeFileSync(target(), 'secret', 'utf8')
    chmodSync(target(), 0o600)
    writeFileAtomic(target(), 'still secret')
    expect(statSync(target()).mode & 0o777).toBe(0o600)
    expect(readFileSync(target(), 'utf8')).toBe('still secret')
  })
})

describe('writeFileAtomic — directory-fsync failure is a FAILURE', () => {
  it('propagates a real dir-fsync error instead of claiming success', () => {
    inject.dirFsyncError = eio()
    expect(() => writeFileAtomic(target(), 'body')).toThrow(/EIO/)
  })

  it('tolerates codes that mean the filesystem cannot fsync directories', () => {
    const notsup: NodeJS.ErrnoException = new Error('ENOTSUP')
    notsup.code = 'ENOTSUP'
    inject.dirFsyncError = notsup
    expect(() => writeFileAtomic(target(), 'body')).not.toThrow()
    expect(readFileSync(target(), 'utf8')).toBe('body')
  })
})

describe('AnnotationStore under dir-fsync failure — retry state is retained', () => {
  const rec = (index: number, over: Partial<TurnRecord> = {}): TurnRecord => ({
    index,
    prompt: `ask ${index}`,
    reply: `reply ${index}`,
    startedAt: index * 10,
    endedAt: index * 10 + 5,
    ...over,
  })

  it('save reports failure, keeps the candidate readable, and the retry lands durably', () => {
    const annotations = new AnnotationStore(dir)
    inject.dirFsyncError = eio()
    expect(annotations.save('t1', [rec(1, { title: 'recap' })])).toBe(false)
    // Retained, not claimed: the read still sees the un-landed candidate.
    expect(annotations.load('t1').get(1)).toEqual({ title: 'recap' })

    inject.dirFsyncError = null
    expect(annotations.save('t1', [rec(1, { title: 'recap' })])).toBe(true)
    const parsed = JSON.parse(readFileSync(path.join(dir, 't1.json'), 'utf8')) as {
      annotations: Record<string, unknown>
    }
    expect(parsed.annotations).toEqual({ '1': { title: 'recap' } })
    expect(new AnnotationStore(dir).load('t1').get(1)).toEqual({ title: 'recap' })
  })
})
